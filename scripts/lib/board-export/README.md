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

- `writeExport(dir, { source, fetchedAt?, complete?, entities }, { workspaceRoot, filterText })` (a relative `dir` is relative to `workspaceRoot`, never to the current folder: the guard and every write use the same resolved folder; option `replaceExisting: false` refuses a folder that already holds a manifest with `export-exists`, checked in the writer's own listing right before it changes anything) builds each file's text, parses it
  back and validates the parsed records (what a reader will see: a sparse list or a Date in an object field passes in
  memory and fails after JSON) and the size against the reader's cap (`maxFileBytes`), asks the sync guard (below), writes each file through a temp file and a rename, writes the manifest last, and removes
  the files of types left out (fixed names only). It refuses a folder that has files but no manifest, except one that holds only what a first write that was killed leaves: its temp files, and entity files that begin with the writer's own header (`{"type":"<type>","version":1,"records":`); those are removed and the write goes on. A foreign file with an entity name, a link, a folder, or another version's header is refused and nothing is removed (a temp-file name counts only when it is a regular file). Run one writer per folder at a time: two writers in the same folder can leave files that match neither manifest. Fetch again after a `hash-mismatch`.
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
to keep it local. The guard checks four probe paths in the folder (top, one level, two levels, a dot name) and the
fixed file names a writer creates there (`export.json` and one `<type>.json` per entity type), so a filter that names
one depth or one extension is not enough, and `+ /team/board/raw/users.json` ahead of the exclude is caught. It follows rclone's own model (file rules and directory rules, first
match, directories walked first); see the header of `sync-filter.mjs`.

The board has two kinds of folder and a guard for each. The raw texts (`team/board/raw/`) use `assertLocalOnly` (the
importer calls it before writing). The uploads (`team/board/files/<issue key>/`) are the opposite: Van wants every
uploaded screenshot kept in Drive on its issue (2026-11-13), so that folder must stay unfiltered, and
`assertSynced(folder, { workspaceRoot, filterText })` fails (`export-hidden`) when the filter hides ANY upload-shaped path
(`uploadProbePaths`: `<folder>/<issue folder>/shot.<ext>` for the usual extensions in lower and upper case, no
extension, two levels deeper (`<issue folder>/a/b/shot.png`), the top, a dot name; the issue folders are `PSE-1` and every issue-key folder that exists
under the upload folder now, so a line for one card, `- /team/board/files/PSE-2/**`, is caught once that card has a
folder, and a card with no folder yet is not probed) or when the folder is outside the synced workspace. One visible path does not make
the folder pass: `- *.png` hides screenshots and not videos. The downloader treats what it saves as person data (open
for the work, never copy what a picture shows).

`node scripts/board-export-check.mjs --workspace <synced folder>` prints one line per folder: `local` or `WOULD SYNC` for
a folder that must stay local (`team/board/raw` by default; `--folder` names others), `syncs` or `HIDDEN` for one that must
reach Drive (`team/board/files` by default; `--synced` names others; `--filter` names another filter file). It exits 1 if
any line is wrong. Run it after the filter edit and the bisync `--resync`, before the first import.

The live check in the tests, `BOARD_RCLONE_FILTER=<path of scripts/rclone-filter.txt> node --test 'scripts/lib/board-export/*.test.mjs'`,
fails until the one step-0 line (`- /team/board/raw/**`) is in that file, and fails if a line hides any upload path of `team/board/files`.

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
