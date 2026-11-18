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

Every typed text (descriptions, update bodies, document text, and the names of projects, milestones, teams, workflow states,
labels and cycles) goes through `redactValue` first. Outside addresses
and phone-shaped numbers become `[email]` and `[phone]` in the synced file; when anything was redacted the original goes to
`team/board/raw/<type>/<id>.json` (folder mode 0700, file 0600), written **before** the synced file; the flagged team,
state, label and cycle names share one record, `raw/names/reference.json`. A real run calls the
caller's guard (`assertLocalOnly` on the raw folder) before its first write and stops if the filter would sync it. A raw type folder (`raw/projects`, ...) that is a link or not a folder is refused with `bad-raw` before anything is read or written, dry run included: a link into the synced workspace would carry the original texts out. A project
code is made from the redacted name, so an address in a name does not become a file name. Ids, dates and codes are not
scanned (they are not typed text).

## Runs twice, changes nothing

No time stamp is written (`source` is `{ system: 'linear' }`), records and keys are sorted, and the store skips a write of
identical text, so a second run reports every file as `same` and touches none. A field Linear cleared disappears from
the file; a field somebody added by hand is kept (store rule). A damaged existing file is never overwritten: it is counted
as failed and the rest of the run goes on.

## Known limits

- Dangling references are counted in the report. A milestone of an unknown project, a lead who is not a user or an
  unknown team of a project: the record is written without the reference. A cycle of an unknown team and a document
  whose id is not a plain name are skipped (not written).
- Two teams with one key, or two cycles with one team and number, stop the run (`duplicate`): one would overwrite the other.
- A `members.json` without a `members` list, and a `--people-map` or `--tag-hints` that is not a JSON object, stop the run
  with exit 2 (read as empty, every member would be written as `linear:<first name>`); an entry in that list that is not a
  member with a name (`null`, a bare string) stops it as `bad-members` (exit 1).
- `raw/` files of a text that is no longer flagged stay (they are local and the next full import removes nothing).
- Project updates carry their text in a front-matter line (one line of JSON per value); 29 updates in Linear's workspace,
  so the files stay readable. A5 does the same for nothing: issue text goes in the body.
- The export's `milestones` and `projectUpdates` of a project that is not in the export are skipped and counted.

## Tests

`node --test scripts/lib/board-import/*.test.mjs scripts/board-import-reference.test.mjs` (and `scripts/lib/board/store-extensions.test.mjs`).
Fixtures are invented (`fixture.mjs`, built on the export fixture); an export of the inventory's size (63 projects, 15
labels, 17 documents, 18 users, 4 teams) checks the dry-run counts. The guards were mutation-checked (removed, then a test failed).

## Issues (ticket A5)

```
node scripts/board-import-issues.mjs --workspace <repo root> --export <export folder>          # dry run: counts per team, writes nothing
node scripts/board-import-issues.mjs --workspace <repo root> --export <export folder> --apply  # needs board.importer true and the reference import done
```

The options are the reference importer's that matter for issues (`--members`, `--people-map`, `--filter`): they feed the same
plan, so people, project codes, label names and cycles in an issue always equal the reference files. `--apply` refuses until
`board-import-reference.mjs --apply` has written `people.json`.

One file per issue, `issues/<TEAM>/<KEY>.md`, in the layout of design 2.2: status and type from the workflow state, priority
(0 to 4; any other value kept as text), assignee and creator as board names, project code, milestone name, cycle `PSE-37`,
parent key, labels (`group/name`, plain order), estimate (a number; anything else kept as text), due date, branch, the dates,
and `aliases` (every earlier key: an issue moved between teams is ONE card and its old keys open it). The description is the
body (an empty text when Linear has none, so a cleared text is cleared). Oldest first. Relations, pull requests, links and
comments are A6; the next-number counters are set at cutover.

- **Rule A** as in A4: a title or description with an outside address or phone number is redacted in the file, the original
  goes to `raw/issues/<KEY>.json` (local only), written before the synced file. The branch name Linear makes from the title
  (`me/pse-1-call-pat-on-555-010-0199`) is typed text the scan cannot read (a number glued to words by hyphens is not found), so
  it is left out of the synced file when the title was redacted or when it reads as flagged with its hyphens spaced; the
  original is in the raw record. The names of states, labels and milestones are
  A4's (their originals are in `raw/names` and the project records); they read the same here.
- **Order does not matter**: a child before its parent, a parent that is archived or in another team, all resolve by key.
  A parent that is not in the export, an unknown state, project, cycle, milestone, label, assignee or creator is counted as
  dangling and the issue is still written without it.
- **Aliases**: a key that is another issue's real key is not kept (the real card wins), and a key two issues claim stays with
  the older issue; the dry run and the real run both print `N NOT KEPT`. A key that is the file or alias of a card this export
  does not know is refused by the store (`alias-conflict`): that card is not written and the run exits 1.
- **A card that moved teams since an earlier run** is the same Linear issue under an older key: the new file is written and
  the old one retired in the same step (`moved: N`), with its thread file, and with what a later ticket put in it
  (`relations`, `prs`, `links`, `deleted` are never cleared by a rerun of the text). A file of any other card is never touched.
- **A held lock stops the run** at the first write (each later write would wait ten seconds for it).
- **Checked after a real run, against the files**: every card is there, every alias opens the card that claims it, every child's
  file names its parent and the parent is a card (`checked on the files: ...`); a broken one makes the run exit 1.
- **Estimates and priorities**: the export format carries an estimate as a number and a priority as a whole number, which is
  what Linear's API serves; a whole number outside 0 to 4 is kept as text. A text value cannot arrive (the export is refused first).
- **Runs twice, changes nothing**, as A4. A write is O(files) in the store (an index refresh per write): 1,464 issues take about
  40 s a run. The tests use a tenth of that size; `BOARD_FULL_SIZE=1 node --test scripts/lib/board-import/apply.test.mjs` runs the full size.

On the real export (read-only dry run, 2026-11-16, counts only): 1,464 issues (PSE 1,030, INS 178, REV 130, AER 126), 573
archived (439, 118, 6, 10), 600 issues with 1,214 earlier keys, 177 with a parent, 43 with a title, description or branch name
redacted or left out (29 by title or description; 14 more only through the branch name, 17 branch names left out in all), no
dangling reference. The counts equal the inventory.
