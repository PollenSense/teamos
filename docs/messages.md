# Messaging Architecture

TeamOS messages behave like email: a message can target multiple parties, carry a subject, and reference a preceding message to form a thread. The protocol is designed so it could later be backed by real email (SMTP/IMAP) without changing the agent-facing contract.

Only one adapter ships today: the **file adapter**, which stores messages on the local filesystem inside the `team/` workspace. The messaging interface (see "MCP Tools" below) is the stable contract; future adapters implement the same surface.

## Design Principles

- **Email-like semantics** — a message has `from`, `to`, `cc`, `subject`, `body`, and an optional `replyTo` back-pointer. To and Cc are delivered identically; they differ in how recipients perceive their involvement and in the priority the runner gives the message (see Work Detection).
- **Subjects are required** on new threads. Replies auto-derive `Re: <subject>` from their parent.
- **Threads are backward chains, not containers.** There is no thread object — a thread is simply the transitive closure of `replyTo` pointers. This matches how email works and keeps the data model flat.
- **Single master store.** Every message lives in one file under `team/messages/`, addressed by a unique id. Per-member mailboxes are just lists of ids; content is never duplicated.
- **Agent-managed inbox.** There is no unread pointer. A message is either in a member's `inbox.json` or their `archives.json` — never both. Members maintain their inboxes as part of their cycle work.
- **One hop of context is free.** `read_message(id)` inlines the immediately preceding message as a real nested object (same shape, minus its own parent). Deeper history is reached by calling `read_message` again with `parent.id`.
- **Ids are opaque to agents.** The format is an implementation detail. Agents pass ids through — they do not parse them.
- **Supersede over stack.** When a sender has more to say to the same audience on the same topic, they consolidate via `supersede_message` instead of stacking another message. The new message points back via `supersedes: [...]`; each predecessor is rewritten with `supersededBy` and silently removed from any recipient inbox where it was still unread. Recipients who already archived the predecessor keep it (audit trail) and see the new message arrive separately. Listings collapse a predecessor whenever the consolidated version is reachable in the same mailbox.

## On-Disk Layout

```
team/
├── messages/
│   ├── <id>.md               # master store — one file per message
│   └── attachments/
│       └── <id>/<name>.png   # images sent with that message (png, jpg, gif, webp)
└── members/
    └── <name>/
        ├── inbox.json        # { "items": ["<id>", ...] }
        ├── sent.json         # { "items": ["<id>", ...] }
        └── archives.json     # { "items": ["<id>", ...] }
```

### Message ID format

```
<isoTimestamp>-<4charRand>
```

Example: `2026-04-13T10-30-45.123Z-a3f2`

- ISO-8601 timestamp with colons replaced by hyphens for filesystem safety
- Four random base-36 characters to disambiguate concurrent sends in the same millisecond
- Lexically sortable by send time, which makes inbox listings and store browsing natural
- Agents never construct or parse these — `send_message` returns the id it assigned

### Message file format

Each `team/messages/<id>.md` is a markdown file with YAML-style frontmatter followed by the body:

```markdown
---
id: 2026-04-13T10-30-45.123Z-a3f2
from: alice
to: [bob, carol]
cc: [dave]
subject: Auth module review
sentAt: 2026-04-13T10:30:45.123Z
replyTo: 2026-04-12T18-05-12.000Z-9c1b
projectCode: AUTH
---
The auth module is ready for review. I've addressed the feedback from
yesterday's thread — see the updated token rotation logic in `auth/rotate.ts`.
```

Field reference:

