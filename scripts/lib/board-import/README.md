# Reference-data importer (`scripts/lib/board-import/`)

Reads a board export folder (`scripts/lib/board-export/`) and writes the reference data of the team work board:
people, teams with workflow states, cycles, labels, projects with milestones and updates, documents, and the map from
message tags to projects. Phase (a) of Linear inside TeamOS, ticket A4. Issues, comments and relations are A5 and A6.
PollenSense-only (it knows what a Linear user and a Linear project are); the store extensions it uses (`dryRun`,
documents, single files) are general.

```
node scripts/board-import-reference.mjs --workspace <repo root> --export <export folder>          # dry run: counts, writes nothing
node scripts/board-import-reference.mjs --workspace <repo root> --export <export folder> --apply  # needs board.importer true
```

Options: `--members` (default `team/members.json`), `--people-map` (JSON, Linear user id to member name),
`--tag-hints` (JSON, message tag to the exact name of a Linear project), `--filter` (default `scripts/rclone-filter.txt`).
The output is counts only: read, new, changed, same, failed per kind, how many people matched a member, how many texts
were redacted, which references dangle. No title, name, text or address.

## What goes where (design 2.2, 2.5)

| From the export | Board file | Notes |
|---|---|---|
| users | `people.json` | `{ version, people: { <linear id>: { name, former?, app? } } }`. `name` is a TeamOS member (e-mail matched in memory, never written) or `linear:<first name>` (`#2` for a second one). An inactive user is `former: true`, matched or not (Van `bt5a`); an app is `app: true`. Disabled users stay. |
| teams, states | `teams/<KEY>.json` | states in position order with their type; `native: false`; `nextNumber` is never written here (A5 raises it) |
| cycles | `cycles/<KEY>/<n>.json` | dates and `completed` |
| labels | `labels.json` | `Group/name`, group labels marked, team and retired date kept; the Linear id stays so A5 can turn `labelIds` into names |
| projects, milestones, updates | `projects/<code>.md` | front matter + description and content as the body; milestones and updates are front-matter lists |
| documents | `documents/<id>.md` | read-only text, `project:` names the project code |
| tags (`renewals`, `ops`, ...) | `project-map.json` | `{ version, tags: { <tag>: <project code> or null } }`; an entry that already has a value is never changed (a hand edit stays); a null one is filled when a project code equals the tag, or `--tag-hints` names the project |

A project's **code** is the slug of its name the first time it is seen (`Renewals automation` becomes
`renewals-automation`; a second project with the same slug gets `-2`). It is kept by Linear id afterwards: a rename in Linear
changes the name in the file and leaves the file name alone.

## Rule A

Every typed text (names, descriptions, update bodies, document text) goes through `redactValue` first. Outside addresses
and phone-shaped numbers become `[email]` and `[phone]` in the synced file; when anything was redacted the original goes to
`team/board/raw/<type>/<id>.json` (folder mode 0700, file 0600), written **before** the synced file. A real run calls the
caller's guard (`assertLocalOnly` on the raw folder) before its first write and stops if the filter would sync it. A project
code is made from the redacted name, so an address in a name does not become a file name. Ids, dates and codes are not
scanned (they are not typed text).

## Runs twice, changes nothing

No time stamp is written (`source` is `{ system: 'linear' }`), records and keys are sorted, and the store skips a write of
identical text, so a second run reports every file as `same` and touches none. A field Linear cleared disappears from
the file; a field somebody added by hand is kept (store rule). A damaged existing file is never overwritten: it is counted
as failed and the rest of the run goes on.

## Known limits

- Dangling references (a cycle of an unknown team, a milestone of an unknown project, a lead who is not a user) are counted
  in the report, and the record is written without the reference.
- `raw/` files of a text that is no longer flagged stay (they are local and the next full import removes nothing).
- Project updates carry their text in a front-matter line (one line of JSON per value); 29 updates in Linear's workspace,
  so the files stay readable. A5 does the same for nothing: issue text goes in the body.
- The export's `milestones` and `projectUpdates` of a project that is not in the export are skipped and counted.

## Tests

`node --test scripts/lib/board-import/*.test.mjs scripts/board-import-reference.test.mjs` (and `scripts/lib/board/store-extensions.test.mjs`).
Fixtures are invented (`fixture.mjs`, built on the export fixture); an export of the inventory's size (63 projects, 15
labels, 17 documents, 18 users, 4 teams) checks the dry-run counts. The guards were mutation-checked (removed, then a test failed).
