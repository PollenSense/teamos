import { PersonDataReport, parseId, redactText, redactValue } from '../board/index.mjs';
import { ImportError } from './reference.mjs';

/**
 * What ties an issue to other things, for the Linear import (ticket A6): relations (blocks, blocked by, related, duplicate
 * of), pull requests, other links, and the comments of an issue. One pure step like A5's:
 *
 *   planLinks(entities, issuesPlan, reference)   what each issue file and thread file should say, plus counts
 *   withLinks(issuesPlan, linksPlan)             the issue plan with those fields added, ready for `applyIssues`
 *
 * Keys are resolved through the plan: an issue's real key first, then an earlier key it kept as an alias, so a relation
 * or comment that names `INS-5` finds the card that moved to `PSE-2`. A key nobody holds is counted as dangling and left out.
 *
 * Rule A (as in A4 and A5): titles, urls, comment texts and author names are typed text. An outside e-mail address or phone
 * number is redacted in the synced file; when something was changed the original goes to the local-only raw record
 * (`raw/links/<KEY>.json`, `raw/comments/<id>.json`), written first by `applyIssues`. A comment text never goes into the
 * issue file; it lives in the thread file only.
 *
 * Nothing here has a time of its own and every list is sorted, so a second run writes the same bytes. Counts name no
 * title, text, name or address.
 */

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PLAIN_TOKEN = /^[A-Za-z0-9 _.-]{1,40}$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,8})(?:[/?#].*)?$/;
const MAX_AUTHOR = 80;

/** Issue keys in the order a person reads them: team, then number (`PSE-9` before `PSE-10`). */
export function cmpKeys(a, b) {
	const x = parseId(a);
	const y = parseId(b);
	if (!x || !y) return cmp(String(a), String(b));
	return cmp(x.team, y.team) || x.number - y.number;
}

const sorted = (set) => [...set].sort(cmpKeys);

/** `counts[key]++` for a key that comes from the data: a key such as `__proto__` is an ordinary entry, never the prototype. */
function bump(counts, key) {
	Object.defineProperty(counts, key, { value: (Object.hasOwn(counts, key) ? counts[key] : 0) + 1, enumerable: true, writable: true, configurable: true });
}

/** The state of a pull request from a Linear attachment's metadata: what its status says, else its dates; one of open, closed, merged. */
export function prState(metadata) {
	const m = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
	const status = typeof m.status === 'string' ? m.status.toLowerCase() : '';
	if (status === 'merged' || status === 'closed') return status;
	if (status === 'open' || status === 'draft' || status === 'inreview') return 'open';
	if (typeof m.mergedAt === 'string' && m.mergedAt !== '') return 'merged';
	if (typeof m.closedAt === 'string' && m.closedAt !== '') return 'closed';
	return 'open';
}

/** One line of text for a header: control characters and line ends become spaces, runs of spaces one, at most 80 characters. */
function oneLine(text) {
	let out = '';
	for (const ch of String(text)) {
		const n = ch.codePointAt(0);
		out += n < 0x20 || n === 0x7f || n === 0x85 || n === 0x2028 || n === 0x2029 ? ' ' : ch;
	}
	return [...out.split(' ').filter(Boolean).join(' ')].slice(0, MAX_AUTHOR).join('').trim();
}

/** A link a person can open: http or https, no user name or password in it. Anything else is not kept (a `javascript:` link would run when shown). */
function openableUrl(text) {
	if (typeof text !== 'string') return null;
	const trimmed = text.trim();
	try {
		const url = new URL(trimmed);
		if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') return null;
		return trimmed;
	} catch {
		return null;
	}
}

/**
 * @param {Record<string, object[]>} entities  what `readExport` returned (`relations`, `attachments`, `comments` are used)
 * @param {{issues: {fields: object}[], report?: PersonDataReport}} issuesPlan  the result of `planIssues` for the same export
 * @param {{people: {people: object}}} reference  the result of `planReference` for the same export
 * @param {{report?: PersonDataReport}} [options]  a report to add comment and link texts to (the issue plan's, so one report covers the run)
 * @returns {{fields: Map<string, object>, threads: {id: string, entries: object[]}[], raw: object[], counts: object, report: PersonDataReport}}
 *          `fields` = per issue ID the `relations`, `prs` and `links` it should carry (only the ones it has)
 */
export function planLinks(entities, issuesPlan, reference, { report = new PersonDataReport() } = {}) {
	if (!issuesPlan || !Array.isArray(issuesPlan.issues)) throw new ImportError('no-issues-plan', 'the link plan needs the issue plan of the same export');
	if (!reference || typeof reference.people?.people !== 'object' || reference.people.people === null) throw new ImportError('no-reference', 'the link plan needs the reference plan of the same export');
	const get = (type) => entities[type] ?? [];
	const people = reference.people.people;
	const counts = {
		relations: { read: 0, written: { blocks: 0, duplicate: 0, related: 0 }, unknownType: 0, selfRelations: 0, repeated: 0, duplicateExtra: 0 },
		prs: { read: 0, written: 0, byState: { open: 0, closed: 0, merged: 0 }, repeated: 0, flagged: 0 },
		links: { read: 0, written: 0, bySource: {}, refused: 0, repeated: 0, flagged: 0 },
		comments: {
			read: 0, onIssues: 0, written: 0, replies: 0, flagged: 0, refused: 0,
			byAuthor: { person: 0, bot: 0, external: 0, unknown: 0 },
			leftForLater: { projects: 0, documents: 0, projectUpdates: 0 },
		},
		dangling: {},
	};
	const dangle = (what) => {
		counts.dangling[what] = (counts.dangling[what] ?? 0) + 1;
	};

	// Real keys first, then the earlier keys the plan kept (A5 already dropped an alias that is another issue's real key).
	const idOfKey = new Map();
	for (const issue of issuesPlan.issues) idOfKey.set(issue.fields.id, issue.fields.id);
	for (const issue of issuesPlan.issues) for (const alias of issue.fields.aliases ?? []) if (!idOfKey.has(alias)) idOfKey.set(alias, issue.fields.id);
	const resolve = (key) => (typeof key === 'string' && idOfKey.has(key) ? idOfKey.get(key) : undefined);

	const slot = new Map();
	const of = (id) => {
		if (!slot.has(id)) slot.set(id, { blocks: new Set(), blockedBy: new Set(), related: new Set(), duplicateOf: new Set(), prs: new Map(), links: new Map(), rawLinks: [] });
		return slot.get(id);
	};
	const raw = [];

	// --- relations ---
	for (const relation of [...get('relations')].sort((a, b) => cmp(a.id, b.id))) {
		counts.relations.read++;
		if (relation.type !== 'blocks' && relation.type !== 'duplicate' && relation.type !== 'related') {
			counts.relations.unknownType++;
			continue;
		}
		const from = resolve(relation.issueKey);
		const to = resolve(relation.relatedIssueKey);
		if (from === undefined || to === undefined) {
			dangle('relations.issue');
			continue;
		}
		if (from === to) {
			counts.relations.selfRelations++;
			continue;
		}
		const a = of(from);
		const b = of(to);
		const present = relation.type === 'blocks' ? a.blocks.has(to) : relation.type === 'duplicate' ? a.duplicateOf.has(to) : a.related.has(to);
		if (present) {
			counts.relations.repeated++;
			continue;
		}
		counts.relations.written[relation.type]++;
		if (relation.type === 'blocks') {
			a.blocks.add(to);
			b.blockedBy.add(from);
		} else if (relation.type === 'duplicate') {
			a.duplicateOf.add(to);
		} else {
			a.related.add(to);
			b.related.add(from);
		}
	}
	// `duplicateOf` is one key; a second one (Linear allows it) is kept as a related issue on both sides, never dropped.
	for (const [id, s] of slot) {
		if (s.duplicateOf.size > 1) {
			const [first, ...extra] = sorted(s.duplicateOf);
			s.duplicateOf = new Set([first]);
			for (const other of extra) {
				counts.relations.duplicateExtra++;
				s.related.add(other);
				of(other).related.add(id);
			}
		}
	}

	// --- attachments: pull requests and other links ---
	for (const attachment of [...get('attachments')].sort((a, b) => cmp(a.id, b.id))) {
		const id = resolve(attachment.issueKey);
		const isPrSource = typeof attachment.sourceType === 'string' && attachment.sourceType.toLowerCase() === 'github';
		const pr = isPrSource && typeof attachment.url === 'string' ? PR_URL.exec(attachment.url.trim()) : null;
		if (pr) counts.prs.read++;
		else counts.links.read++;
		if (id === undefined) {
			dangle('attachments.issue');
			continue;
		}
		const s = of(id);
		const team = parseId(id).team;
		if (pr) {
			const entry = { url: `https://github.com/${pr[1]}/${pr[2]}/pull/${pr[3]}`, repo: pr[2], number: Number(pr[3]), state: prState(attachment.metadata) };
			if (redactValue(entry).flagged) {
				counts.prs.flagged++;
				continue;
			}
			if (s.prs.has(entry.url)) {
				counts.prs.repeated++;
				continue;
			}
			s.prs.set(entry.url, entry);
			counts.prs.written++;
			counts.prs.byState[entry.state]++;
			continue;
		}
		const url = openableUrl(attachment.url);
		if (url === null) {
			counts.links.refused++;
			continue;
		}
		const urlRed = redactValue(url);
		const titleRed = redactValue(typeof attachment.title === 'string' ? attachment.title : '');
		if (typeof attachment.title === 'string') report.add(team, 'links', attachment.title);
		report.add(team, 'link-urls', url);
		const source = typeof attachment.sourceType === 'string' && PLAIN_TOKEN.test(attachment.sourceType) ? attachment.sourceType : '(other)';
		const sourceRed = redactValue(source);
		// The original of a flagged link goes to the raw record BEFORE the repeat check: two different originals can read the
		// same once redacted, and the one dropped as a repeat would otherwise leave no original anywhere.
		if (urlRed.flagged || titleRed.flagged || sourceRed.flagged) {
			counts.links.flagged++;
			const original = { url, title: typeof attachment.title === 'string' ? attachment.title : null, sourceType: attachment.sourceType ?? null };
			if (!s.rawLinks.some((r) => r.url === original.url && r.title === original.title && r.sourceType === original.sourceType)) s.rawLinks.push(original);
		}
		if (s.links.has(urlRed.value)) {
			counts.links.repeated++;
			continue;
		}
		const entry = { url: urlRed.value, ...(titleRed.value === '' ? {} : { title: titleRed.value }), sourceType: sourceRed.value };
		s.links.set(entry.url, entry);
		counts.links.written++;
		bump(counts.links.bySource, sourceRed.value);
	}

	// --- comments on issues ---
	const entriesOf = new Map();
	for (const comment of [...get('comments')].sort((a, b) => cmp(a.id, b.id))) {
		counts.comments.read++;
		if (comment.issueKey === undefined || comment.issueKey === null) {
			if (comment.projectUpdateId) counts.comments.leftForLater.projectUpdates++;
			else if (comment.documentId) counts.comments.leftForLater.documents++;
			else if (comment.projectId) counts.comments.leftForLater.projects++;
			else dangle('comments.target');
			continue;
		}
		const id = resolve(comment.issueKey);
		if (id === undefined) {
			dangle('comments.issue');
			continue;
		}
		if (typeof comment.id !== 'string' || !NAME.test(comment.id)) {
			counts.comments.refused++;
			continue;
		}
		counts.comments.onIssues++;
		const team = parseId(id).team;
		const bodyRed = redactValue(comment.body);
		report.add(team, 'comments', comment.body);

		// Who wrote it: the people map first; a bot or an outside user by the name the export gives.
		let author;
		let authorOriginal; // the full name as the export gives it (`author` is one line of at most 80 characters)
		let kind = 'unknown';
		let authorFlagged = false;
		const person = comment.authorId !== undefined && comment.authorId !== null && Object.hasOwn(people, comment.authorId) ? people[comment.authorId] : undefined;
		if (typeof person?.name === 'string' && oneLine(person.name) !== '') {
			author = oneLine(person.name);
			authorOriginal = person.name;
			kind = 'person';
		} else {
			if (comment.authorId !== undefined && comment.authorId !== null) dangle('comments.author');
			for (const [field, label, type] of [['botName', 'bot', 'bot'], ['externalUserName', 'external', 'external']]) {
				if (author === undefined && typeof comment[field] === 'string' && oneLine(comment[field]) !== '') {
					author = `${label}:${oneLine(comment[field])}`;
					authorOriginal = `${label}:${comment[field]}`;
					kind = type;
				}
			}
		}
		if (author === undefined) author = 'unknown';
		const authorRed = redactText(author);
		if (authorRed.flagged) authorFlagged = true;
		if (kind === 'bot' || kind === 'external') report.add(team, 'comment-authors', author);
		counts.comments.byAuthor[kind]++;
		if (bodyRed.flagged || authorFlagged) {
			counts.comments.flagged++;
			raw.push({ type: 'comments', id: comment.id, record: { issue: comment.issueKey, author: authorOriginal ?? author, body: comment.body } });
		}
		const entry = { time: comment.createdAt, author: authorRed.text, id: comment.id, source: 'linear', body: bodyRed.value, parent: comment.parentId };
		if (!entriesOf.has(id)) entriesOf.set(id, []);
		entriesOf.get(id).push(entry);
	}
	// A reply names the comment it answers, if that comment is on the same issue.
	const threads = [];
	for (const issue of issuesPlan.issues) {
		const list = entriesOf.get(issue.fields.id);
		if (!list) continue;
		const here = new Set(list.map((e) => e.id));
		const entries = list
			.map((e) => {
				const { parent, ...entry } = e;
				if (parent !== undefined && parent !== null) {
					if (parent !== e.id && here.has(parent)) {
						entry.replyTo = parent;
						counts.comments.replies++;
					} else dangle('comments.parent');
				}
				return entry;
			})
			.sort((a, b) => (Date.parse(a.time) - Date.parse(b.time)) || cmp(a.time, b.time) || cmp(a.id, b.id));
		counts.comments.written += entries.length;
		threads.push({ id: issue.fields.id, entries });
	}

	// --- the fields, in the order of the issue plan ---
	const fields = new Map();
	for (const issue of issuesPlan.issues) {
		const s = slot.get(issue.fields.id);
		if (!s) continue;
		const out = {};
		const relations = {};
		if (s.blocks.size > 0) relations.blocks = sorted(s.blocks);
		if (s.blockedBy.size > 0) relations.blockedBy = sorted(s.blockedBy);
		if (s.related.size > 0) relations.related = sorted(s.related);
		if (s.duplicateOf.size > 0) relations.duplicateOf = [...s.duplicateOf][0];
		if (Object.keys(relations).length > 0) out.relations = relations;
		if (s.prs.size > 0) out.prs = [...s.prs.values()].sort((a, b) => cmp(a.repo, b.repo) || a.number - b.number || cmp(a.url, b.url));
		if (s.links.size > 0) out.links = [...s.links.values()].sort((a, b) => cmp(a.url, b.url) || cmp(a.title ?? '', b.title ?? ''));
		if (s.rawLinks.length > 0) raw.push({ type: 'links', id: issue.fields.id, record: { links: s.rawLinks.sort((a, b) => cmp(a.url, b.url)) } });
		if (Object.keys(out).length > 0) fields.set(issue.fields.id, out);
	}
	return { fields, threads, raw, counts, report };
}

/** The issue plan with the link plan's fields on each issue, its raw records after the issues', and `threads` and `counts.links` added. The inputs are not changed. */
export function withLinks(issuesPlan, linksPlan) {
	return {
		...issuesPlan,
		issues: issuesPlan.issues.map((issue) => {
			const extra = linksPlan.fields.get(issue.fields.id);
			return extra ? { ...issue, fields: { ...issue.fields, ...extra } } : issue;
		}),
		raw: [...issuesPlan.raw, ...linksPlan.raw],
		threads: linksPlan.threads,
		counts: { ...issuesPlan.counts, links: linksPlan.counts },
	};
}
