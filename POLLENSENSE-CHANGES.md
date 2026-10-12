# Pollen Sense changes to TeamOS

This is `PollenSense/teamos`, forked from `Digithought/teamos` on 2026-10-09 (Nate's call, via Van). The
`upstream` remote is Digithought; pull from it when they release. Keep our changes small, on branches,
and written so they could be sent upstream as pull requests. Every change gets one line here.

| Date | Branch / commit | What | Why | Upstream PR? |
| --- | --- | --- | --- | --- |
| 2026-10-09 | main | Fork created; this file. | So the AI team's dashboard can be fixed without waiting on upstream. | n/a |
| 2026-10-12 | `ps/dashboard-markdown-and-chat-scope` (PR #2, supersedes PR #1) | Sender identity enforced on messages and chat start; chat transcripts visible only to the human who opened them (or an `admin` role); message bodies, reply quotes and member chat replies render as markdown by default with a Raw toggle (`marked` + DOMPurify). | Impersonation (found 2026-10-08), Sagun's chat-privacy request, and Van's ask that markdown messages read as rendered text. | worth sending |

## Done, pending merge (PR #2)

1. **Sender identity enforced.** Before merging: every dashboard user's Tailscale login email must match
   their `members.json` `email`, or they get 403 on send; three entries are still "guessed" (kris, sagun, jarris).
2. **Chat visibility scoped.** With a locked identity, only the opener (or an `admin` role) sees or speaks in a
   chat; others see "X is chatting with Y" and no transcript. Unlocked localhost keeps the old behaviour.
3. **Markdown preview for messages.** Raw toggle per message, remembered per browser.

## Wanted (not started)

- **Linkify paths in messages** (Cy, from 2026-10-12): Drive files via an rclone-built index, code via GitHub, tickets and member state via dashboard routes. Config-driven (`links` block in teamos.config.json) so it can go upstream.