| Field | Required | Description |
|---|---|---|
| `id` | yes | The message id (matches the filename) |
| `from` | yes | Sender member name |
| `to` | yes | Array of primary recipient member names |
| `cc` | no | Array of Cc'd member names; omit if none |
| `subject` | yes | Thread subject; auto-derived as `Re: ...` for replies |
| `sentAt` | yes | ISO-8601 timestamp |
| `replyTo` | no | Id of the immediately preceding message; omit to start a new thread |
| `supersedes` | no | Array of prior message ids this message consolidates / replaces. Set when the message was created via `supersede_message`. |
| `supersededBy` | no | Id of a later message that supersedes this one. Written by the adapter when `supersede_message` runs; never set by the original sender. |
| `projectCode` | no | Optional project tag for filtering/grouping |
| `questions` | no | One line of JSON: a list of questions the sender needs decided; see [Questions](#questions). |
| `answers` | no | One line of JSON: answers to the questions of the message this replies to; see [Questions](#questions). |
| `attachments` | no | Array of image file names stored in `team/messages/attachments/<id>/`; omit if none. See [Images](#images). |

### Images

A message can carry images (a screenshot, a photo, a chart). They live next to the message files, in
`team/messages/attachments/<id>/<name>`, so an image travels with its message (and with it into any sync of
`team/`). The body shows an image with a normal markdown image whose address is relative to `team/messages/`:

```markdown
Here is the failing page: ![login error](attachments/2026-10-13T16-33-49.548Z-szrx/login-error.png)
```

so the raw `.md` stays plain text and an agent reading it sees the path (its Read tool opens the image).
Rules, enforced by the adapter (`scripts/lib/messaging/attachments.mjs`) for every sender:

- **Formats:** png, jpg, gif, webp. The type is decided by the file's first bytes, never its name or extension;
  anything else (SVG, a document, a secrets file given by mistake) is refused.
- **Limits:** 8 MB per image, 10 images and 25 MB per message.
- **Names:** lowercased, only `a-z 0-9 . _ -`, the extension of the real type, `-2` / `-3` added on a clash.
- **Atomic:** the images are written before the message file, and a refused image means no message at all, so a
  message never points at a missing file.
- `sendMessage` / `supersedeMessage` take `attachments: [{ path, name?, ref? }]`. A body may place an image with
  `![caption](attachment:<ref>)` (the adapter swaps in the stored path); images the body does not place are
  appended at the end. A placeholder whose image was not sent is an error.

**Agents.** `send_message` and `supersede_message` take `attachments: ["<path>", ...]` (relative paths start at the
working directory); the position in the list is the placeholder, so `![caption](attachment:1)` places the first
one. Each file is checked by its content like any other upload, so a path to something that is not one of the four
image types (a secrets file, say) is refused and nothing is sent. To look at an image an agent opens it with its
Read tool: the cycle prompt lists "Attached images" under a message and `read_message` returns `attachmentPaths`
(absolute; the body itself only has the path relative to `team/messages/`).

**Dashboard.** Compose accepts paste (at the caret), drag-and-drop and a file picker (the phone's photo library
or camera). The browser sends each image first, as raw bytes, to `POST /api/attachments?name=` (sender enforced
like `POST /api/messages`, kept in `team/.logs/attachments-staging/` and swept after a day), gets a token back, and
`POST /api/messages` names the tokens in `attachments`. Photos (JPEG, HEIC and other camera formats) are redrawn
in the browser as a JPEG no longer than 2560 px on the long side, which also drops the EXIF block (location
included); PNG, GIF and WebP go as they are. An image is served from
`GET /api/messages/<id>/attachments/<name>` with its sniffed type, `nosniff` and a CSP that allows nothing but the
image. Like message text, an image is readable by anyone who can open the dashboard (there is no per-recipient
check on reading a message).

**Rendering.** An `<img>` in a message may only point at that route. A markdown image to any other address is shown
as a plain link, and raw HTML that would fetch from elsewhere (`<img>` to another site, `srcset`, `<video>`,
`<source>`, `<picture>`, an `<input>` that is not a task-list checkbox, `style`, `poster`, `background`) is
stripped, and so are forms, so opening a message never makes the browser contact another site.

### Questions

A message can ask questions that people answer with a tap (dashboard cards) and agents answer with a reply. The
state of each question is not stored anywhere: it is **folded from the asking message and the messages that answer
it**, so the master store stays the only truth and any copy of it is complete. The rules live in
`scripts/lib/messaging/questions.mjs` (pure, no I/O); the file adapter enforces them when a message is sent and the
fold enforces them again when the state is read.

**Asking.** `questions:` is ONE line of JSON in the frontmatter (only this field and `answers` are read as JSON; every
other field parses as before):

```
questions: [{"id":"q1","text":"Which palette?","options":[{"label":"Meadow","description":"Green and cream"},{"label":"Sky"}],"recommend":1,"waitingOn":["kris"]}]
```

- `id` is assigned in order (`q1`, `q2`, ...); at most 5 questions per message (three or four is better);
  `text` up to 300 characters; 2 to 4 `options` (`label` up to 60, `description` up to 160); an "Other" answer is
  always possible and is not an option.
- `recommend` (the 1-based option number) is **required**: asking without a recommendation is refused.
- `waitingOn` defaults to the message's `to`; every name must be on the message (`to` or `cc`).
- The questions are also written in the body. If a question's text is missing there, the adapter appends a numbered
  "Questions" block and `send_message` says so (`questionsAppended`), so a reader of the bare file never loses one.

**Answering** is a normal reply (`replyTo` is the asking message) with `answers:`, one JSON line of entries, and a
plain-words body. Each entry has `ask`, `q` and exactly one of:

| Entry | Meaning | Who may send it |
| --- | --- | --- |
| `option: N` or `other: "text"` | an answer | anyone on the ask's `to` or `cc`, not only the person it waits on; not the asker |
| the same plus `by` and `via` | the asker records someone's plain-text reply | the asker only; `by` must be asked, `via` must be a message from `by` sent after the ask |
| `dismissed: true` | "no longer needed" | a person on the message, not the asker (an asker withdraws a question by superseding) |
| `reopen: "reason"` | the asker still needs it | the asker, once per question, a reason is required, only after it was closed |

Anything else is refused with a sentence that says why (not on the thread, option out of range, a second reopen,
...). One entry per question per message.

**The state** of a question is `open` until the first answer; then `answered` (`answer`: who, when, option or text,
and `recordedBy`/`via` when the asker recorded it) or `dismissed`. The first answer wins; a later answer is kept in
`also` and `conflict` says when it differs, never hidden. A reopen moves what was there to `earlier` and starts again
(once). A superseded ask is ignored (its successor carries the questions); superseding a message that has answered
or dismissed questions is refused ("send a follow-up instead"), because answers do not carry across. A plain-text
reply without `answers` is not matched automatically: it is a message, and the asker records it (the "Questions"
section of the cycle prompt lists those replies).

**Waiting.** `waitingOn(member)` is every open question whose `waitingOn` includes the member, oldest first, and
`askedBy(member)` the member's own open questions with the plain replies since. Both are derived from the messages,
so they do not depend on a message being in an inbox (an archived ask still waits) and never edit `inbox.json` or
`archives.json`, so they cannot affect what counts as read.

**Where it shows.** `read_message` returns `questionState` (each question with its status and answers); `list_inbox`,
`list_sent` and `list_archives` summaries of an ask carry `questions: { open, total }`; `list_questions` returns
`{ waitingOnMe, asked }`; the cycle prompt renders each message's questions with their state and adds a "Questions"
section when something waits on the member or the member is waiting. An answer is mail To the asker, so it wakes the
asker as any message does; an unanswered question never wakes anyone.

**Cost.** The state needs the headers of every message. `QuestionIndex` (`question-index.mjs`) caches them per file by
mtime, in memory and in `team/.logs/questions-index.json` (outside the Drive sync; safe to delete; any version of it
is valid). Measured on a synthetic 5,000-message store: first pass with no cache file 0.5 s, a fresh process with the
cache file and a warm call about 70 ms.

### Mailbox files

Each member has three json files, all with the same shape:

```json
{ "items": ["2026-04-13T10-30-45.123Z-a3f2", "2026-04-12T18-05-12.000Z-9c1b"] }
```

- `inbox.json` — messages the member has received but not yet archived. Populated on send; pruned on archive.
- `sent.json` — append-only history of messages the member has sent. Used to locate the original when a reply cites it.
- `archives.json` — messages the member has explicitly archived. Read-only long-term reference.

A single message id may appear in many members' mailbox files (once in the sender's `sent.json`, once in each recipient's `inbox.json` or later `archives.json`). The master store holds exactly one copy of the content.

## MCP Tools

These are the tools the messaging adapter exposes to the agent. The contract is designed to be portable to a real email backend — the shape maps cleanly onto SMTP send + IMAP fetch/move.

### `send_message`

```
send_message({
  to: string[],          // required — primary recipients
  subject: string,       // required
  body: string,          // required — markdown
  cc?: string[],         // optional
  replyTo?: string,      // optional — parent message id
  projectCode?: string,  // optional
  attachments?: string[], // optional — paths of image files; see Images
  questions?: object[],  // optional — see Questions
  answers?: object[],    // optional — answers to the message replyTo points at; see Questions
}) → { id: string, sentAt: string }
```

Allocates a new id, writes the message to the master store, appends the id to each recipient's `inbox.json` (both To and Cc) and to the sender's `sent.json`. If `replyTo` is set and no explicit `subject` is provided, the adapter derives `Re: <parent.subject>` (stripping any existing `Re: ` prefix to avoid stacking). Explicit subjects are used verbatim.

### `supersede_message`

```
supersede_message({
  supersedes: string[],  // required — ids of prior messages YOU sent
  to: string[],          // required — must cover every predecessor recipient
  body: string,          // required — markdown; the standalone replacement
  subject?: string,      // optional — defaults to the latest predecessor's subject
  cc?: string[],         // optional
  replyTo?: string,      // optional — usually omit
  projectCode?: string,  // optional
}) → { id, sentAt, supersededIds, unreadRemoved, alreadyDelivered }
```

Sends a new message that consolidates / replaces one or more earlier messages from the same sender. The adapter:

1. Validates every predecessor exists, was sent by the caller, and is not already superseded.
2. Validates the new `to`+`cc` covers every recipient any predecessor reached. (To narrow the audience, send a regular message instead.)
3. Allocates a new id and writes the consolidated message with `supersedes: [...]`.
4. Rewrites each predecessor's frontmatter to add `supersededBy: <newId>` (body untouched — the audit trail is preserved).
5. For every recipient of every predecessor: if the predecessor id is still in their `inbox.json`, removes it. If they already archived (or otherwise dropped) it, leaves their archives alone; their `list_archives` entry will surface `supersededBy` so they know.
6. Delivers the new message normally — appends to each recipient's `inbox.json` and to the sender's `sent.json`.

Return fields:

- `unreadRemoved` — number of `(predecessor, recipient)` pairs the adapter removed from inboxes (i.e. the recipient had not yet read the predecessor).
- `alreadyDelivered` — number of pairs where the predecessor was no longer in the inbox (already read or archived); those recipients see both messages with the supersede markers connecting them.

Recipients whose AI cycle had already fired between the original send and the supersede will already have processed the predecessor; they re-read the consolidated version on next cycle. The supersede is still strictly cheaper than another stacked message — the inbox holds one item, not two.

### `read_message`

```
read_message(id: string) → Message
```

Returns the full message plus its immediate parent inlined:

```
{
  id, from, to, cc, subject, sentAt, replyTo, projectCode, body,
  attachments?, attachmentPaths?,   // image names; absolute paths of the files (see Images)
  questions?, answers?, questionState?,   // see Questions
  parent?: {
    id, from, to, cc, subject, sentAt, replyTo, projectCode, body, attachments?, attachmentPaths?
  }
}
```

`parent` is present whenever `replyTo` resolves to a message still in the store. To walk further back, the agent calls `read_message(parent.replyTo)`.

`read_message` is id-scoped, not mailbox-scoped: it will resolve any id in the master store, whether the caller has it in their inbox, sent, archives, or none of the above. Cross-mailbox lookups are how a sender retrieves a message from a reply whose parent they sent weeks ago.

### `list_inbox`

```
list_inbox() → InboxEntry[]
```

Returns summaries for every id in the caller's `inbox.json`, newest first:

```
{ id, from, to, cc, subject, sentAt, projectCode, hasParent, supersedes?, supersededBy? }
```

`hasParent` is `true` when `replyTo` is set, so the UI or agent can indicate "this is part of a thread" without fetching the full message. `supersedes` (when present) lists the predecessor ids that this message consolidates; `supersededBy` (when present) is the id of a later message that consolidates this one.

**Collapse rule:** an entry whose `supersededBy` target is reachable in the caller's inbox or archives is omitted from the listing — the consolidated version is the canonical one. If the consolidated version isn't reachable, the predecessor stays visible so the recipient never silently loses a message.

### `list_sent`

```
list_sent({ to?: string[] }) → SentEntry[]
```

Same shape as `list_inbox`, reading from `sent.json`. Pass an optional `to` filter to restrict to messages whose `to`+`cc` includes at least one of the named members — agents call this before composing to a recipient set they have already messaged this cycle, so they can spot threads that should be consolidated via `supersede_message` instead of stacked. Sent listings do **not** apply the supersede collapse — the sender sees their full history with `supersedes` / `supersededBy` markers.

### `list_archives`

```
list_archives() → InboxEntry[]
```

Same shape as `list_inbox`, reading from `archives.json`. Same collapse rule as `list_inbox`: an archived predecessor is hidden when the consolidated version is reachable in the same mailbox.

### `archive_message`

```
archive_message(id: string) → void
```

Moves `id` from `inbox.json` to `archives.json` atomically. No-op if the id is already archived. Errors if the id is not in the caller's inbox (to avoid silently archiving unrelated messages).

### `unarchive_message`

```
unarchive_message(id: string) → void
```

Inverse of `archive_message`. Useful when an agent archives prematurely and needs to put a message back in play.

## Cycle Integration

When the runner builds a cycle prompt for a member, it:

1. Calls `list_inbox(member)` to get inbox summaries (already collapse-aware — superseded predecessors are hidden when the consolidated version is reachable)
2. Calls `read_message(id)` for each entry to get the message with parent inlined
3. Embeds those messages in the prompt under an "Inbox" section — To-addressed mail first, then mail that only Cc's the member under its own lower-priority heading
4. Passes the MCP tools through so the agent can call `send_message`, `supersede_message`, `archive_message`, etc. during the cycle

The agent is expected to process each inbox message and then `archive_message` it if fully handled. Messages left in the inbox carry forward to the next cycle — this is the intended way to defer work ("I'll handle this later, keep it in my inbox"). Before composing a new message to a recipient set the agent has already messaged this cycle, the agent calls `list_sent({ to: [...] })` and prefers `supersede_message` over stacking another message on the same topic.

## Work Detection

A member has messaging work when their inbox listing (after the supersede collapse) holds a message at or above the priority being scanned. A message on which the member is in `to` is `pressing`; one on which they are only in `cc` is `today` (`CC_PRIORITY` in `scripts/lib/work-detection.mjs`), so Cc-only mail is served like a `today` todo — on that priority's weight and cadence — rather than waking the member for a pressing cycle. The collapse step requires reading each candidate's frontmatter, but inboxes are bounded and the cost is paid once per scheduling pass per member — not in a hot loop.

## Sender Semantics

When alice sends to `[bob]` with `cc: [carol]`:

1. A new id is allocated
2. The message file is written to `team/messages/<id>.md` with `to: [bob]` and `cc: [carol]`
3. `<id>` is appended to `bob/inbox.json` and `carol/inbox.json`
4. `<id>` is appended to `alice/sent.json`

Bob and Carol both receive the message through their inbox; neither can tell from the delivery path alone whether they were in To or Cc — they must inspect the message's `to` and `cc` fields to see their role. This matches email. The runner does read the role: bob's copy is pressing work, carol's waits as `today` work.

## Dashboard View

The agent contract above is flat on purpose — a thread is the transitive closure
of `replyTo`, and a mailbox is a list of ids. People cannot read that directly,
so the web dashboard reconstructs threads at read time over the same adapter:

- `GET /api/members/:name/threads` — walks each mailbox id back through the
  master store (pulling in ancestors that live in none of that member's
  mailboxes, flagged as context), then folds chains sharing a root subject into
  one conversation. Returns per-message `boxes` and `depth` so the UI can render
  the reply tree and say which mailbox each message came from.
- `POST /api/messages/batch` — bodies for a whole conversation in one request.
- `POST /api/attachments?name=` (raw image bytes → `{ token, name, size, mime }`) and
  `GET /api/messages/:id/attachments/:name` — see [Images](#images).

Both are dashboard-only views. They add nothing to the MCP surface, the
supersede-collapse rule is applied exactly as `list_inbox` applies it, and an
adapter that implements the tools above gets the threaded view for free.

## Retention and Cleanup

The master store grows unbounded in v1. A later clerk pass will handle retention, likely as:

> Delete `team/messages/<id>.md` when `<id>` is absent from every member's `inbox.json`, `sent.json`, and `archives.json`.

This policy is safe by construction: a message is only reachable through a mailbox reference, so an id that no member references is unreachable and can be pruned. Timed retention (e.g. "delete archived messages older than 90 days") layers on top by first removing old ids from `archives.json` and then letting the reference-count sweep reclaim the store files.

An id's images go with it: the sweep that removes `team/messages/<id>.md` removes `team/messages/attachments/<id>/` too.

Retention is deliberately deferred — the protocol works correctly without it, and teams can add pruning at whatever cadence fits their volume.

## Future Adapters

The MCP contract above is the stable surface. A future SMTP/IMAP adapter would:

- Map `send_message` → SMTP `MAIL FROM` / `RCPT TO` / `DATA`, using a hidden `X-TeamOS-Id` header to carry the TeamOS message id across the wire
- Map `list_inbox` → IMAP `SEARCH` / `FETCH` against the inbox folder
- Map `archive_message` → IMAP `MOVE` to an Archives folder
- Map `read_message(id)` → IMAP search on `X-TeamOS-Id`, falling back to `Message-ID` for inbound mail from outside the team
- Derive `replyTo` from `In-Reply-To` / `References` headers

Because the adapter contract is id-based and mailbox-operations are explicit, swapping the storage backend does not change the agent's mental model, the cycle prompt shape, or the runner's work-detection logic.
