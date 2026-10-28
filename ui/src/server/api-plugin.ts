import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { createLinker, type LinksConfig } from './linkify.js';

interface MessageSummary {
	id: string;
	from: string;
	to: string[];
	cc?: string[];
	subject: string;
	sentAt: string;
	projectCode?: string;
	hasParent: boolean;
	supersedes?: string[];
	supersededBy?: string;
	fyi?: boolean;
	expectsReply?: boolean;
	/** Members the body tags with @name (see scripts/lib/messaging/mentions.mjs). */
	mentions?: string[];
}

type MailBox = 'inbox' | 'sent' | 'archives';

/** One message as it appears inside a thread group — no body; bodies are fetched on open. */
interface ThreadMessage {
	id: string;
	from: string;
	to: string[];
	cc?: string[];
	subject: string;
	sentAt: string;
	replyTo?: string;
	projectCode?: string;
	supersedes?: string[];
	supersededBy?: string;
	/** Which of this member's mailboxes hold the id. Empty = ancestor pulled in for context only. */
	boxes: MailBox[];
	/** Reply distance from the root of its own chain. */
	depth: number;
	/** Set when the message asks questions: how many are still open. */
	questions?: { open: number; total: number };
	/** The sender's marks: nothing needed (`fyi`) or a written answer wanted (`expectsReply`). */
	fyi?: boolean;
	expectsReply?: boolean;
	/** Members the body tags with @name. */
	mentions?: string[];
	/** Why this message needs the viewed member (`card`, `reply`, `mention`, `pin`); absent when it does not. */
	needs?: string[];
}

interface Thread {
	/** Earliest message in the group — stable enough to key a selection on. */
	id: string;
	subject: string;
	participants: string[];
	projectCodes: string[];
	messageCount: number;
	inboxCount: number;
	sentCount: number;
	archiveCount: number;
	/** Messages in the thread that need the viewed member (see `needs` on a message). */
	needsCount: number;
	firstAt: string;
	lastAt: string;
	lastFrom: string;
	preview: string;
	/** Set when any message in the thread asks questions (the latest versions only): who is still being waited on. */
	questions?: { open: number; total: number; waitingOn: string[] };
	messages: ThreadMessage[];
}

/** A question as a sender wrote it (see scripts/lib/messaging/questions.mjs). */
interface Question {
	id: string;
	text: string;
	options: { label: string; description?: string }[];
	recommend: number;
	waitingOn: string[];
}

/** One answer or dismissal as folded from the thread. */
interface QuestionAnswer {
	kind: 'option' | 'other' | 'dismissed';
	option?: number;
	other?: string;
	by: string;
	recordedBy?: string;
	via?: string;
	at: string;
	messageId: string;
}

interface QuestionState extends Question {
	status: 'open' | 'answered' | 'dismissed';
	answer: QuestionAnswer | null;
	also: QuestionAnswer[];
	earlier: QuestionAnswer[];
	reopens: number;
	reopenReason: string | null;
	reopenedAt: string | null;
	conflict: boolean;
}

/** What `foldAsk` returns for one asking message. */
interface FoldedAsk {
	askId: string;
	asker: string;
	subject: string;
	sentAt: string;
	superseded: boolean;
	questions: QuestionState[];
}

interface WaitingItem {
	askId: string;
	q: string;
	text: string;
	asker: string;
	subject: string;
	since: string;
	reopened?: string;
	options: { label: string; description?: string }[];
	recommend: number;
}

interface Message {
	id: string;
	from: string;
	to: string[];
	cc?: string[];
	subject: string;
	sentAt: string;
	replyTo?: string;
	supersedes?: string[];
	supersededBy?: string;
	projectCode?: string;
	fyi?: boolean;
	expectsReply?: boolean;
	/** Members the body tags with @name. */
	mentions?: string[];
	body: string;
	/** Names of the images stored with the message. */
	attachments?: string[];
	questions?: Question[];
	answers?: { ask: string; q: string; option?: number; other?: string; dismissed?: boolean; reopen?: string; by?: string; via?: string }[];
	/** Each question as folded from the thread. Added on the way out, never stored. */
	questionState?: QuestionState[];
	/** Paths in `body` that resolve to a link (see lib/linkify.ts). Added on the way out, never stored. */
	links?: Record<string, { href: string; title?: string; external: boolean }>;
	parent?: Message;
}

interface MessagingAdapter {
	hasMessages(member: string): Promise<boolean>;
	sendMessage(args: {
		from: string;
		to: string[];
		cc?: string[];
		subject?: string;
		body: string;
		replyTo?: string;
		projectCode?: string;
		answers?: { ask: string; q: string; option?: number; other?: string; dismissed?: boolean }[];
		/** `false`: the body is a record (a transcript, a reply that repeats question text), so it tags nobody. */
		tags?: boolean;
	}): Promise<{ id: string; sentAt: string }>;
	supersedeMessage(args: {
		from: string;
		supersedes: string[];
		to: string[];
		cc?: string[];
		subject?: string;
		body: string;
		replyTo?: string;
		projectCode?: string;
	}): Promise<{ id: string; sentAt: string; supersededIds: string[]; unreadRemoved: number; alreadyDelivered: number }>;
	readMessage(id: string, opts?: { inlineParent?: boolean }): Promise<Message>;
	listInbox(member: string): Promise<MessageSummary[]>;
	listSent(member: string, opts?: { to?: string[] }): Promise<MessageSummary[]>;
	listArchives(member: string): Promise<MessageSummary[]>;
	archiveMessage(member: string, id: string): Promise<void>;
	unarchiveMessage(member: string, id: string): Promise<void>;
	deleteInboxMessage(member: string, id: string): Promise<void>;
	deleteArchivedMessage(member: string, id: string): Promise<void>;
	/** Questions on messages (the file adapter has them; an adapter without them leaves the dashboard as it was). */
	questionStates?(): Promise<Map<string, FoldedAsk>>;
	listQuestions?(member: string): Promise<{ waitingOnMe: WaitingItem[]; asked: unknown[] }>;
	waitingCounts?(): Promise<Record<string, number>>;
	/** Inbox sections and pins (the file adapter has them; without them every inbox message is FYI). */
	inboxSections?(
		member: string,
		opts?: { folded?: Map<string, FoldedAsk> },
	): Promise<{ inbox: MessageSummary[]; needs: Record<string, string[]>; needsCount: number }>;
	pinMessage?(member: string, id: string): Promise<void>;
	unpinMessage?(member: string, id: string): Promise<void>;
	searchArchives?(member: string, query: string, opts?: { limit?: number }): Promise<string[]>;
}

interface ScheduleEvent {
	id: string;
	title: string;
	description?: string;
	time: string;
	recurrence?: { frequency: 'daily' | 'weekly' | 'monthly'; interval: number; endDate?: string };
	projectCode?: string;
	isDue?: boolean;
}

interface ScheduleAdapter {
	listEvents(member: string): Promise<ScheduleEvent[]>;
	addEvent(
		member: string,
		input: {
			title: string;
			time: string;
			description?: string;
			recurrence?: { frequency: string; interval: number; endDate?: string };
			projectCode?: string;
		},
	): Promise<{ id: string }>;
	updateEvent(
		member: string,
		id: string,
		patch: {
			title?: string;
			description?: string;
			time?: string;
			recurrence?: { frequency: string; interval: number; endDate?: string } | null;
			projectCode?: string;
		},
	): Promise<void>;
	removeEvent(member: string, id: string): Promise<void>;
}

interface ChatTranscriptEntry {
	role: 'human' | 'member';
	text: string;
	at: string;
}

interface ChatSessionInfo {
	id: string;
	member: string;
	human: string;
	startedAt: string;
	lastActiveAt: string;
	busy: boolean;
	/** Set by the dashboard when the viewer may not see the transcript. */
	private?: boolean;
	transcript: ChatTranscriptEntry[];
	/** Where a continued chat resumed an earlier one. */
	breaks: { index: number; at: string; wrappedUp: boolean }[];
	continues: { id: string; messageId: string | null; at: string } | null;
	/** Cycles of this member that finished while the chat was open. */
	cycleCompletions: { at: string; exitCode: number }[];
}

