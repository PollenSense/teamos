<script lang="ts">
import { onDestroy, tick } from 'svelte';
import { api } from '../lib/api.js';
import {
	type AttachmentLimits,
	LONG_SIDE,
	appendBlock,
	insertAt,
	pastedName,
	placeholder,
	prepareImage,
	removePlaceholder,
	swapPlaceholderRef,
} from '../lib/attachments.js';
import Markdown from './Markdown.svelte';
import { identity } from '../lib/identity.svelte.js';
import { activeTag, completeTag, insertAtSign, previewTags, suggestions } from '../lib/mentions.js';
import { router } from '../lib/router.svelte.js';
import type { MemberSummary, Message, Project } from '../lib/types.js';

let members = $state<MemberSummary[]>([]);
let projects = $state<Project[]>([]);
let loading = $state(true);
let sending = $state(false);
let sent = $state(false);
/** Who the server added to Cc because the body tagged them (from the send result). */
let addedToCc = $state<string[]>([]);
let sendError = $state<string | null>(null);

let to = $state<Set<string>>(new Set());
let cc = $state<Set<string>>(new Set());
let from = $state(identity.name ?? '');
let subject = $state('');
let projectCode = $state('');
let body = $state('');

/** One image on its way with this message; `ref` is what the body's placeholder says until the upload gives a token. */
interface Attached {
	key: string;
	ref: string;
	name: string;
	size: number;
	/** Preview for the tray (an object URL; revoked when the image leaves). */
	url: string;
	status: 'working' | 'ready' | 'failed';
	token?: string;
	error?: string;
}

let limits = $state<AttachmentLimits | null>(null);
let attached = $state<Attached[]>([]);
let attachNotice = $state<string | null>(null);
let dragging = $state(false);
let bodyEl = $state<HTMLTextAreaElement | null>(null);
let picker = $state<HTMLInputElement | null>(null);
let imageCounter = 0;

// ─── @tags ───────────────────────────────────────────────────────────────────
// Typing `@` shows the matching members as tap targets above the box. The server decides who a message tags
// (lib/mentions.ts repeats its rule for this preview); a tagged member who is not on the message is added to Cc.
let caret = $state(0);
let pick = $state(0);
/** The `@` index whose strip the person closed with Esc; the strip stays shut for that tag only. */
let closedAt = $state<number | null>(null);

const tag = $derived(activeTag(body, caret));
const options = $derived(tag ? suggestions(tag.query, members, { sender: from, limit: 14 }) : []);
const stripOpen = $derived(!!tag && options.length > 0 && closedAt !== tag.start);
const tagged = $derived(previewTags(body, members, { sender: from, to: [...to], cc: [...cc] }));

$effect(() => {
	void tag?.query;
	pick = 0;
});
$effect(() => {
	if (!tag) closedAt = null;
});

function syncCaret() {
	caret = bodyEl?.selectionStart ?? body.length;
}

async function chooseTag(name: string) {
	if (!tag) return;
	const done = completeTag(body, tag, name);
	body = done.text;
	await tick();
	bodyEl?.focus();
	bodyEl?.setSelectionRange(done.caret, done.caret);
	caret = done.caret;
}

/** The "@ Tag" button: for keyboards where `@` is a page away. */
async function typeAt() {
	const done = insertAtSign(body, bodyEl?.selectionStart ?? body.length);
	body = done.text;
	closedAt = null;
	await tick();
	bodyEl?.focus();
	bodyEl?.setSelectionRange(done.caret, done.caret);
	caret = done.caret;
}

function onBodyKey(e: KeyboardEvent) {
	if (!stripOpen) return;
	if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
		e.preventDefault();
		pick = (pick + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
	} else if (e.key === 'Enter' || e.key === 'Tab') {
		e.preventDefault();
		void chooseTag(options[Math.min(pick, options.length - 1)].name);
	} else if (e.key === 'Escape' && tag) {
		e.preventDefault();
		closedAt = tag.start;
	}
}

const working = $derived(attached.some((a) => a.status === 'working'));

let replyMessage = $state<Message | null>(null);
let inboxOwner = $state<string | null>(null);
let isReplyAll = $state(false);

