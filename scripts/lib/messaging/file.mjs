import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathExists } from '../util.mjs';
import { applyAttachmentsToBody, isAttachmentName, prepareAttachments, removeAttachments, writeAttachments } from './attachments.mjs';
import { inboxStatePath, readInboxState, updateInboxState } from './inbox-state.mjs';
import { classifyInbox, countNeeds, readMarks, repliedIds, textMatches, validateMarks } from './inbox-rules.mjs';
import { QuestionIndex } from './question-index.mjs';
import { checkEntry, countQuestions, ensureQuestionsInBody, parseAnswers, readAnswers, readQuestions, validateQuestions, waitingCounts } from './questions.mjs';

/**
 * File-based messaging adapter.
 *
 * Implements the email-like protocol described in teamos/docs/messages.md:
 *   - Master store at team/messages/<id>.md (one file per message)
 *   - Per-member mailboxes as JSON id lists:
 *       team/members/<name>/inbox.json
 *       team/members/<name>/sent.json
 *       team/members/<name>/archives.json
 */

function makeMessageId() {
	const iso = new Date().toISOString().replace(/:/g, '-'); // 2026-04-13T10-30-45.123Z
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
	return `${iso}-${rand}`;
}

/** Frontmatter fields whose value is one line of JSON (lists of objects); every other field keeps the old parsing. */
const JSON_FIELDS = new Set(['questions', 'answers']);

function parseFrontmatterValue(raw, key) {
	const trimmed = raw.trim();
	if (JSON_FIELDS.has(key) && trimmed.startsWith('[') && trimmed.endsWith(']')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed;
		}
	}
	if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
		const inner = trimmed.slice(1, -1).trim();
		if (!inner) return [];
		return inner
			.split(',')
			.map((s) => s.trim().replace(/^["']|["']$/g, ''))
			.filter(Boolean);
	}
	return trimmed;
}

function parseFrontmatter(content) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { metadata: {}, body: content.trim() };

	const metadata = {};
	for (const line of match[1].split('\n')) {
		const colonIdx = line.indexOf(':');
		if (colonIdx <= 0) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1);
		metadata[key] = parseFrontmatterValue(value, key);
	}
	return { metadata, body: match[2].trim() };
}

function serializeMessage(msg) {
	const lines = ['---'];
	lines.push(`id: ${msg.id}`);
	lines.push(`from: ${msg.from}`);
	lines.push(`to: [${(msg.to ?? []).join(', ')}]`);
	if (msg.cc?.length) lines.push(`cc: [${msg.cc.join(', ')}]`);
	lines.push(`subject: ${msg.subject ?? ''}`);
	lines.push(`sentAt: ${msg.sentAt}`);
	if (msg.replyTo) lines.push(`replyTo: ${msg.replyTo}`);
	if (msg.supersedes?.length) lines.push(`supersedes: [${msg.supersedes.join(', ')}]`);
	if (msg.supersededBy) lines.push(`supersededBy: ${msg.supersededBy}`);
	if (msg.projectCode) lines.push(`projectCode: ${msg.projectCode}`);
	if (msg.fyi) lines.push('fyi: true');
	if (msg.expectsReply) lines.push('expectsReply: true');
	if (msg.attachments?.length) lines.push(`attachments: [${msg.attachments.join(', ')}]`);
	if (msg.questions?.length) lines.push(`questions: ${JSON.stringify(msg.questions)}`);
	if (msg.answers?.length) lines.push(`answers: ${JSON.stringify(msg.answers)}`);
	lines.push('---', '', (msg.body ?? '').trimEnd(), '');
	return lines.join('\n');
}

