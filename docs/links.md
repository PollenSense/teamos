# Links in messages

The dashboard turns paths and ids in a message body into links. The body is never rewritten: the
server returns a `links` map next to `body` (exact text found -> where it goes), and the markdown
renderer applies it. The Raw view shows what the author wrote; code blocks and text that is already
a link are left alone; a path in `backticks` becomes a link around the code span.

What gets linked, in this order (first match wins):

| Written as | Links to | Needs |
| --- | --- | --- |
| a message id (`2026-10-12T18-44-15.508Z-0cfo`) that exists | the message, in the viewer's mailbox (`#/message/<id>`) | nothing |
| `team/members/<name>/state.md`, `todo.json`, `schedule.json` for a member in `members.json` | that member's State, Todos or Schedule tab | nothing |
| `../pollen/src/a.ts:12-20`, `pollen/src/a.ts` | the file on the repository's web host, with a line anchor (folders: `tree`) | `links.repos`; the file must exist in the checkout |
| `PollenBot/docs/x.md`, `docs/x.md` | the file (or folder) in Google Drive | `links.drive` and an index file |

Anything that is not a real path, file, member or message is left as text.

```json
{
  "links": {
    "dashboard": true,
    "repos": {
      "pollen": { "url": "https://github.com/PollenSense/pollen", "dir": "../pollen", "branch": "main" }
    },
    "drive": { "root": "PollenBot", "index": "team/.logs/drive-index.tsv" }
  }
}
```

- `dashboard` (default true): links to the dashboard's own pages. `false` turns them off.
- `repos`: the key is the name people write. `url` must be a plain https address. `dir` is the
  checkout, relative to the project root or absolute (default `../<key>`). `branch` defaults to
  `main`. Work that is not merged and pushed is not on the branch, so the link title says so.
- `drive`: `root` is the name people write for the synced folder. `index` is a tab-separated file,
  relative to the project root, of `path`, Drive id, parent id: folders end in `/`, the folder itself
  is `./`. TeamOS only reads it; the project builds it (Pollen Sense: `scripts/drive-index.sh`, run
  by the Drive sync). A path not in the index but present in the workspace links to its nearest
  indexed folder.

The server reads the config at startup; restart the dashboard after changing the block. Tests:
`npm test` in `ui/`.
