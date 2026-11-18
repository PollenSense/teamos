# Board store (`scripts/lib/board/`)

The files behind the team work board (Linear inside TeamOS, phase (a), ticket A1): issue, project, cycle, team and
people files under `team/board/`, written atomically, found by ID or alias, indexed without re-reading them all.
Nothing here talks to Linear or knows what an importer is; later tickets build on it (importer, API, pages).

## Layout (design 2.2)

```
team/board/
  teams/PSE.json            key, name, states, nextNumber, ...
  issues/PSE/PSE-1061.md    one issue: front matter + description
  issues/PSE/PSE-1061.thread.md   (comments; later ticket)
  projects/<code>.md        one board project: front matter + description
  cycles/PSE/37.json        one cycle
  people.json               one object; its shape belongs to the importer
team/.logs/board/           local, never synced: index.json (cache), <name>.lock
```

## File format

Front matter with **one line of JSON per value**, then the body after a blank line:

```
---
id: "PSE-1061"
title: "[x] a title: with \"quotes\""
labels: ["Bug","Portal"]
relations: {"blocks":["PSE-1070"]}
---

The description.
```

`parseDocument` / `serializeDocument` (`frontmatter.mjs`). Reading is tolerant (a hand-typed `status: In Review` reads
as that text, with a warning); a file with no front matter is `damaged` and is never overwritten. U+2028/2029 are
written as escapes. Each file type has a list of **known fields** (`store.mjs`): a write replaces them from what it
is given (a field Linear cleared disappears), and every other field already in the file is kept.

## IDs (`ids.mjs`)

`PSE-1061`: team key (2 to 10 capitals/digits, first a letter), `-`, number without leading zeros (at most 9 digits).
The ID is the file name, so nothing that passes can leave its folder. `normalizeId` is for typed text
(`pse-1061 ` finds `PSE-1061`). An issue moved between teams keeps its new ID and lists the old ones in `aliases`;
`store.readIssue('PSE-812')` opens the same card. An alias that is another issue's real ID, is claimed by two issues,
or is the card's own ID is refused (`alias-conflict`), never overwritten.

## Writes

Every write says what it replaces: `expect: 'new'` or the content hash it read earlier. Under the lock
(`lock.mjs`: exclusive-create file, pid, stale timeout) the store re-reads, compares, and renames a temp file into
place. A different hash is `changed`; identical text writes nothing (`changed: false`). Errors are `BoardError`
with a `code` (`errors.mjs`). Phase (a) has one writer, the importer; field-level merge is phase (c).

`store.nextNumber(key)` allocates IDs (one writer assumed: two waiters that take over the same stale team lock can read the same number, see the known window in `lock.mjs`); `raiseNextNumber` is for the importer's last step. `nextNumber` belongs to the allocator: `writeTeam` keeps it from the existing file and only ever raises it. A lock file with no readable content (empty, half-written) is judged by its age on disk; a stale lock that cannot be removed ends in `locked` at the deadline. A lock file that exists but cannot be read or inspected (permissions, I/O error) is `unreadable`: only "gone" (ENOENT) means released, and release never removes a lock it cannot read.

## Index (`issue-index.mjs`)

`store.index.refresh()` stats every issue file (parallel) and re-reads those whose **mtime or size** differ from the
cache (Drive can restore an older mtime on a changed file, so "newer than" is not the test). The cache lives in
memory and in `team/.logs/board/index.json` (version 2: it names the issues folder it was made for, and a cache file from another folder or an older version is ignored). `byId`, `resolve(idOrAlias)`, `entries()`, `problems` (damaged,
misplaced, id-mismatch, alias-shadowed, alias-taken; a shared alias goes to the lower issue number). A folder the index cannot read makes
`refresh()` throw: an unreadable folder is never taken for an empty one; the same holds for an issue file that cannot be inspected or read (`unreadable`, the index stays as it was): only a missing file (ENOENT) is dropped. The first 32 KiB of a file are read for its front matter; when that head stops right after a `---` that may be the start of a longer line, the whole file is read. `refresh`, `noteWritten` and `flush` run one after the other inside the process, so a note of our own write is never pruned by a refresh that began earlier. The store gives `noteWritten` the mtime and size of the temp file taken before the rename, so a file a sync replaces right after is re-read. Limit: the test is mtime or size, not content, so a sync that replaces a file with different content of the same size and the same mtime is not noticed until that file changes again. 1,500 issues: about 125 ms cold, 30 ms warm. Each write
refreshes first (to check aliases), so a write costs a stat per issue: about 4 ms at 600 issues, linear.

## Config (`config.mjs`)

`board:` in `teamos.config.json`: `path` (inside `team/`, default `team/board`), `pollMinutes`, `importer`, `teams`,
`enabled` (`true` or `false`; anything else is off). **Without the section the module is off**: `openBoard(config, repoRoot)` returns
null. A bad value turns it off with the reason instead of half on.

## Person data (`person-data.mjs`)

Rule A (Van, 2026-11-12): no outside e-mail address or phone number reaches a synced file. `redactText(text)` replaces
outside addresses with `[email]` and phone-shaped numbers (7 to 15 digits) with `[phone]`; addresses on our own domains
are counted, not redacted. `scanText` counts without changing anything; `PersonDataReport` counts texts per team and field
and prints a table. **Nothing in this file returns or prints a matched string**, only counts and the redacted text. Dates,
times, versions, IP addresses, epoch times, hashes and IDs are masked before the phone scan, so they are not phones; the
scan leans toward redacting too much. The scan runs on a normalised copy (invisible format characters dropped; non-ASCII digits, spaces, dashes, dots and at-signs folded to ASCII) and maps matches back (the maps grow with the copy: a ligature that becomes three letters does not shift what follows), so a zero-width space or fullwidth digits do not hide anything. Combining marks count as part of the letter they sit on, in the local part, the domain and the last label. Digits inside any address, ours too, belong to the address and are not a phone number (known limit: a number glued to one of OUR addresses by a dot or a `%20`, as in `555-010-0199.jo@...`, is read as part of the address; a quoted local part holds free text, so a number in one is still found). It also reads encoded at-signs (`%40`, `&#64;`, `&commat;`), addresses after a quote or `+`, quoted local parts, extensions (`x123`), `+` and national numbers with any grouping, and cuts a run holding several numbers into numbers. **Input that is not text fails closed:** `scanText` / `redactText` throw a TypeError for a number or an object; `scanValue` / `redactValue` walk arrays and plain objects (keys and values, numbers as their printed text) and throw on anything they cannot scan (a buffer, a map, a cycle). `PersonDataReport` refuses a team or field name that is not a plain name, or in which the phone scan finds a number, because it prints names (the error text never holds the name). It cannot find names of customers or other people (`REPORT_LIMIT`), nor an address or number split across lines, glued to a word by a hyphen (`phone-555-010-0199`) or written to dodge a scan (`jo at example dot org`). The importer runs
it again before every write; a flagged issue keeps its description and comments only in the local `raw/` folder.

## Tests

`node --test scripts/lib/board/*.test.mjs`
