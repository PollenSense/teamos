# Board export folder (`scripts/lib/board-export/`)

The hand-over between whatever reads a tracker (today the Linear fetcher) and the importer of the team work board
(Linear inside TeamOS, phase (a), ticket A2b). A fetcher writes a folder; the importer reads it. Nothing else connects
them, so any other source works if it writes the same files. Nothing here talks to a network or to the board store.

## Layout (version 1)

```
<export folder>/
  export.json         manifest: format, version, source, fetchedAt, complete, one entry per file (count, sha256, bytes)
  users.json          { "type": "users", "version": 1, "records": [ ... ] }
  teams.json  states.json  labels.json  cycles.json  projects.json  milestones.json
  projectUpdates.json  documents.json  issues.json  comments.json  relations.json  attachments.json
```

One file per entity type; record order and file order do not matter. Records name each other by `id` (the source's own
opaque string) and issues by `key` (`PSE-1061`). A record may carry more fields than the spec lists: they are kept.
The field list of every type, and its kind, is `ENTITY_TYPES` in `format.mjs` (the one place; this README does not copy it).

## Reading and writing

- `writeExport(dir, { source, fetchedAt?, complete?, entities }, { workspaceRoot, filterText })` validates every record,
  asks the sync guard (below), writes each file through a temp file and a rename, writes the manifest last, and removes
  the files of types left out (fixed names only). It refuses a folder that has files but no manifest.
- `readExport(dir, { require?, allowIncomplete?, maxFileBytes? })` opens only the fixed file name of each known type
  (never a path from the manifest, never a link), compares size limit, sha256 and record count with the manifest, and
  validates every record. A run that stopped half-way leaves files that no longer match the manifest: refused as
  `hash-mismatch`, never imported as a mix. An export marked `complete: false` is refused unless the caller allows it.
- A manifest with a **newer version** is refused: `version-newer`, "this export is format version N; this TeamOS reads up
  to version 1. Update TeamOS before importing it."
- Errors are `ExportError` with a `code`. Messages name the type, the record's position and the field, **never a value**:
  values can be person data and error text lands in logs.

## Person data and where the folder may live

The folder holds descriptions, comments and e-mail addresses (`users.json` carries `email` so the importer can match a
Linear user to a TeamOS member). It is **never synced to Drive**. Every writer calls `assertLocalOnly(folder, { workspaceRoot,
filterText })` first: a folder outside the synced workspace is fine; a folder inside it needs `scripts/rclone-filter.txt`
to keep it local. The guard checks four probe paths in the folder (top, one level, two levels, a dot name), so a filter
that names one depth or one extension is not enough. It follows rclone's own model (file rules and directory rules, first
match, directories walked first); see the header of `sync-filter.mjs`. Uploads (`files/`) and raw texts (`raw/`) of the
board use the same guard (A6b and the importer call it before writing).

`node scripts/board-export-check.mjs --workspace <synced folder>` prints `local` or `WOULD SYNC` per folder
(`team/board/raw`, `team/board/files` by default; `--folder` adds more; `--filter` names another filter file) and exits 1
if any would sync. Run it after the filter edit and the bisync `--resync`, before the first import.

The live check in the tests, `BOARD_RCLONE_FILTER=<path of scripts/rclone-filter.txt> node --test scripts/lib/board-export/`,
fails until the two step-0 lines (`- /team/board/raw/**`, `- /team/board/files/**`) are in that file.

## Tests

`node --test scripts/lib/board-export/*.test.mjs`. The fixture (`fixture-data.mjs`) is invented: every entity type, three
users (one suspended, one app), a moved issue with an earlier key, a bot comment. Each guard above was mutation-checked
(removed, then a test failed).

## Known limits

- Version 1 has no reference check across files (a `parentId` that names no issue). The importer (A4 to A6) resolves ids
  and reports dangling ones in its dry run.
- Include rules (`+`) in the filter are modelled approximately where they contain `**` in the middle; the guard errs
  towards "would sync".
- A file written by a producer that does not know `complete` is read as incomplete; a hand-made folder sets `"complete": true`.