function normalizeMessage(metadata, body) {
	const supersedes = Array.isArray(metadata.supersedes)
		? metadata.supersedes
		: metadata.supersedes
			? [metadata.supersedes]
			: [];
	return {
		id: typeof metadata.id === 'string' ? metadata.id : '',
		from: typeof metadata.from === 'string' ? metadata.from : 'unknown',
		to: Array.isArray(metadata.to) ? metadata.to : metadata.to ? [metadata.to] : [],
		cc: Array.isArray(metadata.cc) ? metadata.cc : metadata.cc ? [metadata.cc] : [],
		subject: typeof metadata.subject === 'string' ? metadata.subject : '',
		sentAt: typeof metadata.sentAt === 'string' ? metadata.sentAt : '',
		replyTo: typeof metadata.replyTo === 'string' && metadata.replyTo ? metadata.replyTo : undefined,
		supersedes,
		supersededBy:
			typeof metadata.supersededBy === 'string' && metadata.supersededBy ? metadata.supersededBy : undefined,
		projectCode: typeof metadata.projectCode === 'string' && metadata.projectCode ? metadata.projectCode : undefined,
		attachments: (Array.isArray(metadata.attachments) ? metadata.attachments : []).filter(isAttachmentName),
		...readMarks(metadata),
		...nonEmpty('questions', readQuestions(metadata.questions)),
		...nonEmpty('answers', readAnswers(metadata.answers)),
		body,
	};
}

/** `{ [key]: list }` when the list has anything in it; otherwise nothing (so plain messages carry no extra keys). */
function nonEmpty(key, list) {
	return list.length > 0 ? { [key]: list } : {};
}

function stripReplyPrefix(subject) {
	return (subject ?? '').replace(/^(re:\s*)+/i, '').trim();
}

function recipientsOf(msg) {
	return [...(msg.to ?? []), ...(msg.cc ?? [])];
}

export class FileMessagingAdapter {
	constructor(teamDir) {
		this.teamDir = teamDir;
		this.messagesDir = join(teamDir, 'messages');
		this._questions = new QuestionIndex(
			this.messagesDir,
			(head) => {
				const { metadata } = parseFrontmatter(head);
				return normalizeMessage(metadata, '');
			},
			{ cachePath: join(teamDir, '.logs', 'questions-index.json') },
		);
	}

	// ─── Paths ─────────────────────────────────────────────────────────────────

	_messagePath(id) {
		return join(this.messagesDir, `${id}.md`);
	}

	_mailboxPath(member, kind) {
		return join(this.teamDir, 'members', member, `${kind}.json`);
	}

	// ─── Roster validation ─────────────────────────────────────────────────────
	//
	// Message-party names (from, to, cc) must match members.json exactly. On
	// case-insensitive filesystems (macOS/Windows) a misspelled case writes to
	// the same directory; on case-sensitive filesystems (Linux) it creates a
	// phantom sibling directory — and the two diverge the moment you sync a
	// repo between the two. Validating here catches drift at the source.

	async _loadRosterNames() {
		const path = join(this.teamDir, 'members.json');
		try {
			const raw = await readFile(path, 'utf-8');
			const data = JSON.parse(raw);
			if (!Array.isArray(data.members)) return null;
			return data.members.map((m) => m?.name).filter((n) => typeof n === 'string' && n.length > 0);
		} catch {
			return null;
		}
	}

	/** `(name) => boolean` for "is this member a person"; with no roster everyone counts. */
	async _isHuman() {
		try {
			const data = JSON.parse(await readFile(join(this.teamDir, 'members.json'), 'utf-8'));
			const types = new Map((data.members ?? []).map((m) => [m?.name, m?.type]));
			if (![...types.values()].some(Boolean)) return undefined;
			return (name) => types.get(name) === 'human';
		} catch {
			return undefined;
		}
	}

	async _questionSnapshot() {
		return this._questions.snapshot({ isHuman: await this._isHuman() });
	}

	/**
	 * What the thread says about each question of `ask`: the answers from the replies in the store. Used when
	 * an answer is sent (to refuse a bad one with the reason) and when a message is read with its state.
	 */
	async _foldAsk(ask) {
		const { folded } = await this._questionSnapshot();
		return folded.get(ask.id);
	}

