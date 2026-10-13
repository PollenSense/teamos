# Pollen Sense changes to TeamOS

This is `PollenSense/teamos`, forked from `Digithought/teamos` on 2026-10-09 (Nate's call, via Van). The
`upstream` remote is Digithought; pull from it when they release. Keep our changes small, on branches,
and written so they could be sent upstream as pull requests. Every change gets one line here.

| Date | Branch / commit | What | Why | Upstream PR? |
| --- | --- | --- | --- | --- |
| 2026-10-09 | main | Fork created; this file. | So the AI team's dashboard can be fixed without waiting on upstream. | n/a |
| 2026-10-12 | `ps/dashboard-markdown-and-chat-scope` (PR #2, supersedes PR #1) | Sender identity enforced on messages and chat start; chat transcripts visible only to the human who opened them (or an `admin` role); message bodies, reply quotes and member chat replies render as markdown by default with a Raw toggle (`marked` + DOMPurify). | Impersonation (found 2026-10-08), Sagun's chat-privacy request, and Van's ask that markdown messages read as rendered text. | worth sending |
| 2026-10-12 | `ps/linkify` (not merged yet) | Paths and ids in messages become links: Drive files, code in GitHub repos, and the dashboard's own pages (member State/Todos/Schedule, messages). Documented in `docs/links.md`. The server resolves paths into a `links` map per message; the markdown renderer applies it, so the Raw view is untouched and code blocks and existing links are skipped. Driven by a `links` block in `teamos.config.json`; Drive and repo links exist only where configured. | Van's ask: when a member tells someone to look at something, it should be clickable (Kris starts 2026-10-13 and is told "see PollenBot/..."). | worth sending |

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
