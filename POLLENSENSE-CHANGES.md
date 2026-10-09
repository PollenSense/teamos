# Pollen Sense changes to TeamOS

This is `PollenSense/teamos`, forked from `Digithought/teamos` on 2026-10-09 (Nate's call, via Van). The
`upstream` remote is Digithought; pull from it when they release. Keep our changes small, on branches,
and written so they could be sent upstream as pull requests. Every change gets one line here.

| Date | Branch / commit | What | Why | Upstream PR? |
| --- | --- | --- | --- | --- |
| 2026-10-09 | main | Fork created; this file. | So the AI team's dashboard can be fixed without waiting on upstream. | n/a |
| 2026-10-09 | `ps/enforce-sender-identity` | `POST /api/messages` and chat start take the sender from the proxy identity when it is locked; 403 when the header matches no member. | Anyone on the tailnet could send as anyone (found 2026-10-08). | worth sending |

## Wanted (not started)

1. ~~Enforce the sender identity on the dashboard.~~ Done on `ps/enforce-sender-identity` (PR open).
   **Before merging:** every dashboard user's Tailscale login email must match their `members.json`
   `email`, or they get 403 on send; three entries are still "guessed" (kris, sagun, jarris).
2. **Scope chat visibility.** Every chat transcript is visible to every dashboard user. Show a chat only
   to the human who opened it, the members it addresses, and admins (Sagun's request, 2026-10-08).