const isReply = $derived(!!replyMessage);
const backPath = $derived.by(() => {
	if (!inboxOwner) return '/';
	const msg = replyMessage;
	return msg ? `/member/${inboxOwner}?msg=${encodeURIComponent(msg.id)}` : `/member/${inboxOwner}`;
});

$effect(() => {
	if (identity.name && !from) from = identity.name;
});

async function load() {
	const [m, p, info] = await Promise.all([
		api.members(),
		api.projects(),
		api.messagingInfo().catch(() => null),
	]);
	members = m;
	projects = p.projects ?? [];
	limits = info?.attachments ?? null;

	const re = router.query.re;
	const inbox = router.query.inbox;
	const replyAll = router.query.all === '1';
	isReplyAll = replyAll;
	if (re) {
		inboxOwner = inbox ?? null;
		try {
			replyMessage = await api.message(re);
			if (replyMessage.projectCode) projectCode = replyMessage.projectCode;
			const self = inboxOwner;
			const toSet = new Set<string>([replyMessage.from]);
			const ccSet = new Set<string>();
			if (replyAll) {
				for (const r of replyMessage.to ?? []) if (r !== self) toSet.add(r);
				for (const r of replyMessage.cc ?? []) if (r !== self) ccSet.add(r);
			}
			if (self) toSet.delete(self);
			to = toSet;
			cc = ccSet;
			// Subject auto-derives server-side, but show a preview to the user
			if (!subject) {
				const stripped = (replyMessage.subject ?? '').replace(/^(re:\s*)+/i, '').trim();
				subject = stripped ? `Re: ${stripped}` : '';
			}
		} catch {
			/* original may have been deleted */
		}
	}

	loading = false;
}

$effect(() => {
	load();
});

function toggle(set: Set<string>, name: string): Set<string> {
	const next = new Set(set);
	if (next.has(name)) next.delete(name);
	else next.add(name);
	return next;
}

function toggleTo(name: string) {
	to = toggle(to, name);
}
function toggleCc(name: string) {
	cc = toggle(cc, name);
}

function selectAllAI() {
	to = new Set(members.filter((m) => m.type === 'ai').map((m) => m.name));
}

async function send() {
	if (to.size === 0 || !body.trim() || !from.trim() || working) return;
	const readyTokens = attached.flatMap((a) => (a.status === 'ready' && a.token ? [a.token] : []));
	sending = true;
	sendError = null;
	try {
		const result = await api.sendMessage({
			from,
			to: [...to],
			cc: cc.size > 0 ? [...cc] : undefined,
			subject: subject || undefined,
			body: body.trim(),
			replyTo: replyMessage?.id,
			projectCode: projectCode || undefined,
			attachments: readyTokens.length > 0 ? readyTokens : undefined,
		});
		addedToCc = result.addedToCc ?? [];
	} catch (err) {
		sendError = err instanceof Error ? err.message : String(err);
		sending = false;
		return;
	}
	sending = false;
	dropAttached();
	if (isReply) {
		router.navigate(backPath);
		return;
	}
	sent = true;
}

// ─── Images ──────────────────────────────────────────────────────────────────