/** What happened to a chat that is no longer open (`ChatSessions.gone`). */
interface ChatGoneInfo {
	id: string;
	reason: 'idle' | 'ended' | 'discarded' | 'unknown';
	[key: string]: unknown;
}

/**
 * The live-chat controller (`scripts/lib/chat/session.mjs`), injected by the
 * vite config the same way the adapters are. Sessions live in this process;
 * the agent it spawns writes to the member's files directly, and the
 * transcript is filed through the messaging adapter when a chat ends — see
 * teamos/docs/chat.md.
 */
interface ChatController {
	/** Resolves once chats saved by the previous dashboard process are restored. */
	ready(): Promise<void>;
	create(args: {
		member: string;
		human: string;
		continueFrom?: string;
		transcript?: ChatTranscriptEntry[];
	}): Promise<unknown>;
	summarize(session: unknown): ChatSessionInfo;
	get(id: string): unknown;
	turn(
		id: string,
		text: string,
		opts: { onEvent: (event: unknown) => void; signal: AbortSignal },
	): Promise<{ exitCode: number; answer: string }>;
	end(id: string, opts?: { persist?: boolean }): Promise<{ persisted: boolean; messageId?: string; wrappingUp?: boolean }>;
	status(
		member: string,
		opts?: { sessionId?: string },
	): Promise<{
		midCycle: boolean;
		since?: string;
		session: ChatSessionInfo | null;
		gone: ChatGoneInfo | null;
		changedFiles: string[];
	}>;
}

interface LogEntry {
	name: string;
	kind: 'cycle' | 'chat';
	priority: string | null;
	startedAt: string;
	updatedAt: string;
	size: number;
	running: boolean;
	status: 'running' | 'ok' | 'failed' | 'interrupted';
	exitCode: number | null;
	durationSec: number | null;
	costUsd: number | null;
	runs: number;
}

interface LogChunk {
	name: string;
	kind: 'cycle' | 'chat';
	size: number;
	from: number;
	to: number;
	text: string;
	running: boolean;
	exitCode: number | null;
	status: LogEntry['status'];
}

/**
 * Read-only view of a member's agent logs in `team/.logs/`
 * (`scripts/lib/logs.mjs`), injected by the vite config like the adapters.
 * It validates every member and log name itself and throws errors carrying
 * the HTTP status to answer with.
 */
interface LogReader {
	list(member: string): Promise<LogEntry[]>;
	read(member: string, name: string, opts: { tail?: number; from?: number; to?: number }): Promise<LogChunk>;
}

/**
 * Image attachments (`scripts/lib/messaging/attachments.mjs`), injected by the
 * vite config like the adapters. It validates every name and id itself and
 * throws errors carrying the HTTP status to answer with.
 */
interface AttachmentStore {
	limits: { maxBytes: number; maxCount: number; maxTotalBytes: number; types: string[] };
	stage(input: { from: string; name: string; bytes: Buffer }): Promise<{ token: string; name: string; size: number; mime: string }>;
	claim(tokens: unknown, from: string): Promise<{ path: string; name: string; ref: string }[]>;
	release(tokens: string[]): Promise<void>;
	read(id: string, name: string): Promise<{ bytes: Buffer; mime: string } | null>;
}

interface AuthConfig {
	/** If false, identity headers are ignored — the dashboard trusts its own localStorage selection. */
	trustProxy?: boolean;
	/** Lowercase header names checked in order; first match wins. */
	identityHeaders?: string[];
}

interface ApiOptions {
	teamDir: string;
	/** Workspace that message paths are relative to; with `links`, turns paths in messages into links. */
	projectRoot?: string;
	links?: LinksConfig;
	ticketsDir?: string;
	siblingDir?: string;
	siblingPort?: number;
	messagingAdapter: MessagingAdapter;
	messagingAdapterName: string;
	/** Image attachments on messages; absent = the dashboard does not offer them. */
	attachments?: AttachmentStore;
	scheduleAdapter: ScheduleAdapter;
	scheduleAdapterName: string;
	auth?: AuthConfig;
	chat?: ChatController;
	logs?: LogReader;
}

function json(res: ServerResponse, data: unknown, status = 200) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(data));
}

/**
 * Open a Server-Sent Events response and return its writer. One event shape
 * (a JSON object with a `kind`) on the default event type, so the client is a
 * few lines of split-on-blank-line rather than an EventSource — the turn that
 * carries the human's text has to be a POST.
 */
function sse(res: ServerResponse): (event: unknown) => void {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
		// Vite's dev server doesn't buffer, but a proxy in front of it might.
		'X-Accel-Buffering': 'no',
	});
	return (event: unknown) => {
		res.write(`data: ${JSON.stringify(event)}\n\n`);
	};
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (chunk: Buffer) => (data += chunk));
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});
}

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { meta: {}, body: content };
	const meta: Record<string, unknown> = {};
	for (const line of match[1].split('\n')) {
		const idx = line.indexOf(':');
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		let val: unknown = line.slice(idx + 1).trim();
		if (val === 'true') val = true;
		else if (val === 'false') val = false;
		else if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']'))
			val = val
				.slice(1, -1)
				.split(',')
				.map((s) => s.trim().replace(/^["']|["']$/g, ''));
		meta[key] = val;
	}
	return { meta, body: match[2].trim() };
}

async function readJson(path: string, fallback: unknown = null): Promise<any> {
	try {
		return JSON.parse(await readFile(path, 'utf-8'));
	} catch {
		return fallback;
	}
}

async function readText(path: string, fallback = ''): Promise<string> {
	try {
		return await readFile(path, 'utf-8');
	} catch {
		return fallback;
	}
}

async function dirExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function countMdFiles(dir: string): Promise<number> {
	try {
		const files = await readdir(dir);
		return files.filter((f) => f.endsWith('.md')).length;
	} catch {
		return 0;
	}
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 50);
}

function isValidMemberName(name: string): boolean {
	return /^[A-Za-z][A-Za-z0-9_-]{0,48}$/.test(name);
}

interface ProfileFields {
	title?: string;
	description?: string;
	type?: 'ai' | 'human';
	active?: boolean;
	roles?: string[];
}

function serializeRoles(roles: string[]): string {
	const escaped = roles.map((r) => (r.includes(',') || r.includes(' ') ? `"${r.replace(/"/g, '\\"')}"` : r));
	return `[${escaped.join(', ')}]`;
}

function renderProfileMd(name: string, fields: ProfileFields, body: string): string {
	const roles = fields.roles ?? [];
	const fm = [
		'---',
		`name: ${name}`,
		`title: ${fields.title ?? ''}`,
		`description: ${fields.description ?? ''}`,
		`type: ${fields.type ?? 'ai'}`,
		`active: ${fields.active ?? true}`,
		`roles: ${serializeRoles(roles)}`,
		'---',
		'',
	].join('\n');
	return fm + (body ?? '') + (body && !body.endsWith('\n') ? '\n' : '');
}

function updateFrontmatterFields(content: string, patch: ProfileFields & { body?: string }): string {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return content;
	let fm = match[1];
	const body = patch.body !== undefined ? patch.body : match[2];

	const setField = (key: string, value: string) => {
		const re = new RegExp(`^(${key}):.*$`, 'm');
		if (re.test(fm)) {
			fm = fm.replace(re, `${key}: ${value}`);
		} else {
			fm = `${fm}\n${key}: ${value}`;
		}
	};

	if (patch.title !== undefined) setField('title', patch.title);
	if (patch.description !== undefined) setField('description', patch.description);
	if (patch.type !== undefined) setField('type', patch.type);
	if (patch.active !== undefined) setField('active', String(patch.active));
	if (patch.roles !== undefined) setField('roles', serializeRoles(patch.roles));

	const trimmedBody = body.replace(/^\s*\n/, '');
	return `---\n${fm}\n---\n\n${trimmedBody}${trimmedBody.endsWith('\n') ? '' : '\n'}`;
}