	/** Check a reply's `answers` against the ask it replies to; throws with the reason (status 400). */
	async _checkAnswers(answers, { from, replyTo }) {
		const bad = (message) => Object.assign(new Error(message), { status: 400 });
		if (!replyTo) throw bad('answers need replyTo: the message that asked the question');
		const seen = new Set();
		for (const entry of answers) {
			if (entry.ask !== replyTo) throw bad(`answers must reply to the message that asked: ask ${entry.ask} is not replyTo ${replyTo}`);
			if (seen.has(entry.q)) throw bad(`answer ${entry.q} once per message`);
			seen.add(entry.q);
		}
		const ask = await this._readRawMessage(replyTo).catch(() => null);
		if (!ask) throw bad(`answers: message ${replyTo} not found`);
		if (!ask.questions?.length) throw bad(`answers: ${replyTo} asked no questions`);
		if (ask.supersededBy) throw bad(`answers: ${replyTo} was replaced by ${ask.supersededBy}; answer that one`);
		const { folded, ctx } = await this._questionSnapshot();
		const current = folded.get(ask.id);
		if (!current) throw bad(`answers: ${replyTo} asked no questions`);
		for (const entry of answers) {
			const state = current.questions.find((q) => q.id === entry.q);
			if (!state) throw bad(`answers: ${replyTo} has no question ${entry.q}`);
			const verdict = checkEntry(entry, { ask, sender: from, state, ctx });
			if (!verdict.ok) throw bad(`answers: ${verdict.reason}`);
		}
	}

	_assertInRoster(role, name, roster) {
		if (roster.includes(name)) return;
		const lower = name.toLowerCase();
		const caseMatch = roster.find((n) => n.toLowerCase() === lower);
		if (caseMatch) {
			throw new Error(
				`${role}: "${name}" does not match roster case — members.json declares "${caseMatch}". Use the canonical name to avoid phantom directories on case-sensitive filesystems.`,
			);
		}
		throw new Error(`${role}: "${name}" is not in members.json (known: ${roster.join(', ')}).`);
	}

	async _validateParties(op, from, to, cc) {
		const roster = await this._loadRosterNames();
		if (!roster) return; // No roster file → skip (e.g. test harness)
		this._assertInRoster(`${op}.from`, from, roster);
		for (const r of to) this._assertInRoster(`${op}.to`, r, roster);
		for (const r of cc ?? []) this._assertInRoster(`${op}.cc`, r, roster);
	}

	// ─── Mailbox helpers ───────────────────────────────────────────────────────

	async _readMailbox(member, kind) {
		const path = this._mailboxPath(member, kind);
		try {
			const raw = await readFile(path, 'utf-8');
			const data = JSON.parse(raw);
			return Array.isArray(data.items) ? data.items : [];
		} catch {
			return [];
		}
	}

	_readMailboxSync(member, kind) {
		try {
			const data = JSON.parse(readFileSync(this._mailboxPath(member, kind), 'utf-8'));
			return Array.isArray(data.items) ? data.items : [];
		} catch {
			return [];
		}
	}