function megabytes(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function extFor(type: string): string {
	if (type === 'image/jpeg') return 'jpg';
	return type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
}

/** Add images to the message: a paste puts them at the caret, a pick or a drop at the end. */
async function addFiles(files: File[], where: 'caret' | 'end') {
	attachNotice = null;
	if (!limits) return;
	let caret = where === 'caret' ? (bodyEl?.selectionStart ?? body.length) : body.length;
	for (const file of files) {
		const held = attached.filter((a) => a.status !== 'failed');
		if (held.length >= limits.maxCount) {
			attachNotice = `At most ${limits.maxCount} images per message`;
			break;
		}
		const key = `pending-${++imageCounter}`;
		const generic = !file.name || /^image\.[a-z0-9]+$/i.test(file.name);
		const name = generic ? pastedName(new Date(), extFor(file.type), imageCounter) : file.name;
		attached = [...attached, { key, ref: key, name, size: file.size, url: URL.createObjectURL(file), status: 'working' }];
		const placed = where === 'caret' ? insertAt(body, caret, placeholder(name, key)) : appendBlock(body, placeholder(name, key));
		body = placed.body;
		caret = placed.caret;
		void upload(key, file, name);
	}
	await tick();
	if (bodyEl && where === 'caret') {
		bodyEl.focus();
		bodyEl.setSelectionRange(caret, caret);
	}
}

async function upload(key: string, file: File, name: string) {
	const find = () => attached.find((a) => a.key === key);
	try {
		const prepared = await prepareImage(file, limits as AttachmentLimits, name);
		const item = find();
		if (!item) return; // taken out while it was being prepared
		if (prepared.reencoded) {
			URL.revokeObjectURL(item.url);
			item.url = URL.createObjectURL(prepared.blob);
		}
		item.size = prepared.blob.size;
		const others = attached.filter((a) => a.key !== key && a.status !== 'failed').reduce((sum, a) => sum + a.size, 0);
		if (others + prepared.blob.size > (limits as AttachmentLimits).maxTotalBytes) {
			throw new Error(`Too much image data for one message (the limit is ${megabytes((limits as AttachmentLimits).maxTotalBytes)})`);
		}
		const staged = await api.uploadAttachment(prepared.blob, prepared.name, from);
		const after = find();
		if (!after) return;
		after.token = staged.token;
		after.name = staged.name;
		after.ref = staged.token;
		after.status = 'ready';
		body = swapPlaceholderRef(body, key, staged.token);
	} catch (err) {
		const item = find();
		if (!item) return;
		item.status = 'failed';
		item.error = err instanceof Error ? err.message : String(err);
		body = removePlaceholder(body, item.ref);
	}
}

function removeAttached(item: Attached) {
	body = removePlaceholder(body, item.ref);
	URL.revokeObjectURL(item.url);
	attached = attached.filter((a) => a.key !== item.key);
	attachNotice = null;
}

function dropAttached() {
	for (const a of attached) URL.revokeObjectURL(a.url);
	attached = [];
	attachNotice = null;
}

function imagesIn(list: FileList | null | undefined): File[] {
	return [...(list ?? [])].filter((f) => f.type.startsWith('image/') || (!f.type && /\.(heic|heif)$/i.test(f.name)));
}

function onPaste(e: ClipboardEvent) {
	const files = imagesIn(e.clipboardData?.files);
	if (files.length === 0 || !limits) return; // plain text paste: leave it alone
	e.preventDefault();
	void addFiles(files, 'caret');
}

function onDrop(e: DragEvent) {
	dragging = false;
	if (!limits) return;
	const files = imagesIn(e.dataTransfer?.files);
	if (files.length === 0) return;
	e.preventDefault();
	void addFiles(files, 'end');
}

function onDragOver(e: DragEvent) {
	if (!limits || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
	e.preventDefault();
	dragging = true;
}

function onPick(e: Event) {
	const input = e.currentTarget as HTMLInputElement;
	const files = imagesIn(input.files);
	input.value = ''; // picking the same file again must fire again
	if (files.length > 0) void addFiles(files, 'end');
}

onDestroy(dropAttached);

function reset() {
	to = new Set();
	cc = new Set();
	subject = '';
	projectCode = '';
	body = '';
	caret = 0;
	addedToCc = [];
	sent = false;
	sendError = null;
	dropAttached();
	replyMessage = null;
	inboxOwner = null;
	isReplyAll = false;
}
</script>

<div class="compose">
	<div class="compose-header">
		<button class="back" onclick={() => router.navigate(backPath)}>← Back</button>
		<h1 class="compose-title">{isReply ? (isReplyAll ? 'Reply All' : 'Reply') : 'Compose Message'}</h1>
	</div>

	{#if sent}
		<div class="sent-confirmation">
			<div class="sent-icon">&#10003;</div>
			<p>Message sent to {[...to].join(', ')}</p>
			{#if addedToCc.length > 0}
				<p class="sent-tagged">Tagged and added to Cc: {addedToCc.join(', ')}</p>
			{/if}
			<div class="sent-actions">
				<button class="btn btn-primary" onclick={reset}>Compose Another</button>
				<button class="btn btn-ghost" onclick={() => router.navigate(backPath)}>
					{inboxOwner ? `Back to ${inboxOwner}` : 'Back to Dashboard'}
				</button>
			</div>
		</div>
	{:else if loading}
		<div class="loading">Loading...</div>
	{:else}
		<div class="form-group">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label class="label">To</label>
			<div class="recipients">
				{#each members as member}
					<button
						class="recipient"
						class:selected={to.has(member.name)}
						onclick={() => toggleTo(member.name)}
					>
						{member.name}
						{#if identity.name === member.name}
							<span class="recipient-type">(you)</span>
						{/if}
					</button>
				{/each}
				<button class="recipient select-all" onclick={selectAllAI}>All AI</button>
			</div>
		</div>

		<div class="form-group">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label class="label">Cc (optional)</label>
			<div class="recipients">
				{#each members as member}
					<button
						class="recipient"
						class:selected={cc.has(member.name)}
						onclick={() => toggleCc(member.name)}
						disabled={to.has(member.name)}
					>
						{member.name}
					</button>
				{/each}
				{#each tagged.addedToCc as name (name)}
					<span class="recipient tagged-chip" title="Tagged in the message: added to Cc when you send">+ {name} (tagged)</span>
				{/each}
			</div>
		</div>

		<div class="form-row">
			<div class="form-group" style="flex:1">
				<label class="label" for="from">From</label>
				<input id="from" type="text" bind:value={from} placeholder="Your name" />
			</div>
			<div class="form-group" style="flex:2">
				<label class="label" for="subject">
					Subject {isReply ? '(optional — derived from parent)' : ''}
				</label>
				<input id="subject" type="text" bind:value={subject} placeholder="Thread subject" />
			</div>
		</div>

		<div class="form-row">
			<div class="form-group" style="flex:1">
				<label class="label" for="project">Project</label>
				<select id="project" bind:value={projectCode}>
					<option value="">None</option>
					{#each projects as project}
						<option value={project.code}>{project.name} ({project.code})</option>
					{/each}
				</select>
			</div>
		</div>

		{#if replyMessage}
			<div class="reply-context">
				<div class="reply-context-header">
					<span class="reply-label">Replying to</span>
					<span class="reply-from">{replyMessage.from}</span>
					<span class="reply-date">{new Date(replyMessage.sentAt).toLocaleString()}</span>
					{#if replyMessage.subject}
						<span class="reply-subject">{replyMessage.subject}</span>
					{/if}
				</div>
				<div class="reply-body"><Markdown source={replyMessage.body} links={replyMessage.links} mentions={replyMessage.mentions} /></div>
			</div>
		{/if}

		{#if replyMessage?.questionState?.some((q) => q.status === 'open')}
			<div class="question-hint" role="note">
				The message you are answering has open questions. Answer them with the cards in the message, or type here and the sender will record your reply.
			</div>
		{/if}

		<div class="form-group">
			<label class="label" for="body">Message</label>
			{#if stripOpen}
				<div class="tag-strip" role="listbox" aria-label="Tag a member" data-testid="tag-strip">
					{#each options as option, i (option.name)}
						<button
							type="button"
							class="tag-option"
							class:picked={i === pick}
							role="option"
							aria-selected={i === pick}
							onmousedown={(e) => e.preventDefault()}
							onclick={() => chooseTag(option.name)}
						>
							<span class="tag-name">@{option.name}</span>
							{#if option.title}<span class="tag-title">{option.title}</span>{/if}
						</button>
					{/each}
				</div>
			{/if}
			<textarea
				id="body"
				bind:this={bodyEl}
				bind:value={body}
				onkeydown={onBodyKey}
				onkeyup={syncCaret}
				onclick={syncCaret}
				oninput={syncCaret}
				onfocus={syncCaret}
				rows="10"
				class:dragging
				placeholder={limits
					? 'Write your message (markdown supported). Paste or drop images here.'
					: 'Write your message (markdown supported)...'}
				onpaste={onPaste}
				ondragover={onDragOver}
				ondragleave={() => (dragging = false)}
				ondrop={onDrop}
			></textarea>
			<div class="attach-bar">
				<button type="button" class="btn btn-ghost add-image tag-button" onclick={typeAt} onmousedown={(e) => e.preventDefault()}>@ Tag</button>
				{#if limits}
					<button type="button" class="btn btn-ghost add-image" onclick={() => picker?.click()}>Add image</button>
					<input
						bind:this={picker}
						type="file"
						accept="image/*"
						multiple
						hidden
						onchange={onPick}
					/>
					<span class="attach-hint">png, jpg, gif, webp; photos are shrunk to {LONG_SIDE}px; up to {limits.maxCount} per message, {megabytes(limits.maxBytes)} each</span>
				{/if}
			</div>
			{#if tagged.mentioned.length > 0}
				<div class="tag-note" role="status" data-testid="tag-note">
					Tagged {tagged.mentioned.map((n) => `@${n}`).join(', ')}.
					{#if tagged.addedToCc.length > 0}{tagged.addedToCc.join(', ')} will be added to Cc.{/if}
					They see it in Needs you until they reply.
				</div>
			{/if}
			{#if limits}
				{#if attachNotice}
					<div class="attach-notice" role="status">{attachNotice}</div>
				{/if}
				{#if attached.length > 0}
					<ul class="tray">
						{#each attached as item (item.key)}
							<li class="tray-item" class:failed={item.status === 'failed'}>
								<img class="thumb" src={item.url} alt="" />
								<span class="tray-name">{item.name}</span>
								<span class="tray-meta">
									{#if item.status === 'working'}Uploading...{:else if item.status === 'failed'}{item.error}{:else}{megabytes(item.size)}{/if}
								</span>
								<button
									type="button"
									class="tray-remove"
									aria-label={`Remove ${item.name}`}
									onclick={() => removeAttached(item)}
								>&times;</button>
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</div>

		{#if sendError}
			<div class="send-error" role="alert">
				<strong>Send failed:</strong> {sendError}
			</div>
		{/if}

		<div class="form-actions">
			<button
				class="btn btn-primary"
				onclick={send}
				disabled={to.size === 0 || !body.trim() || !from.trim() || sending || working || (!isReply && !subject.trim())}
			>
				{sending ? 'Sending...' : working ? 'Uploading images...' : `Send to ${to.size} recipient${to.size !== 1 ? 's' : ''}`}
			</button>
		</div>
	{/if}
</div>

<style>
	.compose { max-width: 720px; }
	.compose-header {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}
	.back {
		color: var(--text-muted);
		font-size: 0.875rem;
		padding: 0.375rem 0.75rem;
		border-radius: var(--radius);
		transition: all var(--transition);
	}
	.back:hover { background: var(--surface); color: var(--text); }
	.compose-title { font-size: 1.25rem; font-weight: 700; }
	.loading { text-align: center; padding: 3rem; color: var(--text-muted); }

	.form-group { margin-bottom: 1rem; }
	.form-row { display: flex; gap: 1rem; }
	.label {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-muted);
		margin-bottom: 0.375rem;
	}

	.recipients { display: flex; gap: 0.375rem; flex-wrap: wrap; }
	.recipient {
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: 99px;
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--text-muted);
		transition: all var(--transition);
		background: var(--surface);
	}
	.recipient:hover:not(:disabled) { border-color: var(--primary); color: var(--text); }
	.recipient.selected {
		background: var(--primary);
		color: var(--on-primary);
		border-color: var(--primary);
	}
	.recipient:disabled { opacity: 0.4; cursor: not-allowed; }
	.recipient-type { font-size: 0.7rem; opacity: 0.7; }
	.recipient.select-all {
		border-style: dashed;
		color: var(--primary);
	}
	.recipient.select-all:hover {
		background: var(--primary-subtle);
	}

	input, select, textarea {
		width: 100%;
	}

	.form-actions { margin-top: 1.5rem; }

	.question-hint {
		margin-bottom: 0.75rem;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius);
		border: 1px solid #d97706;
		background: rgba(217, 119, 6, 0.08);
		font-size: 0.8rem;
		color: #b45309;
	}
	textarea.dragging { outline: 2px dashed var(--primary); outline-offset: -2px; }
	.attach-bar { display: flex; align-items: center; gap: 0.75rem; margin-top: 0.375rem; flex-wrap: wrap; }
	.add-image {
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-size: 0.8rem;
	}
	.attach-hint { font-size: 0.75rem; color: var(--text-muted); }

	/* @tags: the members to tap sit in a scrolling row above the box, so the phone keyboard never covers them. */
	.tag-strip {
		display: flex;
		gap: 0.375rem;
		overflow-x: auto;
		padding-bottom: 0.375rem;
		margin-bottom: 0.125rem;
		-webkit-overflow-scrolling: touch;
	}
	.tag-option {
		flex: none;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		min-height: 44px;
		padding: 0.3rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		text-align: left;
	}
	.tag-option.picked, .tag-option:hover { border-color: var(--primary); background: var(--primary-subtle); }
	.tag-name { font-size: 0.85rem; font-weight: 600; color: var(--text); }
	.tag-title { font-size: 0.7rem; color: var(--text-muted); white-space: nowrap; }
	.tag-button { font-weight: 600; color: var(--primary); }
	.tag-note {
		margin-top: 0.375rem;
		padding: 0.375rem 0.625rem;
		border-radius: var(--radius);
		border: 1px dashed var(--primary);
		background: var(--primary-subtle);
		font-size: 0.8rem;
		color: var(--text);
	}
	.recipient.tagged-chip { border-style: dashed; color: var(--primary); cursor: default; }
	.sent-tagged { font-size: 0.9rem; color: var(--text-muted); margin-top: -1rem; }
	.attach-notice { margin-top: 0.375rem; font-size: 0.8rem; color: var(--danger, #dc2626); }
	.tray { list-style: none; margin: 0.5rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.375rem; }
	.tray-item {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.375rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		font-size: 0.8rem;
	}
	.tray-item.failed { border-color: var(--danger, #dc2626); }
	.thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 4px; flex: none; background: var(--bg); }
	.tray-name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.tray-meta { color: var(--text-muted); margin-left: auto; text-align: right; }
	.tray-item.failed .tray-meta { color: var(--danger, #dc2626); }
	.tray-remove { font-size: 1.1rem; line-height: 1; padding: 0.25rem 0.5rem; color: var(--text-muted); border-radius: var(--radius); }
	.tray-remove:hover { background: var(--bg); color: var(--text); }

	.send-error {
		margin-top: 1rem;
		padding: 0.75rem 1rem;
		border-radius: var(--radius);
		background: var(--danger-subtle, rgba(220, 38, 38, 0.1));
		color: var(--danger, #dc2626);
		border: 1px solid var(--danger, #dc2626);
		font-size: 0.875rem;
		word-break: break-word;
	}

	.btn {
		padding: 0.625rem 1.25rem;
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.875rem;
		transition: all var(--transition);
	}
	.btn-primary {
		background: var(--primary);
		color: var(--on-primary);
	}
	.btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost {
		color: var(--text-muted);
	}
	.btn-ghost:hover { background: var(--bg); color: var(--text); }

	.reply-context {
		background: var(--bg);
		border: 1px solid var(--border);
		border-left: 3px solid var(--primary);
		border-radius: var(--radius);
		padding: 0.75rem 1rem;
		margin-bottom: 1rem;
	}
	.reply-context-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
		font-size: 0.8rem;
	}
	.reply-label {
		color: var(--text-muted);
		font-weight: 500;
	}
	.reply-from { font-weight: 600; }
	.reply-date { color: var(--text-muted); }
	.reply-subject {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.06rem 0.4rem;
		border-radius: 99px;
		background: var(--primary-subtle);
		color: var(--primary);
	}
	.reply-body {
		font-family: var(--font);
		font-size: 0.825rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-wrap: break-word;
		color: var(--text-muted);
		max-height: 200px;
		overflow-y: auto;
		margin: 0;
	}

	.sent-confirmation {
		text-align: center;
		padding: 3rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
	}
	.sent-icon {
		width: 48px;
		height: 48px;
		border-radius: 50%;
		background: var(--success-subtle);
		color: var(--success);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 1.5rem;
		font-weight: 700;
		margin-bottom: 1rem;
	}
	.sent-confirmation p {
		font-size: 1.1rem;
		font-weight: 600;
		margin-bottom: 1.5rem;
	}
	.sent-actions { display: flex; gap: 0.75rem; justify-content: center; }
</style>