/** The plain-words body of an answers reply: one line per entry ("Q1 (Which palette?): option 2, Sky."). */
function answersBody(ask: Message, entries: { q: string; option?: number; other?: string; dismissed?: boolean }[]): string {
	const lines = entries.map((e) => {
		const question = ask.questions?.find((q) => q.id === e.q);
		const label = e.q.toUpperCase();
		const text = question ? ` (${question.text})` : '';
		if (e.dismissed) return `${label}${text}: not needed (dismissed).`;
		if (e.other != null) return `${label}${text}: other: ${e.other}`;
		const option = question?.options[(e.option ?? 0) - 1];
		return `${label}${text}: option ${e.option}${option ? `, ${option.label}` : ''}.`;
	});
	return lines.join('\n');
}

/**
 * Read a raw request body, giving up as soon as it passes `maxBytes`. `readBody`
 * above has no cap; an upload must not be able to fill memory with a body the
 * size of the sender's patience.
 */
function readBodyBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const tooLarge = () => Object.assign(new Error(`Upload is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`), { status: 413 });
		const declared = Number(req.headers['content-length']);
		if (Number.isFinite(declared) && declared > maxBytes) return reject(tooLarge());
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBytes) {
				chunks.length = 0;
				return reject(tooLarge());
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

export function teamosApi(opts: ApiOptions): Plugin {
	const { teamDir, siblingDir, messagingAdapter, messagingAdapterName, scheduleAdapter, chat, logs, attachments } = opts;
	const siblingPort = opts.siblingPort ?? 3004;
	const ticketsDir = opts.ticketsDir ?? null;
	let ticketsAvailable: boolean | null = null;
	const linker = createLinker({
		projectRoot: opts.projectRoot ?? join(teamDir, '..'),
		teamDir,
		messageExists: async (id) => (await readCachedMessage(id)) !== null,
		links: opts.links,
	});

	/** The folded questions of the store, or null when no message is asking anything or the adapter has none. */
	async function foldedAsks(wanted: Message[]): Promise<Map<string, FoldedAsk> | null> {
		if (!messagingAdapter.questionStates) return null;
		const asking = (m: Message | undefined): boolean => !!m && (!!m.questions?.length || asking(m.parent));
		return wanted.some((m) => asking(m)) ? messagingAdapter.questionStates() : null;
	}

	/**
	 * A copy of the message with the paths in its body (and its parent's) resolved to links, and, when it asks
	 * questions, each one's state folded from the thread (`asks` comes from `foldedAsks`).
	 */
	async function withLinks(msg: Message, asks: Map<string, FoldedAsk> | null = null): Promise<Message> {
		const links = await linker.linksFor(msg.body);
		const out: Message = { ...msg };
		if (Object.keys(links).length > 0) out.links = links;
		const folded = msg.questions?.length ? asks?.get(msg.id) : undefined;
		if (folded) out.questionState = folded.questions;
		if (msg.parent) out.parent = await withLinks(msg.parent, asks);
		return out;
	}

	const auth = opts.auth ?? {};
	const trustProxy = auth.trustProxy === true;
	const identityHeaders = (auth.identityHeaders ?? []).map((h) => h.toLowerCase());

	async function resolveIdentity(
		req: IncomingMessage,
	): Promise<{ name: string | null; locked: boolean; source?: string; email?: string }> {
		if (!trustProxy || identityHeaders.length === 0) {
			return { name: null, locked: false };
		}
		for (const header of identityHeaders) {
			const raw = req.headers[header];
			const value = Array.isArray(raw) ? raw[0] : raw;
			if (!value) continue;
			const email = String(value).trim().toLowerCase();
			if (!email) continue;
			const manifest = await readJson(join(teamDir, 'members.json'), { members: [] });
			const members: any[] = manifest.members ?? [];
			const match = members.find((m: any) => typeof m.email === 'string' && m.email.toLowerCase() === email);
			return {
				name: match ? match.name : null,
				locked: true,
				source: header,
				email,
			};
		}
		return { name: null, locked: false };
	}

	/**
	 * The dashboard trusts the proxy identity for *who you are*, but until now the
	 * write endpoints took the sender from the request body, so anyone on the
	 * tailnet could send as anyone. When the identity is locked, the sender is
	 * the resolved member, whatever the body says; a locked header that matches
	 * no member is refused. Unlocked (localhost dev) keeps the picker's choice.
	 */
	async function enforceSender(req: IncomingMessage, claimed: unknown): Promise<{ name: string } | { error: string }> {
		const me = await resolveIdentity(req);
		if (!me.locked) {
			return typeof claimed === 'string' && claimed ? { name: claimed } : { error: 'No sender' };
		}
		if (!me.name) return { error: `Unrecognized identity: ${me.email ?? 'no email'} matches no member` };
		return { name: me.name };
	}

	/**
	 * A chat is between the human who opened it and the member. With a locked identity,
	 * only that human (or a member whose roles include `admin`) sees the transcript or
	 * may speak in it; everyone else sees that a chat is open and nothing more. Unlocked
	 * (localhost dev) keeps the old behaviour: every chat is visible.
	 */
	async function mayViewChat(req: IncomingMessage, session: unknown): Promise<boolean> {
		const human = (session as { human?: unknown } | null)?.human;
		const me = await resolveIdentity(req);
		if (!me.locked) return true;
		if (!me.name) return false;
		if (typeof human === 'string' && me.name === human) return true;
		const manifest = await readJson(join(teamDir, 'members.json'), { members: [] });
		const member = (manifest.members ?? []).find((m: any) => m.name === me.name);
		return Array.isArray(member?.roles) && member.roles.includes('admin');
	}

	async function hasTickets(): Promise<boolean> {
		if (ticketsAvailable !== null) return ticketsAvailable;
		ticketsAvailable = ticketsDir ? await dirExists(ticketsDir) : false;
		return ticketsAvailable;
	}

	/** The inbox cut into sections; an adapter without sections has everything in FYI. */
	async function inboxSectionsOf(member: string, folded?: Map<string, FoldedAsk>) {
		if (messagingAdapter.inboxSections) {
			const found = await messagingAdapter.inboxSections(member, { folded }).catch(() => null);
			if (found) return found;
		}
		const inbox = await messagingAdapter.listInbox(member).catch(() => [] as MessageSummary[]);
		return { inbox, needs: {} as Record<string, string[]>, needsCount: 0 };
	}

	async function getMemberSummaries() {
		const manifest = await readJson(join(teamDir, 'members.json'), { members: [] });
		const waiting = messagingAdapter.waitingCounts ? await messagingAdapter.waitingCounts().catch(() => ({})) : {};
		// One fold of the questions for every member, not one per member.
		const folded = messagingAdapter.questionStates ? await messagingAdapter.questionStates().catch(() => undefined) : undefined;
		return Promise.all(
			manifest.members.map(async (m: Record<string, unknown>) => {
				const dir = join(teamDir, 'members', m.name as string);
				const sections = await inboxSectionsOf(m.name as string, folded);
				const todos = await readJson(join(dir, 'todo.json'), { items: [] });
				const items: any[] = todos.items ?? [];
				const events = await scheduleAdapter.listEvents(m.name as string).catch(() => []);
				return {
					...m,
					inboxCount: sections.inbox.length,
					needsCount: sections.needsCount,
					waitingCount: (waiting as Record<string, number>)[m.name as string] ?? 0,
					todoCount: items.length,
					blockedCount: items.filter((t: any) => t.status === 'blocked').length,
					eventCount: events.length,
				};
			}),
		);
	}

	async function getMemberDetail(name: string) {
		const dir = join(teamDir, 'members', name);
		const profileRaw = await readText(join(dir, 'profile.md'));
		const state = await readText(join(dir, 'state.md'));
		const todos = await readJson(join(dir, 'todo.json'), { items: [] });
		const events = await scheduleAdapter.listEvents(name).catch(() => []);
		return {
			name,
			profile: parseFrontmatter(profileRaw),
			state,
			todos,
			schedule: { events },
		};
	}

	// ─── Thread grouping (a human view over the flat master store) ────────────
	//
	// The agent-facing contract is deliberately flat: a thread is the transitive
	// closure of `replyTo` pointers and a mailbox is a list of ids. That is right
	// for agents and unreadable for people — a working inbox is ninety rows of
	// "Re: ..." whose parents live in sent/ or archives/. These helpers build the
	// view the dashboard renders: chains resolved through the master store
	// (ancestors are pulled in for context even when they sit in none of this
	// member's mailboxes), then chains sharing a root subject folded into one
	// group, so one subject is one row no matter how many chains it spawned.

	const messageCache = new Map<string, { mtimeMs: number; msg: Message }>();

	/**
	 * Read a message through an mtime-validated cache. Grouping touches every id
	 * in every mailbox on each request; without this a member with a few hundred
	 * archived messages re-parses all of them on every page load.
	 */
	async function readCachedMessage(id: string): Promise<Message | null> {
		let mtimeMs: number | null = null;
		try {
			mtimeMs = (await stat(join(teamDir, 'messages', `${id}.md`))).mtimeMs;
		} catch {
			// Missing, or an adapter that isn't file-backed — fall through uncached.
		}
		if (mtimeMs !== null) {
			const hit = messageCache.get(id);
			if (hit && hit.mtimeMs === mtimeMs) return hit.msg;
		}
		const msg = await messagingAdapter.readMessage(id, { inlineParent: false }).catch(() => null);
		if (msg && mtimeMs !== null) messageCache.set(id, { mtimeMs, msg });
		return msg;
	}

	function normalizeSubject(subject: string): string {
		return (subject ?? '').replace(/^(\s*re:\s*)+/i, '').trim();
	}

	function previewOf(body: string): string {
		return (body ?? '')
			.replace(/```[\s\S]*?```/g, ' ')
			.replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ')
			.replace(/[#>*_`]/g, '')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 240);
	}

	/** Cap on how far a replyTo walk follows before giving up on a malformed chain. */
	const MAX_CHAIN_DEPTH = 128;

	async function buildThreads(member: string): Promise<Thread[]> {
		// Mailbox membership comes from the adapter listings, not the raw json, so
		// the supersede-collapse rule applies here exactly as it does everywhere
		// else and the tab badge matches the dashboard's inbox count.
		const boxesById = new Map<string, MailBox[]>();
		const sections = await inboxSectionsOf(member);
		const listers: Record<MailBox, () => Promise<MessageSummary[]>> = {
			inbox: async () => sections.inbox,
			sent: () => messagingAdapter.listSent(member),
			archives: () => messagingAdapter.listArchives(member),
		};
		for (const box of ['inbox', 'sent', 'archives'] as MailBox[]) {
			const entries = await listers[box]().catch(() => []);
			for (const entry of entries) {
				const boxes = boxesById.get(entry.id);
				if (boxes) boxes.push(box);
				else boxesById.set(entry.id, [box]);
			}
		}

		// Every mailbox message, plus every ancestor reachable from one.
		const loaded = new Map<string, Message>();
		// A message with an open question for the member counts even if it is in none of their mailboxes (they
		// deleted it, the asker still waits): it is pulled in as context so the thread can be opened and answered.
		const pending = [...new Set([...boxesById.keys(), ...Object.keys(sections.needs)])];
		while (pending.length > 0) {
			const id = pending.pop() as string;
			if (loaded.has(id)) continue;
			const msg = await readCachedMessage(id);
			if (!msg) continue;
			loaded.set(id, msg);
			if (msg.replyTo && !loaded.has(msg.replyTo)) pending.push(msg.replyTo);
		}

		// Root + depth per message. Memoized, and cycle-guarded: replyTo is written
		// by the adapter, but a hand-edited store shouldn't hang the server.
		const chain = new Map<string, { root: string; depth: number }>();
		function resolve(id: string): { root: string; depth: number } {
			const memo = chain.get(id);
			if (memo) return memo;
			const path: string[] = [];
			const seen = new Set<string>();
			let base: { root: string; depth: number } | null = null;
			let cur: string | undefined = id;
			while (cur && !seen.has(cur)) {
				const known = chain.get(cur);
				if (known) {
					base = known;
					break;
				}
				seen.add(cur);
				path.push(cur);
				const parent: string | undefined = loaded.get(cur)?.replyTo;
				cur = parent && loaded.has(parent) && path.length < MAX_CHAIN_DEPTH ? parent : undefined;
			}
			// path runs leaf → … → root (or → the first node with a known root).
			const root = base ? base.root : path[path.length - 1];
			const baseDepth = base ? base.depth + 1 : 0;
			for (let i = path.length - 1; i >= 0; i--) {
				chain.set(path[i], { root, depth: baseDepth + (path.length - 1 - i) });
			}
			return chain.get(id) as { root: string; depth: number };
		}

		// Fold chains into subject groups. An ancestor always resolves to the same
		// root as its descendants, so a group can never be context-only.
		const groups = new Map<string, string[]>();
		for (const id of loaded.keys()) {
			const rootMsg = loaded.get(resolve(id).root) ?? loaded.get(id);
			const subject = normalizeSubject(rootMsg?.subject ?? '');
			const key = subject ? subject.toLowerCase() : `id:${resolve(id).root}`;
			const ids = groups.get(key);
			if (ids) ids.push(id);
			else groups.set(key, [id]);
		}

		const asks = await foldedAsks([...loaded.values()]);
		const threads: Thread[] = [];
		for (const ids of groups.values()) {
			const msgs = ids
				.map((id) => loaded.get(id) as Message)
				.sort((a, b) => (a.sentAt || '').localeCompare(b.sentAt || ''));
			const inMailbox = msgs.filter((m) => boxesById.has(m.id));
			const latest = inMailbox[inMailbox.length - 1] ?? msgs[msgs.length - 1];
			const participants: string[] = [];
			const projectCodes: string[] = [];
			for (const m of msgs) {
				for (const who of [m.from, ...(m.to ?? []), ...(m.cc ?? [])]) {
					if (who && !participants.includes(who)) participants.push(who);
				}
				if (m.projectCode && !projectCodes.includes(m.projectCode)) projectCodes.push(m.projectCode);
			}
			const boxCount = (box: MailBox) => msgs.filter((m) => boxesById.get(m.id)?.includes(box)).length;
			const needsCount = msgs.filter((m) => sections.needs[m.id]).length;
			// Questions: only the live version of each ask counts (a superseded one is replaced by its successor).
			const counts = (m: Message) => {
				const folded = m.questions?.length ? asks?.get(m.id) : undefined;
				if (!folded) return undefined;
				return { open: folded.questions.filter((q) => q.status === 'open').length, total: folded.questions.length };
			};
			const live = msgs.filter((m) => !m.supersededBy && counts(m));
			const questions = live.length
				? {
						open: live.reduce((n, m) => n + (counts(m)?.open ?? 0), 0),
						total: live.reduce((n, m) => n + (counts(m)?.total ?? 0), 0),
						waitingOn: [
							...new Set(
								live.flatMap((m) =>
									(asks?.get(m.id)?.questions ?? []).filter((q) => q.status === 'open').flatMap((q) => q.waitingOn),
								),
							),
						],
					}
				: undefined;
			threads.push({
				id: msgs[0].id,
				subject: normalizeSubject(msgs[0].subject) || msgs[0].subject || '(no subject)',
				participants,
				projectCodes,
				messageCount: msgs.length,
				inboxCount: boxCount('inbox'),
				sentCount: boxCount('sent'),
				archiveCount: boxCount('archives'),
				needsCount,
				firstAt: msgs[0].sentAt,
				lastAt: latest.sentAt,
				lastFrom: latest.from,
				preview: previewOf(latest.body),
				questions,
				messages: msgs.map((m) => ({
					id: m.id,
					from: m.from,
					to: m.to ?? [],
					cc: m.cc?.length ? m.cc : undefined,
					subject: m.subject,
					sentAt: m.sentAt,
					replyTo: m.replyTo,
					projectCode: m.projectCode,
					supersedes: m.supersedes?.length ? m.supersedes : undefined,
					supersededBy: m.supersededBy,
					boxes: boxesById.get(m.id) ?? [],
					depth: resolve(m.id).depth,
					questions: counts(m),
					...(m.fyi ? { fyi: true } : {}),
					...(m.expectsReply ? { expectsReply: true } : {}),
					...(m.mentions?.length ? { mentions: m.mentions } : {}),
					...(sections.needs[m.id] ? { needs: sections.needs[m.id] } : {}),
				})),
			});
		}
		threads.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
		return threads;
	}

	/**
	 * What a browser may hand to `sendMessage`: the message's own fields and the marks, nothing else. Options that
	 * belong to the server (`tags`) and anything else in the JSON are dropped, so a caller cannot switch off the
	 * @tag rule for their own message.
	 */
	function sendableFields(msg: Record<string, unknown>) {
		const { from, to, cc, subject, body, replyTo, projectCode, attachments, questions, answers, fyi, expectsReply } = msg;
		return { from, to, cc, subject, body, replyTo, projectCode, attachments, questions, answers, fyi, expectsReply } as Parameters<typeof sendMessage>[0];
	}

	async function sendMessage(msg: {
		from: string;
		to: string[];
		cc?: string[];
		subject?: string;
		body: string;
		replyTo?: string;
		projectCode?: string;
		attachments?: { path: string; name: string; ref: string }[];
	}) {
		return messagingAdapter.sendMessage(msg);
	}

	async function getTicketSummary(): Promise<Record<string, number> | null> {
		if (!(await hasTickets()) || !ticketsDir) return null;
		const stages = ['fix', 'plan', 'implement', 'review', 'blocked', 'complete'];
		const counts: Record<string, number> = {};
		for (const stage of stages) {
			counts[stage] = await countMdFiles(join(ticketsDir, stage));
		}
		return counts;
	}

	async function getSibling(): Promise<{ name: string; url: string } | null> {
		if (!siblingDir || !(await dirExists(siblingDir))) return null;
		return { name: 'tess', url: `http://localhost:${siblingPort}` };
	}

	async function createMemo(memo: {
		title: string;
		content: string;
		importance: string;
		authorName: string;
		projectCodes?: string[];
		expiresAt?: string;
	}) {
		const memosPath = join(teamDir, 'memos.json');
		const data = await readJson(memosPath, { items: [] });
		const items: any[] = data.items ?? [];
		const newMemo = {
			title: memo.title,
			content: memo.content,
			postedAt: new Date().toISOString(),
			...(memo.expiresAt ? { expiresAt: memo.expiresAt } : {}),
			importance: memo.importance,
			authorName: memo.authorName,
			...(memo.projectCodes?.length ? { projectCodes: memo.projectCodes } : {}),
		};
		items.push(newMemo);
		data.items = items;
		await writeFile(memosPath, JSON.stringify(data, null, '\t'), 'utf-8');
		return newMemo;
	}

	async function archiveMemo(index: number) {
		const memosPath = join(teamDir, 'memos.json');
		const data = await readJson(memosPath, { items: [] });
		const items: any[] = data.items ?? [];
		if (index < 0 || index >= items.length) throw new Error('Invalid memo index');
		const [memo] = items.splice(index, 1);
		await writeFile(memosPath, JSON.stringify(data, null, '\t'), 'utf-8');
		const archivesDir = join(teamDir, 'archives');
		await mkdir(archivesDir, { recursive: true });
		const slug = memo.title ? slugify(memo.title) : Date.now().toString();
		let filename = `memo-${slug}.json`;
		try {
			await access(join(archivesDir, filename), constants.F_OK);
			filename = `memo-${slug}-${Date.now().toString(36)}.json`;
		} catch {
			/* no collision */
		}
		await writeFile(join(archivesDir, filename), JSON.stringify(memo, null, '\t'), 'utf-8');
		return { archivedAs: filename };
	}

	async function createMember(input: {
		name: string;
		title?: string;
		description?: string;
		type?: 'ai' | 'human';
		active?: boolean;
		roles?: string[];
		body?: string;
		email?: string;
	}) {
		const name = (input.name ?? '').trim();
		if (!isValidMemberName(name)) {
			throw new Error('Invalid member name (letters, digits, _ or - only; must start with a letter)');
		}

		const manifestPath = join(teamDir, 'members.json');
		const manifest = await readJson(manifestPath, { members: [] });
		const members: any[] = manifest.members ?? [];
		if (members.some((m: any) => m.name === name)) {
			throw new Error(`Member "${name}" already exists`);
		}

		const fields: ProfileFields = {
			title: input.title ?? '',
			description: input.description ?? '',
			type: input.type ?? 'ai',
			active: input.active ?? true,
			roles: input.roles ?? [],
		};

		const memberDir = join(teamDir, 'members', name);
		await mkdir(memberDir, { recursive: true });
		await mkdir(join(memberDir, 'inbox'), { recursive: true });
		await mkdir(join(memberDir, 'archives'), { recursive: true });

		const defaultBody = input.body?.trim() || `# ${name}\n\n${fields.description || ''}\n`;
		await writeFile(join(memberDir, 'profile.md'), renderProfileMd(name, fields, defaultBody), 'utf-8');
		await writeFile(join(memberDir, 'state.md'), '', 'utf-8');
		await writeFile(join(memberDir, 'todo.json'), JSON.stringify({ items: [] }, null, '\t'), 'utf-8');
		await writeFile(join(memberDir, 'schedule.json'), JSON.stringify({ events: [] }, null, '\t'), 'utf-8');
		await writeFile(join(memberDir, 'inbox.json'), JSON.stringify({ items: [] }, null, '\t'), 'utf-8');
		await writeFile(join(memberDir, 'sent.json'), JSON.stringify({ items: [] }, null, '\t'), 'utf-8');
		await writeFile(join(memberDir, 'archives.json'), JSON.stringify({ items: [] }, null, '\t'), 'utf-8');

		const entry: Record<string, unknown> = {
			name,
			title: fields.title ?? '',
			roles: fields.roles ?? [],
			active: fields.active ?? true,
			type: fields.type ?? 'ai',
		};
		if (input.email) entry.email = input.email.trim().toLowerCase();
		members.push(entry);
		manifest.members = members;
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`, 'utf-8');
		return entry;
	}

	async function updateMemberProfile(name: string, patch: ProfileFields & { body?: string; email?: string | null }) {
		const memberDir = join(teamDir, 'members', name);
		const profilePath = join(memberDir, 'profile.md');
		const existing = await readText(profilePath);
		if (!existing) throw new Error(`Member "${name}" not found`);
		const updated = updateFrontmatterFields(existing, patch);
		await writeFile(profilePath, updated, 'utf-8');

		const manifestPath = join(teamDir, 'members.json');
		const manifest = await readJson(manifestPath, { members: [] });
		const members: any[] = manifest.members ?? [];
		const idx = members.findIndex((m: any) => m.name === name);
		if (idx !== -1) {
			const entry = { ...members[idx] };
			if (patch.title !== undefined) entry.title = patch.title;
			if (patch.type !== undefined) entry.type = patch.type;
			if (patch.active !== undefined) entry.active = patch.active;
			if (patch.roles !== undefined) entry.roles = patch.roles;
			if (patch.email !== undefined) {
				if (patch.email === null || patch.email === '') entry.email = undefined;
				else entry.email = String(patch.email).trim().toLowerCase();
			}
			members[idx] = entry;
			manifest.members = members;
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`, 'utf-8');
		}
		return { ok: true };
	}

	async function deleteMember(name: string) {
		const manifestPath = join(teamDir, 'members.json');
		const manifest = await readJson(manifestPath, { members: [] });
		const members: any[] = manifest.members ?? [];
		const idx = members.findIndex((m: any) => m.name === name);
		if (idx === -1) throw new Error(`Member "${name}" not found`);
		members.splice(idx, 1);
		manifest.members = members;
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`, 'utf-8');

		const memberDir = join(teamDir, 'members', name);
		await rm(memberDir, { recursive: true, force: true });
		return { ok: true };
	}

	async function stopCycle(): Promise<{ ok: boolean }> {
		const stopFile = join(teamDir, '.stop');
		await writeFile(stopFile, '', 'utf-8');
		return { ok: true };
	}

	async function isStopPending(): Promise<boolean> {
		return dirExists(join(teamDir, '.stop'));
	}

	async function pauseCycle(): Promise<{ ok: boolean }> {
		await writeFile(join(teamDir, '.pause'), '', 'utf-8');
		return { ok: true };
	}

	async function resumeCycle(): Promise<{ ok: boolean }> {
		await unlink(join(teamDir, '.pause')).catch(() => {});
		return { ok: true };
	}

	async function isPaused(): Promise<boolean> {
		return dirExists(join(teamDir, '.pause'));
	}

	return {
		name: 'teamos-api',
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				if (!req.url?.startsWith('/api/')) return next();

				const url = new URL(req.url, `http://${req.headers.host}`);
				const path = url.pathname;
				const method = req.method?.toUpperCase() ?? 'GET';

				try {
					if (path === '/api/messaging/info' && method === 'GET') {
						return json(res, { adapter: messagingAdapterName, ...(attachments ? { attachments: attachments.limits } : {}) });
					}

					if (path === '/api/me' && method === 'GET') {
						return json(res, await resolveIdentity(req));
					}

					if (path === '/api/members' && method === 'GET') {
						return json(res, await getMemberSummaries());
					}

					if (path === '/api/members' && method === 'POST') {
						const body = JSON.parse(await readBody(req));
						return json(res, await createMember(body), 201);
					}

					if (path === '/api/memos' && method === 'GET') {
						return json(res, await readJson(join(teamDir, 'memos.json'), { items: [] }));
					}

					if (path === '/api/memos' && method === 'POST') {
						const memo = JSON.parse(await readBody(req));
						return json(res, await createMemo(memo), 201);
					}

					if (path.match(/^\/api\/memos\/(\d+)\/archive$/) && method === 'POST') {
						const idx = Number.parseInt(path.match(/^\/api\/memos\/(\d+)\/archive$/)![1], 10);
						return json(res, await archiveMemo(idx));
					}

					if (path === '/api/projects' && method === 'GET') {
						return json(res, await readJson(join(teamDir, 'projects.json'), { projects: [] }));
					}

					if (path === '/api/projects' && method === 'POST') {
						const input = JSON.parse(await readBody(req));
						const projectsPath = join(teamDir, 'projects.json');
						const data = await readJson(projectsPath, { projects: [] });
						const projects: any[] = data.projects ?? [];
						const code = String(input.code ?? '').trim();
						if (!code) throw new Error('Project code is required');
						if (projects.some((p: any) => p.code === code)) {
							throw new Error(`Project "${code}" already exists`);
						}
						const entry = {
							code,
							name: String(input.name ?? '').trim(),
							description: String(input.description ?? '').trim(),
							status: String(input.status ?? 'active').trim(),
						};
						projects.push(entry);
						data.projects = projects;
						await writeFile(projectsPath, `${JSON.stringify(data, null, '\t')}\n`, 'utf-8');
						return json(res, entry, 201);
					}

					const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
					if (projectMatch && (method === 'PATCH' || method === 'DELETE')) {
						const code = decodeURIComponent(projectMatch[1]);
						const projectsPath = join(teamDir, 'projects.json');
						const data = await readJson(projectsPath, { projects: [] });
						const projects: any[] = data.projects ?? [];
						const idx = projects.findIndex((p: any) => p.code === code);
						if (idx === -1) return json(res, { error: 'Project not found' }, 404);
						if (method === 'DELETE') {
							projects.splice(idx, 1);
						} else {
							const patchBody = JSON.parse(await readBody(req));
							const entry = { ...projects[idx] };
							if (patchBody.name !== undefined) entry.name = String(patchBody.name).trim();
							if (patchBody.description !== undefined) entry.description = String(patchBody.description).trim();
							if (patchBody.status !== undefined) entry.status = String(patchBody.status).trim();
							projects[idx] = entry;
						}
						data.projects = projects;
						await writeFile(projectsPath, `${JSON.stringify(data, null, '\t')}\n`, 'utf-8');
						return json(res, { ok: true });
					}

					if (path === '/api/org' && method === 'GET') {
						const content = await readText(join(teamDir, 'org.md'));
						return json(res, { content });
					}

					if (path === '/api/org' && method === 'PUT') {
						const { content } = JSON.parse(await readBody(req));
						await writeFile(join(teamDir, 'org.md'), content ?? '', 'utf-8');
						return json(res, { ok: true });
					}

					if (path === '/api/tickets' && method === 'GET') {
						return json(res, await getTicketSummary());
					}

					if (path === '/api/sibling' && method === 'GET') {
						return json(res, await getSibling());
					}

					if (path === '/api/cycle/stop' && method === 'POST') {
						return json(res, await stopCycle());
					}

					if (path === '/api/cycle/pause' && method === 'POST') {
						return json(res, await pauseCycle());
					}

					if (path === '/api/cycle/resume' && method === 'POST') {
						return json(res, await resumeCycle());
					}

					if (path === '/api/cycle/status' && method === 'GET') {
						return json(res, {
							stopPending: await isStopPending(),
							paused: await isPaused(),
						});
					}

					// ─── Chat (live conversation with a member) ──────────────
					//
					// Spawns an agent per turn and streams it back. The spawn
					// has the same tools a cycle does, so a chat can act on
					// what it decides — see teamos/docs/chat.md for why that no
					// longer needs a lock. These routes make the dashboard a
					// process-spawning surface, so they inherit the deployment
					// rule the dashboard already relies on: the port is
					// reachable only through the tailnet or the auth proxy in
					// front of it.
					if (path.startsWith('/api/chat/')) {
						if (!chat) return json(res, { error: 'Chat is not configured on this dashboard.' }, 501);
						// Chats the previous process saved come back before any route sees them.
						await chat.ready();

						if (path === '/api/chat/status' && method === 'GET') {
							const member = url.searchParams.get('member') ?? '';
							if (!member) return json(res, { error: 'member is required' }, 400);
							// `session` is the chat the polling tab has open: the poll is its
							// heartbeat, and the answer says what happened to it if it has gone.
							const sessionId = url.searchParams.get('session') || undefined;
							const status = await chat.status(member, { sessionId });
							if (status.session && !(await mayViewChat(req, status.session))) {
								status.session = { ...status.session, transcript: [], breaks: [], private: true };
								status.changedFiles = [];
							}
							return json(res, status);
						}

						if (path === '/api/chat/sessions' && method === 'POST') {
							const { member, human: claimedHuman, continueFrom, transcript } = JSON.parse(await readBody(req));
							const who = await enforceSender(req, claimedHuman);
							if ('error' in who) return json(res, { error: who.error }, 403);
							const session = await chat.create({ member, human: who.name, continueFrom, transcript });
							return json(res, chat.summarize(session), 201);
						}

						let chatMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/turn$/);
						if (chatMatch && method === 'POST') {
							const id = decodeURIComponent(chatMatch[1]);
							const { text } = JSON.parse(await readBody(req));
							const turnSession = chat.get(id); // 404 before the stream opens, not as an event inside it
							if (!(await mayViewChat(req, turnSession))) return json(res, { error: 'This chat belongs to someone else.' }, 403);
							const controller = new AbortController();
							// The client going away is the common case (tab closed,
							// navigated off mid-answer). Abort tree-kills the agent
							// rather than leaving it to bill out the idle timeout.
							// It is the *response* socket closing that reports this —
							// an aborted request does not always emit 'close' on req.
							// Firing again after a normal end is a no-op.
							const clientGone = () => controller.abort();
							req.on('close', clientGone);
							res.on('close', clientGone);
							const send = sse(res);
							try {
								const { exitCode, answer } = await chat.turn(id, text, {
									onEvent: (event) => send(event),
									signal: controller.signal,
								});
								send({ kind: 'done', exitCode, answer });
							} catch (err: any) {
								send({ kind: 'error', message: err.message, gone: err.gone });
							}
							return res.end();
						}

						chatMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)$/);
						if (chatMatch && method === 'GET') {
							const viewed = chat.get(decodeURIComponent(chatMatch[1]));
							if (!(await mayViewChat(req, viewed))) return json(res, { error: 'This chat belongs to someone else.' }, 403);
							return json(res, chat.summarize(viewed));
						}
						if (chatMatch && method === 'DELETE') {
							const id = decodeURIComponent(chatMatch[1]);
							if (!(await mayViewChat(req, chat.get(id)))) return json(res, { error: 'This chat belongs to someone else.' }, 403);
							const persist = url.searchParams.get('persist') !== '0';
							return json(res, await chat.end(id, { persist }));
						}

						return json(res, { error: 'Not found' }, 404);
					}

					// ─── Messages (id-scoped master store) ───────────────────
					if (path === '/api/messages' && method === 'POST') {
						const msg = JSON.parse(await readBody(req));
						const who = await enforceSender(req, msg.from);
						if ('error' in who) return json(res, { error: who.error }, 403);
						msg.from = who.name;
						// Images were uploaded first (POST /api/attachments); the message names
						// them by token. They are claimed for this sender, written next to the
						// message, and only then forgotten from the staging area.
						const tokens: string[] = Array.isArray(msg.attachments) ? msg.attachments.map(String) : [];
						if (msg.attachments != null) {
							if (!attachments) return json(res, { error: 'Attachments are not available' }, 400);
							msg.attachments = await attachments.claim(msg.attachments, msg.from);
						}
						const sent = await sendMessage(sendableFields(msg));
						if (attachments && tokens.length > 0) await attachments.release(tokens);
						return json(res, sent, 201);
					}

					// One image, as raw bytes (not JSON): the browser has it before the message exists.
					// ?name= is the file's name, ?from= the sender (replaced by the locked identity).
					if (path === '/api/attachments' && method === 'POST') {
						if (!attachments) return json(res, { error: 'Attachments are not available' }, 404);
						const who = await enforceSender(req, url.searchParams.get('from'));
						if ('error' in who) return json(res, { error: who.error }, 403);
						const bytes = await readBodyBytes(req, attachments.limits.maxBytes);
						const staged = await attachments.stage({ from: who.name, name: url.searchParams.get('name') ?? '', bytes });
						return json(res, staged, 201);
					}

					// A stored image: immutable (the name is unique to its message), typed by its
					// content, never executed (nosniff, a CSP that allows nothing but the image).
					const attachmentMatch = path.match(/^\/api\/messages\/([^/]+)\/attachments\/([^/]+)$/);
					if (attachmentMatch && method === 'GET' && attachments) {
						let id = '';
						let name = '';
						try {
							id = decodeURIComponent(attachmentMatch[1]);
							name = decodeURIComponent(attachmentMatch[2]);
						} catch {
							return json(res, { error: 'Not found' }, 404);
						}
						const file = await attachments.read(id, name);
						if (!file) return json(res, { error: 'Not found' }, 404);
						res.writeHead(200, {
							'Content-Type': file.mime,
							'Content-Length': file.bytes.length,
							'Content-Disposition': 'inline',
							'X-Content-Type-Options': 'nosniff',
							'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'none'; sandbox",
							'Cross-Origin-Resource-Policy': 'same-origin',
							'Cache-Control': 'private, max-age=31536000, immutable',
						});
						return res.end(file.bytes);
					}

					// A card tap: answers (or dismissals) to the questions of message :id. The answerer is the
					// signed-in member whatever the body says; the reply goes to the asker only (the cards and
					// lists show everyone the state); the plain-words body is written here so a reader of the bare
					// message, or an agent, sees what was chosen. The adapter checks who may answer and refuses a
					// bad entry with the reason (400).
					const answersMatch = path.match(/^\/api\/messages\/([^/]+)\/answers$/);
					if (answersMatch && method === 'POST') {
						const askId = decodeURIComponent(answersMatch[1]);
						const input = JSON.parse(await readBody(req));
						if (!input || typeof input !== 'object' || Array.isArray(input)) {
							return json(res, { error: 'Send a JSON object with an answers list' }, 400);
						}
						const who = await enforceSender(req, input.from);
						if ('error' in who) return json(res, { error: who.error }, 403);
						const ask = await messagingAdapter.readMessage(askId, { inlineParent: false }).catch(() => null);
						if (!ask) return json(res, { error: 'Not found' }, 404);
						if (!ask.questions?.length) return json(res, { error: 'That message asks no questions' }, 400);
						if (!Array.isArray(input.answers) || input.answers.length === 0) {
							return json(res, { error: 'No answers given' }, 400);
						}
						const malformed = input.answers.findIndex((a: unknown) => {
							if (!a || typeof a !== 'object' || Array.isArray(a)) return true;
							const e = a as Record<string, unknown>;
							return typeof e.q !== 'string' || (e.option != null && !Number.isInteger(e.option)) || (e.other != null && typeof e.other !== 'string');
						});
						if (malformed >= 0) {
							return json(res, { error: `answer ${malformed + 1} is malformed: give q and one of option (a number), other (text) or dismissed` }, 400);
						}
						const entries = input.answers.map((a: Record<string, unknown>) => ({
							ask: askId,
							q: a.q,
							...(a.option != null ? { option: a.option } : {}),
							...(a.other != null ? { other: a.other } : {}),
							...(a.dismissed === true ? { dismissed: true } : {}),
						}));
						const sent = await messagingAdapter.sendMessage({
							from: who.name,
							to: [ask.from],
							replyTo: askId,
							body: answersBody(ask, entries),
							answers: entries,
							// The body repeats the question text, which may name people (@nate): it is a record of the
							// tap, so it tags nobody.
							tags: false,
						});
						return json(res, sent, 201);
					}

					// What waits on a member (and what they are waiting for), derived from the messages.
					const waitingMatch = path.match(/^\/api\/members\/([^/]+)\/waiting$/);
					if (waitingMatch && method === 'GET') {
						const member = decodeURIComponent(waitingMatch[1]);
						if (!messagingAdapter.listQuestions) return json(res, { waitingOnMe: [], asked: [] });
						return json(res, await messagingAdapter.listQuestions(member));
					}

					// Bodies for a whole thread in one round trip — the dashboard opens
					// threads, not single messages.
					if (path === '/api/messages/batch' && method === 'POST') {
						const { ids } = JSON.parse(await readBody(req));
						const wanted: string[] = Array.isArray(ids) ? ids.slice(0, 500).map(String) : [];
						const read: Message[] = [];
						for (const id of wanted) {
							const msg = await readCachedMessage(id);
							if (msg) read.push(msg);
						}
						const asks = await foldedAsks(read);
						return json(res, await Promise.all(read.map((msg) => withLinks(msg, asks))));
					}

					let match = path.match(/^\/api\/messages\/([^/]+)$/);
					if (match && method === 'GET') {
						const id = decodeURIComponent(match[1]);
						try {
							const msg = await messagingAdapter.readMessage(id, { inlineParent: true });
							return json(res, await withLinks(msg, await foldedAsks([msg])));
						} catch {
							return json(res, { error: 'Not found' }, 404);
						}
					}

					// ─── Member detail & mailboxes ───────────────────────────
					match = path.match(/^\/api\/members\/([^/]+)$/);
					if (match && method === 'GET') {
						return json(res, await getMemberDetail(decodeURIComponent(match[1])));
					}
					if (match && method === 'DELETE') {
						return json(res, await deleteMember(decodeURIComponent(match[1])));
					}

					match = path.match(/^\/api\/members\/([^/]+)\/profile$/);
					if (match && method === 'PATCH') {
						const name = decodeURIComponent(match[1]);
						const body = JSON.parse(await readBody(req));
						return json(res, await updateMemberProfile(name, body));
					}

					match = path.match(/^\/api\/members\/([^/]+)\/threads$/);
					if (match && method === 'GET') {
						return json(res, await buildThreads(decodeURIComponent(match[1])));
					}

					// ─── Agent logs (read-only) ──────────────────────────────
					//
					// The reader checks both names against strict patterns and
					// confirms the resolved path is a plain file inside .logs/ —
					// see scripts/lib/logs.mjs.
					match = path.match(/^\/api\/members\/([^/]+)\/logs$/);
					if (match && method === 'GET') {
						if (!logs) return json(res, { error: 'Logs are not configured on this dashboard.' }, 501);
						return json(res, await logs.list(decodeURIComponent(match[1])));
					}

					match = path.match(/^\/api\/members\/([^/]+)\/logs\/([^/]+)$/);
					if (match && method === 'GET') {
						if (!logs) return json(res, { error: 'Logs are not configured on this dashboard.' }, 501);
						const num = (key: string) => {
							const raw = url.searchParams.get(key);
							return raw === null || raw === '' ? undefined : Number(raw);
						};
						return json(
							res,
							await logs.read(decodeURIComponent(match[1]), decodeURIComponent(match[2]), {
								tail: num('tail'),
								from: num('from'),
								to: num('to'),
							}),
						);
					}

					match = path.match(/^\/api\/members\/([^/]+)\/inbox$/);
					if (match && method === 'GET') {
						return json(res, await messagingAdapter.listInbox(decodeURIComponent(match[1])));
					}

					match = path.match(/^\/api\/members\/([^/]+)\/sent$/);
					if (match && method === 'GET') {
						return json(res, await messagingAdapter.listSent(decodeURIComponent(match[1])));
					}

					match = path.match(/^\/api\/members\/([^/]+)\/archives$/);
					if (match && method === 'GET') {
						return json(res, await messagingAdapter.listArchives(decodeURIComponent(match[1])));
					}

					match = path.match(/^\/api\/members\/([^/]+)\/inbox\/([^/]+)\/archive$/);
					if (match && method === 'POST') {
						const name = decodeURIComponent(match[1]);
						const id = decodeURIComponent(match[2]);
						await messagingAdapter.archiveMessage(name, id);
						return json(res, { ok: true });
					}

					// "Needs me": pin an inbox message so it stays in Needs you; archiving it clears the pin.
					match = path.match(/^\/api\/members\/([^/]+)\/pins\/([^/]+)$/);
					if (match && (method === 'POST' || method === 'DELETE')) {
						const name = decodeURIComponent(match[1]);
						const id = decodeURIComponent(match[2]);
						const act = method === 'POST' ? messagingAdapter.pinMessage : messagingAdapter.unpinMessage;
						if (!act) return json(res, { error: 'This messaging adapter has no pins.' }, 501);
						await act.call(messagingAdapter, name, id);
						return json(res, { ok: true });
					}

					// Done search: which of the member's archived messages contain the text (ids only).
					match = path.match(/^\/api\/members\/([^/]+)\/search$/);
					if (match && method === 'GET') {
						if (!messagingAdapter.searchArchives) return json(res, { ids: [] });
						const q = url.searchParams.get('q') ?? '';
						return json(res, { ids: await messagingAdapter.searchArchives(decodeURIComponent(match[1]), q, { limit: 500 }) });
					}

					match = path.match(/^\/api\/members\/([^/]+)\/archives\/([^/]+)\/unarchive$/);
					if (match && method === 'POST') {
						const name = decodeURIComponent(match[1]);
						const id = decodeURIComponent(match[2]);
						await messagingAdapter.unarchiveMessage(name, id);
						return json(res, { ok: true });
					}

					match = path.match(/^\/api\/members\/([^/]+)\/inbox\/([^/]+)$/);
					if (match && method === 'DELETE') {
						const name = decodeURIComponent(match[1]);
						const id = decodeURIComponent(match[2]);
						await messagingAdapter.deleteInboxMessage(name, id);
						return json(res, { ok: true });
					}

					match = path.match(/^\/api\/members\/([^/]+)\/archives\/([^/]+)$/);
					if (match && method === 'DELETE') {
						const name = decodeURIComponent(match[1]);
						const id = decodeURIComponent(match[2]);
						await messagingAdapter.deleteArchivedMessage(name, id);
						return json(res, { ok: true });
					}

					match = path.match(/^\/api\/members\/([^/]+)\/todos$/);
					if (match) {
						const name = decodeURIComponent(match[1]);
						const todosPath = join(teamDir, 'members', name, 'todo.json');
						if (method === 'GET') return json(res, await readJson(todosPath, { items: [] }));
						if (method === 'PUT') {
							const data = JSON.parse(await readBody(req));
							await writeFile(todosPath, JSON.stringify(data, null, '\t'), 'utf-8');
							return json(res, { ok: true });
						}
					}

					match = path.match(/^\/api\/members\/([^/]+)\/state$/);
					if (match && method === 'PUT') {
						const name = decodeURIComponent(match[1]);
						const { state } = JSON.parse(await readBody(req));
						await writeFile(join(teamDir, 'members', name, 'state.md'), state, 'utf-8');
						return json(res, { ok: true });
					}

					match = path.match(/^\/api\/members\/([^/]+)\/schedule$/);
					if (match) {
						const name = decodeURIComponent(match[1]);
						if (method === 'GET') {
							const events = await scheduleAdapter.listEvents(name);
							return json(res, { events });
						}
						if (method === 'POST') {
							const input = JSON.parse(await readBody(req));
							const { id } = await scheduleAdapter.addEvent(name, input);
							return json(res, { id }, 201);
						}
					}

					match = path.match(/^\/api\/members\/([^/]+)\/schedule\/([^/]+)$/);
					if (match) {
						const name = decodeURIComponent(match[1]);
						const id = decodeURIComponent(match[2]);
						if (method === 'PATCH') {
							const patch = JSON.parse(await readBody(req));
							await scheduleAdapter.updateEvent(name, id, patch);
							return json(res, { ok: true });
						}
						if (method === 'DELETE') {
							await scheduleAdapter.removeEvent(name, id);
							return json(res, { ok: true });
						}
					}

					json(res, { error: 'Not found' }, 404);
				} catch (err: any) {
					// A 4xx is the client's mistake (a bad log name probing for
					// a way out of .logs/, say) — one line, not a stack.
					if (err.status && err.status < 500) console.warn('[teamos-api]', method, path, err.status, err.message);
					else console.error('[teamos-api]', err);
					// Chat and log errors carry the status they mean (404 unknown
					// member or log, 409 a chat already open, 400 a bad log name, 410
					// a chat that has ended); everything else is a 500. A chat that
					// has gone says what happened to it, so the pane can offer to
					// continue it.
					if (res.headersSent) res.end();
					else json(res, { error: err.message, ...(err.gone ? { gone: err.gone } : {}) }, err.status ?? 500);
				}
			});
		},
	};
}
