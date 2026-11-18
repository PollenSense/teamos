# Reference-data importer (`scripts/lib/board-import/`)

Reads a board export folder (`scripts/lib/board-export/`) and writes the reference data of the team work board:
people, teams with workflow states, cycles, labels, projects with milestones and updates, documents, and the map from
message tags to projects. Phase (a) of Linear inside TeamOS, ticket A4. Issues are A5; relations, pull requests, links and comments (A6) are in the section at the end.
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
plan, so people, project codes, label names and cycles in an issue always equal the reference files. `--apply` refuses (exit 2)
until `board-import-reference.mjs --apply` has written the reference files these cards name: people and labels (by Linear id
and name), project files and cycle files (by Linear id). A file that is missing, older, or made from another export or people
map counts as a gap; the message gives the counts (people, projects, labels, cycles) and never a name. A dry run only prints
the same note. A reference file that is damaged cannot be compared and is no gap (the reference import never overwrites it):
it is noted, and the run goes on.

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
  If two of the old cards have a thread file, or one does and the new card already has one, nothing is changed and the
  write is refused as `thread-conflict` (a dry run says so too): a person merges the threads first. An existing card at the
  new key is replaced only when its `linearId` is this issue's; another issue's card, or a native card with no `linearId`,
  is refused as `duplicate-id` and left as it is.
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

## Relations, pull requests, links and comments (ticket A6, `links.mjs`)

`board-import-issues.mjs` also reads the export's `relations`, `attachments` and `comments` and writes them with the issues
(`planLinks`, then `withLinks` adds the fields to the issue plan; `applyIssues` writes thread files after the cards).

- **Keys** resolve through the plan: a real key first, then an earlier key the plan kept as an alias (so `INS-5` finds the card
  that moved to `PSE-2`). A key nobody holds is dangling and left out, counted per kind (`relations.issue`, `attachments.issue`,
  `comments.issue`).
- **Relations** become `relations: {blocks, blockedBy, related, duplicateOf}` (only the non-empty keys). `blockedBy` is the
  inverse of `blocks`; `related` is on both sides; `duplicateOf` is one key (a second one is kept as `related` on both sides and
  counted). A relation to the issue itself, a repeat (also a `related` pair seen from the other side) and a type the board does
  not know are counted and left out. Keys sort as numbers (`PSE-9` before `PSE-10`).
- **Pull requests**: a `github` attachment whose address is `https://github.com/<owner>/<repo>/pull/<n>` becomes `prs: [{url, repo,
  number, state}]` with `state` open, closed or merged (the metadata's status, else its `mergedAt` / `closedAt`; draft and
  in-review are open). The address is rebuilt (no query or fragment); nothing else of the metadata is kept (no title, branch,
  reviewer or login). The same pull request on two issues is an entry on each; twice on one issue is one entry.
- **Links**: every other attachment becomes `links: [{url, title, sourceType}]`. Only `http` and `https` addresses without a
  user name or password are kept (a `javascript:` or `data:` link would run when shown); the others are counted as refused.
  Rule A applies to url, title and source type: an outside address or phone number is redacted in the issue file and the original
  goes to `raw/links/<KEY>.json`, written first.
- **Comments on issues** become entries of `<KEY>.thread.md` (format in `scripts/lib/board/README.md`), oldest first (the
  instant, then the text of the time, then the id), author from the people map, else `bot:<name>` or `external:<name>`, else
  `unknown`; a reply names the comment it answers when that comment is on the same issue (otherwise dangling). A text is redacted
  by rule A and the original of a changed comment goes to `raw/comments/<id>.json`. **No comment text is ever in an issue
  file.** Comments on projects, documents and project updates are counted and left for later.
- **A rerun**: the plan decides `relations`, `prs` and `links` (a relation Linear removed goes); only `deleted` is carried over
  from the old file. In a thread, Linear's own entries are replaced by what the export says now (a comment deleted in Linear
  goes) and entries from any other source stay. A thread file that cannot be read as a thread is counted as failed, never
  overwritten, and the run exits 1. A card whose write was refused gets no thread.
  A native entry and a Linear comment with the same id cannot share a thread: that thread is counted as failed (`bad-value`), left as
  it was, and the run exits 1 (nothing is lost; native ids must not look like Linear's, which is a phase (b) rule). When every
  Linear comment of an issue is gone, its thread file stays as an empty file (or holds the native entries). The dry run reads the
  thread of a card that moved under its old key, so it says what the real run will do.
  The report's `dangling references` line adds the link plan's kinds (`relations.issue`, `attachments.issue`, `comments.issue`,
  `comments.author`, `comments.parent`, `comments.target`) to the issue plan's.
- **Checked after a real run, against the files**: every issue a relation names is a card and the file holds the planned relations;
  every thread holds the planned comments, in order. A broken one makes the run exit 1. The run's second `--apply` changes no file.

On the real export (read-only dry run and a full apply on a scratch board, 2026-11-17, counts only): 121 relations (blocks 69,
duplicate 7, related 45; none dangling), 210 pull requests, all kept (merged 195, closed 7, open 8, as Linear), 871 other links
(Jira 846, api 21, Teams 4), 1,439 comments on issues in 1,003 thread files (people 527, bots 912; 245 replies; 18 had text
redacted), 59 comments left for later (12 on projects, 38 on documents, 9 on project updates). The apply ran in about a minute,
exit 0, every check held, and a second apply changed no file.
