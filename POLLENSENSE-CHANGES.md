# Pollen Sense changes to TeamOS

This is `PollenSense/teamos`, forked from `Digithought/teamos` on 2026-10-09 (Nate's call, via Van). The
`upstream` remote is Digithought; pull from it when they release. Keep our changes small, on branches,
and written so they could be sent upstream as pull requests. Every change gets one line here.

| Date | Branch / commit | What | Why | Upstream PR? |
| --- | --- | --- | --- | --- |
| 2026-10-09 | (none yet) | Fork created; this file. | So the AI team's dashboard can be fixed without waiting on upstream. | n/a |

## Wanted (not started)

1. **Enforce the sender identity on the dashboard.** `ui/src/server/api-plugin.ts`: `POST /api/messages`
   and the chat session start take `from` / `human` from the request body. When `resolveIdentity(req)` is
   `locked`, overwrite them with the resolved member and return 403 when the header email matches no
   member. Found 2026-10-08 (anyone on the tailnet could send as anyone).
2. **Scope chat visibility.** Every chat transcript is visible to every dashboard user. Show a chat only
   to the human who opened it, the members it addresses, and admins (Sagun's request, 2026-10-08).