	/**
	 * Replace a mailbox through a temp file and a rename, so a reader never
	 * sees it half-written. A truncated read parses as an empty mailbox: the
	 * dashboard showed that member's inbox as all handled for one refresh, and
	 * a read-modify-write that caught it wrote the empty list back for good.
	 */
	_writeMailboxSync(member, kind, items) {
		const path = this._mailboxPath(member, kind);
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ items }, null, '\t')}\n`, 'utf-8');
		renameSync(tmp, path);
	}

	/**
	 * Read-modify-write a member's mailboxes as one step.
	 *
	 * A mailbox is a JSON list rewritten whole, and every change to one is a
	 * read-modify-write: a delivery appends, archive and unarchive move an id
	 * between two lists. Done with awaits between the read and the write, two
	 * of them interleave and the second writes back what the first removed —
	 * archive two messages at once from the dashboard and one of them lands
	 * back in the inbox, dropped from archives. Here the reads, the change and
	 * the writes run synchronously, so nothing in this process can interleave,
	 * and the window against another process (a member's MCP server delivering
	 * mail) is the few microseconds between a read and a rename. Closing that
	 * too would mean a lock file, which this codebase deliberately does not
	 * have.
	 *
	 * `change` gets the lists by kind and mutates them in place, returning the
	 * kinds it changed; only those are written.
	 */
	_updateMailboxes(member, kinds, change) {
		mkdirSync(dirname(this._mailboxPath(member, kinds[0])), { recursive: true });
		const boxes = Object.fromEntries(kinds.map((kind) => [kind, this._readMailboxSync(member, kind)]));
		const changed = change(boxes);
		for (const kind of changed) this._writeMailboxSync(member, kind, boxes[kind]);
		return changed.length > 0;
	}

	/** Append one id to a mailbox; a no-op when it is already there. */
	async _appendToMailbox(member, kind, id) {
		this._updateMailboxes(member, [kind], (boxes) => {
			if (boxes[kind].includes(id)) return [];
			boxes[kind].push(id);
			return [kind];
		});
	}

	async _removeFromMailbox(member, kind, id) {
		return this._updateMailboxes(member, [kind], (boxes) => {
			const idx = boxes[kind].indexOf(id);
			if (idx === -1) return [];
			boxes[kind].splice(idx, 1);
			return [kind];
		});
	}

	/** Move an id from one mailbox to another. `missing` runs when it is in neither. */
	_moveBetweenMailboxes(member, from, to, id, missing) {
		this._updateMailboxes(member, [from, to], (boxes) => {
			const idx = boxes[from].indexOf(id);
			if (idx === -1) {
				if (boxes[to].includes(id)) return []; // already moved, no-op
				missing();
				return [];
			}
			boxes[from].splice(idx, 1);
			if (!boxes[to].includes(id)) boxes[to].push(id);
			return [from, to];
		});
	}

	// ─── Core operations ───────────────────────────────────────────────────────

	async hasMessages(member) {
		const summaries = await this.listInbox(member);
		return summaries.length > 0;
	}

	async sendMessage({ from, to, cc, subject, body, replyTo, projectCode, attachments, questions, answers, fyi, expectsReply }) {
		if (!from) throw new Error('sendMessage: from is required');
		if (!Array.isArray(to) || to.length === 0) throw new Error('sendMessage: to is required');
		if (body == null) throw new Error('sendMessage: body is required');

		await this._validateParties('sendMessage', from, to, cc);

		let derivedSubject = subject;
		if ((!derivedSubject || !derivedSubject.trim()) && replyTo) {
			const parent = await this._readRawMessage(replyTo).catch(() => null);
			if (parent) {
				derivedSubject = `Re: ${stripReplyPrefix(parent.subject)}`;
			}
		}
		if (!derivedSubject || !derivedSubject.trim()) {
			throw new Error('sendMessage: subject is required on new threads');
		}

		// Images are checked and read before anything is written, so a bad one
		// leaves no half-sent message behind.
		const prepared = await prepareAttachments(attachments);
		const checkedQuestions = validateQuestions(questions, { to, cc: cc ?? [], from });
		const checkedAnswers = parseAnswers(answers);
		if (checkedAnswers) await this._checkAnswers(checkedAnswers, { from, replyTo });
		const marks = validateMarks({ fyi, expectsReply });

		const id = makeMessageId();
		const sentAt = new Date().toISOString();

		let finalBody = attachments == null ? body : applyAttachmentsToBody(body, id, prepared);
		let questionsAppended = false;
		if (checkedQuestions) ({ body: finalBody, appended: questionsAppended } = ensureQuestionsInBody(finalBody, checkedQuestions));

		await mkdir(this.messagesDir, { recursive: true });
		const content = serializeMessage({
			id,
			from,
			to,
			cc,
			subject: derivedSubject,
			sentAt,
			replyTo,
			projectCode,
			...marks,
			attachments: prepared.map((a) => a.name),
			questions: checkedQuestions,
			answers: checkedAnswers,
			body: finalBody,
		});
		await this._writeNewMessage(id, content, prepared);

		const recipients = [...to, ...(cc ?? [])];
		for (const recipient of recipients) {
			await this._appendToMailbox(recipient, 'inbox', id);
		}
		await this._appendToMailbox(from, 'sent', id);

		return { id, sentAt, ...(questionsAppended ? { questionsAppended: true } : {}) };
	}

	/**
	 * Send a new message that consolidates / replaces one or more earlier
	 * messages from the same sender. The new message gets `supersedes: [...]`
	 * pointing back at its predecessors; each predecessor is rewritten with
	 * `supersededBy: <newId>` so reverse-traversal is O(1). For every
	 * recipient in the union of the predecessors' to+cc:
	 *   - if the predecessor is still in their inbox, we remove it so they
	 *     only see the consolidated version on next read
	 *   - if they have already archived (or otherwise dropped) the
	 *     predecessor, we leave their archive alone — list_inbox/list_archives
	 *     will mark the lingering copy with supersededBy so the agent knows
	 *
	 * The new message is delivered to its `to`/`cc` recipients using the same
	 * inbox-append rules as `sendMessage`.
	 *
	 * `to` (plus optional `cc`) on the new message must cover every recipient
	 * the predecessors reached — otherwise dropped recipients would be left
	 * with neither the predecessor (if removed from inbox) nor a replacement.
	 */
	async supersedeMessage({ from, supersedes, to, cc, subject, body, projectCode, replyTo, attachments, questions, answers, fyi, expectsReply }) {
		if (!from) throw new Error('supersedeMessage: from is required');
		if (!Array.isArray(supersedes) || supersedes.length === 0) {
			throw new Error('supersedeMessage: supersedes must list at least one prior message id');
		}
		if (!Array.isArray(to) || to.length === 0) throw new Error('supersedeMessage: to is required');
		if (body == null) throw new Error('supersedeMessage: body is required');

		await this._validateParties('supersedeMessage', from, to, cc);

		// Load and validate every predecessor up front — no partial commits.
		const predecessors = [];
		for (const prevId of supersedes) {
			const prev = await this._readRawMessage(prevId).catch(() => null);
			if (!prev) throw new Error(`supersedeMessage: predecessor ${prevId} not found`);
			if (prev.from !== from) {
				throw new Error(
					`supersedeMessage: ${prevId} was sent by ${prev.from}, not ${from} — only the original sender can supersede`,
				);
			}
			if (prev.supersededBy) {
				throw new Error(`supersedeMessage: ${prevId} is already superseded by ${prev.supersededBy}`);
			}
			if (prev.questions?.length) {
				const state = await this._foldAsk(prev);
				if (state?.questions.some((q) => q.status !== 'open')) {
					throw Object.assign(
						new Error(
							`supersedeMessage: ${prevId} has questions that were answered or dismissed; answers do not carry across a supersede. Send a follow-up message instead.`,
						),
						{ status: 400 },
					);
				}
			}
			predecessors.push(prev);
		}

		const newRecipients = new Set([...to, ...(cc ?? [])]);
		const droppedRecipients = [];
		for (const prev of predecessors) {
			for (const r of recipientsOf(prev)) {
				if (!newRecipients.has(r)) droppedRecipients.push({ id: prev.id, recipient: r });
			}
		}
		if (droppedRecipients.length) {
			const sample = droppedRecipients
				.slice(0, 3)
				.map((d) => `${d.recipient} (from ${d.id})`)
				.join(', ');
			throw new Error(
				`supersedeMessage: new recipients must cover every predecessor recipient. Missing: ${sample}${droppedRecipients.length > 3 ? `, and ${droppedRecipients.length - 3} more` : ''}. To address a smaller audience, send a regular message instead of superseding.`,
			);
		}

		// Fall back to the most recent predecessor's subject if none provided —
		// keeps the thread title stable in inboxes.
		let derivedSubject = subject;
		if (!derivedSubject || !derivedSubject.trim()) {
			derivedSubject = predecessors[predecessors.length - 1].subject;
		}
		if (!derivedSubject || !derivedSubject.trim()) {
			throw new Error('supersedeMessage: subject could not be derived');
		}

		const prepared = await prepareAttachments(attachments);
		const checkedQuestions = validateQuestions(questions, { to, cc: cc ?? [], from });
		const checkedAnswers = parseAnswers(answers);
		if (checkedAnswers) await this._checkAnswers(checkedAnswers, { from, replyTo });
		const marks = validateMarks({ fyi, expectsReply });

		const id = makeMessageId();
		const sentAt = new Date().toISOString();

		let finalBody = attachments == null ? body : applyAttachmentsToBody(body, id, prepared);
		let questionsAppended = false;
		if (checkedQuestions) ({ body: finalBody, appended: questionsAppended } = ensureQuestionsInBody(finalBody, checkedQuestions));

		await mkdir(this.messagesDir, { recursive: true });
		const content = serializeMessage({
			id,
			from,
			to,
			cc,
			subject: derivedSubject,
			sentAt,
			replyTo,
			supersedes: [...supersedes],
			projectCode,
			...marks,
			attachments: prepared.map((a) => a.name),
			questions: checkedQuestions,
			answers: checkedAnswers,
			body: finalBody,
		});
		await this._writeNewMessage(id, content, prepared);

		// Mark each predecessor with supersededBy + remove from any inbox where
		// it still sits unread (so recipients see only the consolidated message).
		let unreadRemoved = 0;
		const stillReachable = [];
		for (const prev of predecessors) {
			const updated = { ...prev, supersededBy: id };
			await writeFile(this._messagePath(prev.id), serializeMessage(updated), 'utf-8');
			for (const recipient of recipientsOf(prev)) {
				const removed = await this._removeFromMailbox(recipient, 'inbox', prev.id);
				if (removed) unreadRemoved++;
				else stillReachable.push({ id: prev.id, recipient });
			}
		}

		// Deliver the new message normally.
		for (const recipient of [...to, ...(cc ?? [])]) {
			await this._appendToMailbox(recipient, 'inbox', id);
		}
		await this._appendToMailbox(from, 'sent', id);

		return {
			id,
			sentAt,
			supersededIds: [...supersedes],
			unreadRemoved,
			alreadyDelivered: stillReachable.length,
			...(questionsAppended ? { questionsAppended: true } : {}),
		};
	}

	/**
	 * Write a new message's images and then its file, so the message never
	 * names an image that is not there; if the file cannot be written the
	 * images go too.
	 */
	async _writeNewMessage(id, content, prepared) {
		await writeAttachments(this.messagesDir, id, prepared);
		try {
			await writeFile(this._messagePath(id), content, 'utf-8');
		} catch (err) {
			await removeAttachments(this.messagesDir, id);
			throw err;
		}
	}

	async _readRawMessage(id) {
		const content = await readFile(this._messagePath(id), 'utf-8');
		const { metadata, body } = parseFrontmatter(content);
		return normalizeMessage(metadata, body);
	}

	/**
	 * Read a message from the master store. If `inlineParent` is true (default),
	 * the immediately preceding message (replyTo target) is inlined as `parent`,
	 * one level deep. Deeper history is reached by calling read_message again.
	 */
	async readMessage(id, { inlineParent = true, withPaths = false, withState = false } = {}) {
		const msg = await this._readRawMessage(id);
		if (inlineParent && msg.replyTo) {
			const parent = await this._readRawMessage(msg.replyTo).catch(() => null);
			if (parent) msg.parent = parent;
		}
		if (withPaths) {
			this._addAttachmentPaths(msg);
			if (msg.parent) this._addAttachmentPaths(msg.parent);
		}
		if (withState) {
			await this._addQuestionState(msg);
			if (msg.parent) await this._addQuestionState(msg.parent);
		}
		return msg;
	}

	/** `questionState`: each question as folded from the thread (status, answer, also, earlier, reopens, conflict). */
	async _addQuestionState(msg) {
		if (!msg.questions?.length) return;
		const folded = await this._foldAsk(msg);
		if (folded) msg.questionState = folded.questions;
	}

	/**
	 * What `member` owes and is waiting for: `{ waitingOnMe, asked }` (see questions.mjs `waitingOn` and `askedBy`).
	 * Derived from the whole store on every call; it never touches a mailbox.
	 */
	async listQuestions(member) {
		return this._questions.lists(member, { isHuman: await this._isHuman() });
	}

	/** How many open questions wait on each member, from one pass over the store: `{ [name]: n }`. */
	async waitingCounts() {
		return waitingCounts([...(await this.questionStates()).values()]);
	}

	/** The folded state of every ask in the store: Map from the asking message's id to `foldAsk`'s result. */
	async questionStates() {
		return (await this._questionSnapshot()).folded;
	}

	/**
	 * For agents: `attachmentPaths` lists each image's absolute path, so the Read tool can open it
	 * (the body only has the path relative to `team/messages/`). Opt-in because the dashboard serves
	 * these messages to browsers and has no use for the server's directory layout.
	 */
	_addAttachmentPaths(msg) {
		if (msg.attachments?.length) {
			msg.attachmentPaths = msg.attachments.map((name) => resolve(this.messagesDir, 'attachments', msg.id, name));
		}
	}

	async _summariesFromIds(ids) {
		const entries = [];
		let asks = null; // the folded asks, computed once and only if some message in the list has questions
		for (const id of ids) {
			const msg = await this._readRawMessage(id).catch(() => null);
			if (!msg) continue;
			let questions;
			if (msg.questions?.length) {
				asks ??= await this.questionStates();
				const folded = asks.get(msg.id);
				if (folded) questions = countQuestions(folded);
			}
			entries.push({
				id: msg.id,
				from: msg.from,
				to: msg.to,
				cc: msg.cc,
				subject: msg.subject,
				sentAt: msg.sentAt,
				projectCode: msg.projectCode,
				hasParent: !!msg.replyTo,
				supersedes: msg.supersedes?.length ? msg.supersedes : undefined,
				supersededBy: msg.supersededBy,
				...(msg.fyi ? { fyi: true } : {}),
				...(msg.expectsReply ? { expectsReply: true } : {}),
				questions,
			});
		}
		entries.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
		return entries;
	}

	/**
	 * Drop entries whose supersededBy target is also present in `visibleIds`.
	 * The lingering predecessor is hidden because the consolidated version is
	 * reachable in the same mailbox; if the consolidation isn't reachable we
	 * keep the predecessor visible so the recipient never silently loses a
	 * message.
	 */
	_collapseSuperseded(entries, visibleIds) {
		const visible = new Set(visibleIds);
		return entries.filter((e) => !(e.supersededBy && visible.has(e.supersededBy)));
	}

	async listInbox(member) {
		const ids = await this._readMailbox(member, 'inbox');
		const archived = await this._readMailbox(member, 'archives');
		const entries = await this._summariesFromIds(ids);
		// A predecessor is hidden if its consolidated version is reachable in
		// either the inbox or the archives — both count as "the recipient has
		// the new message".
		return this._collapseSuperseded(entries, [...ids, ...archived]);
	}

	/**
	 * @param {string} member
	 * @param {{ to?: string[] }} [opts] — when `to` is provided, only sent
	 *   messages whose to+cc intersects the requested member set are returned.
	 *   Used by agents to find recent threads with a given audience before
	 *   composing or superseding.
	 */
	async listSent(member, opts = {}) {
		const ids = await this._readMailbox(member, 'sent');
		const entries = await this._summariesFromIds(ids);
		const filter = opts.to;
		if (Array.isArray(filter) && filter.length > 0) {
			const want = new Set(filter);
			return entries.filter((e) => {
				const recipients = [...(e.to ?? []), ...(e.cc ?? [])];
				return recipients.some((r) => want.has(r));
			});
		}
		return entries;
	}

	async listArchives(member) {
		const ids = await this._readMailbox(member, 'archives');
		const inbox = await this._readMailbox(member, 'inbox');
		const entries = await this._summariesFromIds(ids);
		return this._collapseSuperseded(entries, [...ids, ...inbox]);
	}

	async archiveMessage(member, id) {
		this._moveBetweenMailboxes(member, 'inbox', 'archives', id, () => {
			throw new Error(`archiveMessage: ${id} is not in ${member}'s inbox`);
		});
		// Handled is handled: a pin ("Needs me") does not outlive the message leaving the inbox.
		this._unpin(member, id);
	}

	async unarchiveMessage(member, id) {
		this._moveBetweenMailboxes(member, 'archives', 'inbox', id, () => {
			throw new Error(`unarchiveMessage: ${id} is not in ${member}'s archives`);
		});
	}

	/**
	 * Delete a message from a member's inbox without archiving it.
	 * Used by the UI for explicit "discard" actions.
	 */
	async deleteInboxMessage(member, id) {
		await this._removeFromMailbox(member, 'inbox', id);
		this._unpin(member, id);
	}

	async deleteArchivedMessage(member, id) {
		await this._removeFromMailbox(member, 'archives', id);
	}

	// ─── Inbox sections ("Needs you" / FYI) and pins ───────────────────────────
	//
	// The sections are a view over the inbox (see inbox-rules.mjs); only a pin is stored, in the member's
	// inbox-state.json. Nothing here moves a message between mailboxes.

	_statePath(member) {
		return inboxStatePath(this.teamDir, member);
	}

	/** Drop a pin; a no-op when there is none (and no file is written then). */
	_unpin(member, id) {
		updateInboxState(this._statePath(member), (state) => {
			if (!(id in state.pinned)) return false;
			delete state.pinned[id];
			return true;
		});
	}

	/** Pin a message in the member's inbox ("Needs me"): it stays in Needs you until unpinned or archived. */
	async pinMessage(member, id) {
		const roster = await this._loadRosterNames();
		if (roster) this._assertInRoster('pinMessage.member', member, roster);
		if (!(await this._readMailbox(member, 'inbox')).includes(id)) {
			throw Object.assign(new Error(`pinMessage: ${id} is not in ${member}'s inbox`), { status: 404 });
		}
		updateInboxState(this._statePath(member), (state) => {
			if (id in state.pinned) return false;
			state.pinned[id] = new Date().toISOString();
			return true;
		});
	}

	async unpinMessage(member, id) {
		const roster = await this._loadRosterNames();
		if (roster) this._assertInRoster('unpinMessage.member', member, roster);
		this._unpin(member, id);
	}

	/**
	 * The ids `member` has replied to, among `candidates` (inbox messages that ask for a reply): every ancestor,
	 * through `replyTo`, of a message they sent after the oldest candidate. Reads messages only when there is a
	 * candidate, so a mailbox without `expectsReply` mail costs nothing.
	 */
	async _repliedAmong(member, candidates) {
		if (candidates.length === 0) return new Set();
		const oldest = candidates.reduce((min, c) => ((c.sentAt || '') < min ? c.sentAt || '' : min), candidates[0].sentAt || '');
		const parents = new Map();
		const parentOf = async (id) => {
			if (!parents.has(id)) parents.set(id, (await this._readRawMessage(id).catch(() => null))?.replyTo);
			return parents.get(id);
		};
		const sent = [];
		for (const id of await this._readMailbox(member, 'sent')) {
			const msg = await this._readRawMessage(id).catch(() => null);
			if (msg && msg.replyTo && (msg.sentAt || '') > oldest) sent.push({ id: msg.id, replyTo: msg.replyTo });
		}
		return repliedIds(sent, parentOf);
	}

	/**
	 * The ids of the member's archived messages that contain `query` (subject, body, people, project code),
	 * newest first, at most `limit`. Reads only that member's archive; superseded predecessors are skipped like
	 * everywhere else.
	 */
	async searchArchives(member, query, { limit = 500 } = {}) {
		if (typeof query !== 'string' || query.trim().length < 2) return [];
		const found = [];
		for (const entry of await this.listArchives(member)) {
			const msg = await this._readRawMessage(entry.id).catch(() => null);
			if (msg && textMatches(msg, query)) found.push({ id: msg.id, sentAt: msg.sentAt });
		}
		found.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
		return found.slice(0, limit).map((m) => m.id);
	}

	/**
	 * The member's inbox cut into sections: `{ inbox, needs, needsCount }`.
	 *   - `inbox`: what `listInbox` returns;
	 *   - `needs`: `{ [id]: reasons }` for every message that needs the member (`card`, `reply`, `pin`; see
	 *     inbox-rules.mjs). A message with an open question for the member counts wherever it sits, inbox or
	 *     archive, because the asker is waiting on it; the other two reasons need the message in the inbox;
	 *   - `needsCount`: the size of `needs`.
	 * Everything in `inbox` that is not in `needs` is FYI.
	 */
	async inboxSections(member) {
		const inbox = await this.listInbox(member);
		const archived = new Set(await this._readMailbox(member, 'archives'));
		const waitingAsks = new Set((await this.listQuestions(member)).waitingOnMe.map((w) => w.askId));
		const inInbox = new Set(inbox.map((m) => m.id));
		const pinned = new Set(Object.keys(readInboxState(this._statePath(member)).pinned));
		const asks = inbox.filter((m) => m.expectsReply && m.from !== member && m.to?.includes(member) && !pinned.has(m.id) && !waitingAsks.has(m.id));
		const replied = await this._repliedAmong(member, asks);
		const facts = { cards: waitingAsks, replied, pinned };
		const classified = classifyInbox(inbox, member, facts);
		// An open question waits on the member even if they archived the message.
		for (const id of waitingAsks) if (!inInbox.has(id) && archived.has(id)) classified.set(id, ['card']);
		const needs = {};
		for (const [id, reasons] of classified) if (reasons.length > 0) needs[id] = reasons;
		return { inbox, needs, needsCount: countNeeds(classified) };
	}
}
