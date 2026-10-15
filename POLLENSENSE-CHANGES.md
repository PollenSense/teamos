# Pollen Sense changes to TeamOS

This is `PollenSense/teamos`, forked from `Digithought/teamos` on 2026-10-09 (Nate's call, via Van). The
`upstream` remote is Digithought; pull from it when they release. Keep our changes small, on branches,
and written so they could be sent upstream as pull requests. Every change gets one line here.

| Date | Branch / commit | What | Why | Upstream PR? |
| --- | --- | --- | --- | --- |
| 2026-10-09 | main | Fork created; this file. | So the AI team's dashboard can be fixed without waiting on upstream. | n/a |
| 2026-10-12 | `ps/dashboard-markdown-and-chat-scope` (PR #2, supersedes PR #1) | Sender identity enforced on messages and chat start; chat transcripts visible only to the human who opened them (or an `admin` role); message bodies, reply quotes and member chat replies render as markdown by default with a Raw toggle (`marked` + DOMPurify). | Impersonation (found 2026-10-08), Sagun's chat-privacy request, and Van's ask that markdown messages read as rendered text. | worth sending |
| 2026-10-13 | `ps/linkify` (PR #3, merged 2026-10-13, `c5ac468`) | Paths and ids in messages become links: Drive files, code in GitHub repos, and the dashboard's own pages (member State/Todos/Schedule, messages). Documented in `docs/links.md`. The server resolves paths into a `links` map per message; the markdown renderer applies it, so the Raw view is untouched and code blocks and existing links are skipped. Driven by a `links` block in `teamos.config.json`; Drive and repo links exist only where configured. | Van's ask: when a member tells someone to look at something, it should be clickable (Kris starts 2026-10-13 and is told "see PollenBot/..."). | worth sending |
| 2026-10-15 | `ps/attachments` (PR #5, merged 2026-10-15, `a76230e`; PR 1 of 2: the dashboard) | Images in messages: paste, drop or pick in Compose (phone and desktop), shown inline, click for full size; stored in `team/messages/attachments/<id>/`. Browser-shrunk photos, type from content, 8 MB / 10 / 25 MB limits. Message HTML can no longer fetch from other sites. Documented in `docs/messages.md` (Images). PR 2 adds the agent side (MCP tools). | Kris and Van work from phones; screenshots say more than a paragraph; agents can read and attach images. | Possible; the hardening part (no external fetch) is the most generally useful. |
| 2026-10-13 | `ps/attachments-agents` (not merged yet; PR 2 of 2, on top of merged PR #5) | Images in messages for agents: `send_message` / `supersede_message` take `attachments: [paths]`; `read_message` returns `attachmentPaths`; the cycle prompt lists "Attached images" with absolute paths; a rule in `agent-rules/cycle.md`. | Agents can read a screenshot with their Read tool and attach a chart or a Playwright screenshot. | Possible. |
| 2026-10-13 | `ps/questions` (not merged yet; PR A of 2: the core, stacked on `ps/attachments-agents`) | Question cards, agent side and storage: `questions:` / `answers:` in message frontmatter (one JSON line), validation (2-4 options, a required recommendation, waiting only on people on the message), the state folded from the thread (first answer wins, dismiss, reopen once, `by`/`via` for recording a text reply), `waitingOn` / `askedBy` lists derived from the store, MCP (`questions`, `answers`, `list_questions`, `questionState`), cycle prompt (questions with state, a "Questions" section), member rules in `agent-rules/cycle.md`. PR B adds the dashboard cards. | Van wants decisions asked as tap-able questions and a list of who is waiting on whom, without touching read state. | Possible; the fold is pure and self-contained. |
| 2026-10-13 | `ps/questions-ui` (not merged yet; PR B of 2: the dashboard, stacked on `ps/questions`) | Question cards in the dashboard: cards under a message (tap targets, recommended tag, Other box, state), `POST /api/messages/:id/answers` (signed-in member, reply to the asker only, plain-words body), `GET /api/members/:name/waiting`, thread-row chips, the pinned "Waiting on you (N)" strip, "N waiting" on member cards, a hint when replying to a message with open questions. | Kris and Van answer decisions with a tap on a phone; the team can see who is waiting on whom. | Possible. |

## Done, pending merge (PR #2)

1. **Sender identity enforced.** Before merging: every dashboard user's Tailscale login email must match
   their `members.json` `email`, or they get 403 on send; three entries are still "guessed" (kris, sagun, jarris).
2. **Chat visibility scoped.** With a locked identity, only the opener (or an `admin` role) sees or speaks in a
   chat; others see "X is chatting with Y" and no transcript. Unlocked localhost keeps the old behaviour.
3. **Markdown preview for messages.** Raw toggle per message, remembered per browser.

## Wanted (not started)

- (nothing yet; add here)

## Linkify paths in messages (`ps/linkify`)

1. **Drive files (done).** `ui/src/lib/linkify.ts` (shared path pattern, marked renderer hooks), `ui/src/server/linkify.ts` (resolver), `links` in the message API responses (`/api/messages/batch`, `/api/messages/:id`; the body is never rewritten). Config: `links.drive = { root, index }`; the index (`path<TAB>id<TAB>parent`) is built outside TeamOS by the project (ours: `scripts/drive-index.sh` in pollen-bot). A path not in the index links to its nearest indexed folder. `npm test` in `ui/` runs `test/linkify.test.ts`.
2. **Code in GitHub repos (done).** `links.repos = { <name>: { url, dir?, branch? } }`. `../pollen/src/a.ts:12-20` and `pollen/src/a.ts` link to `<url>/blob/<branch>/src/a.ts#L12-L20` (a folder to `tree`), only if the file exists in the checkout (`dir`, default `../<name>`); never `.git` or `node_modules`; only plain https addresses. The link title says work that is not merged and pushed is not on the branch. Repo paths win over Drive paths.
3. **Dashboard pages (done).** `team/members/<name>/state.md|todo.json|schedule.json` -> `#/member/<name>?tab=state|todos|schedule` (new: `MemberDetail` honors `?tab=` once, then drops it); a message id that exists -> `#/message/<id>` (new `MessageRedirect` route: opens it in the viewer's mailbox if they were on it, else the first participant's). Tickets have no per-ticket page in the dashboard (the Tickets pane shows stage counts only), so ticket paths link to Drive. `links.dashboard: false` turns these off.

## Images in messages (`ps/attachments`, PR 1: dashboard)

1. **Storage and rules** (`scripts/lib/messaging/attachments.mjs`, `file.mjs`): `attachments/<id>/<name>` next to the
   message, `attachments:` list in the frontmatter, magic-byte type check, limits, safe names, images written before
   the message file. The `supersede` rewrite of a predecessor keeps its list.
2. **Dashboard server** (`ui/src/server/api-plugin.ts`, `ui/vite.config.ts`): `POST /api/attachments` (streaming
   body with a size cap, 413/415 with a reason), `GET /api/messages/:id/attachments/:name`, `attachments` tokens on
   `POST /api/messages`, limits in `/api/messaging/info`.
3. **Compose** (`ui/src/components/ComposeMessage.svelte`, `ui/src/lib/attachments.ts`): paste at the caret, drop
   and pick at the end, tray with thumbnails, browser-side resize to 2560 px as JPEG (EXIF gone).
4. **Rendering hardening** (`ui/src/lib/markdown.ts`): beyond the images themselves, `style`, `srcset`, `poster`,
   `background`, `action`, `formaction` attributes, `video`/`audio`/`source`/`track`/`picture`/`form` elements and any
   `<input>` that is not a task-list checkbox are stripped from message HTML,
   because an allow-list on `<img>` means little while another element can still fetch from outside. This changes
   how a message with inline `style=` renders.
5. Tests: `scripts/lib/messaging/attachments.test.mjs`, `ui/test/attachments.test.ts`; also checked in headless
   Chromium against a throwaway project (paste, drop, picker, send, render, hostile HTML, phone width).
6. **Known, not changed here:** at 390 px the member page (`#/member/<name>`) already overflows sideways (header
   buttons and tabs), unrelated to images.

## Images in messages, PR 2: agents (`ps/attachments-agents`)

`mcp-server.mjs` (`attachments` on the two send tools, paths resolved from the working directory, positions are the
placeholders), `file.mjs` (`readMessage(id, { withPaths })` adds `attachmentPaths`, off for the dashboard so browsers
never see server paths), `cycle.mjs` (an "Attached images" list per message), `agent-rules/cycle.md` (Images
paragraph). Tests: `scripts/lib/messaging/agent-attachments.test.mjs` drives the real MCP server over stdio.

## Question cards, PR A: core (`ps/questions`)

`scripts/lib/messaging/questions.mjs` (pure rules and fold), `question-index.mjs` (headers cached by mtime, in memory and in
`team/.logs/questions-index.json`), `file.mjs` (JSON frontmatter for these two fields only, carried through the supersede
rewrite, validation and answer checks on send, `readMessage({ withState })`, `listQuestions`, summaries with counts),
`mcp-server.mjs`, `cycle.mjs`, `agent-rules/cycle.md` (the nine rules Van approved 2026-10-13), `docs/messages.md`
(Questions). Tests: `questions.test.mjs` (the fold and every refusal), `questions-adapter.test.mjs` (files, supersede,
cache), `questions-agent.test.mjs` (the real MCP server over stdio, the prompt). Plan: `pollen-bot/docs/teamos-question-cards-plan.md`.

## Question cards, PR B: dashboard (`ps/questions-ui`)

Server (`ui/src/server/api-plugin.ts`): the answers and waiting routes, `questionState` on message reads, per-thread and
per-message counts, `waitingCount` on member summaries. Client: `ui/src/lib/questions.ts` (pure helpers: who may
answer, what a tap sends, chips, titles), `ui/src/components/QuestionCards.svelte`, changes in `Mailbox.svelte`,
`MemberCard.svelte`, `ComposeMessage.svelte`. Tests: `ui/test/questions.test.ts`; 37 real-browser checks in headless
Chromium against a throwaway dashboard (`team/members/cy/tools/teamos-browser-test`, taps, Send N answers, single tap,
dismiss, read-only views, refusals, hint, phone width). Known, not changed: a dismissed question counts as "answered"
in the thread chip.
