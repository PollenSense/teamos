# Linear fetcher (`scripts/lib/linear/`)

Reads a Linear workspace, **read-only**, into the export folder of `../board-export/` (ticket A2 of the team work
board; Linear inside TeamOS, phase (a)). It fills the folder; a separate importer (A4 to A6) reads it. Nothing here
writes to Linear, to the board store or to Drive.

```
LINEAR_API_KEY=... node scripts/board-fetch-linear.mjs --workspace <synced folder> --out <export folder> [--types a,b] [--dry-run]
```

Exit 0 ok, 1 error, 2 usage, 3 stopped on a budget or the rate limit (nothing written). Output is counts only.
`--dry-run` reads everything, checks every record against the export format and writes nothing. The export folder is
checked with the sync guard (`board-export/sync-filter.mjs`) **before the first request**. `--types` reads only the
named types: the export is then marked `complete: false` (the importer refuses it unless told otherwise) and the run
refuses to write into a folder that already holds an export, so a partial read can never replace a full one (naming
every type is a full read). The command line is `lib/linear/cli.mjs` (`runCli`, tested against the fake Linear); the
script only calls it.

## Read-only by construction

- `documents.mjs` is the whole list of GraphQL documents. The client takes a document **name**, never query text; a name
  not on the list (`__proto__`, `constructor`, anything) and a variable the document does not declare are refused before a
  request. A test checks that every document is exactly one query with no mutation, subscription or fragment, and that
  the whole run sends nothing else. The key's own read-only scope is the real lock; this is the second one.
- The key is read from the environment only (`LINEAR_API_KEY_RO` first, then `LINEAR_API_KEY`: the order of
  `scripts/linear-api.sh`). No argument, option or file carries it. It is sent as the `Authorization` header (no `Bearer`) and is scrubbed
  from every error text, along with anything shaped like a Linear key.
- Optionally validate the documents against Linear's public schema:
  `LINEAR_SCHEMA_FILE=<schema.graphql> GRAPHQL_MODULE=<graphql/index.mjs> node --test scripts/lib/linear/documents.test.mjs` (schema:
  `github.com/linear/linear`, `packages/sdk/src/schema.graphql`; `graphql@16` from npm). One field is swapped before the
  check: label `retiredAt` is served by the live API (probed read-only on 2026-11-13: 2 of 15 labels have it, `archivedAt`
  none) but is missing from the public master schema. If Linear drops it, the first run says "Cannot query field".

## Paging, rate limits, budgets

- Every connection pages with `pageInfo`; `includeArchived: true` everywhere, `includeDisabled: true` for users
  (suspended users are former members). A page with fewer nodes than the page size is normal. `hasNextPage: true` with a
  missing, empty or repeated cursor stops the run, and so does a `hasNextPage` that is not true or false (a missing
  one used to read as "no more pages") or a record that is not an object. A nested list (a project's milestones, an
  issue's labels) with a second page also stops it (`nested-truncated`) instead of losing records.
- 429, and Linear's `RATELIMITED` answer (HTTP 400), pause for `Retry-After` (or until the request limit resets) and retry;
  the request counts that came with a 429 are dropped after the pause (they describe the window just waited out; the
  retry's own answer brings fresh ones). The reset time is read as epoch milliseconds or seconds, whichever falls inside
  the hour. A pause longer than 10 minutes, or more than 5 tries, ends the run. 5xx and network errors retry with a growing pause.
  401 and 403 stop at once. Requests are paced 300 ms apart.
- The run stops, before the next request, with fewer than 200 requests left in the hour or less than 10 percent of the
  complexity budget (3,000,000 an hour, shared by every key on the account). The export is written only after the whole
  read succeeded, so a stopped run leaves no half export.

## What was measured

Two dry runs against the real workspace on 2026-11-13 (read-only key, counts only, nothing written): 102 requests each,
about two minutes; 4 teams, 39 states, 18 users, 15 labels, 150 cycles, 63 projects, 27 milestones, 29 project updates,
17 documents, 1,464 issues, 1,498 comments, 121 relations, 1,081 attachments, which are the inventory's counts
(`docs/linear-inventory-api-2026-11-12.md`). Two things the first run showed: a projects query with 50 per page and wide
nested lists is "too complex" (the limit is 10,000 points a query; projects now read 20 at a time), and 12 comments sit on
projects, which the export format now has a place for (second run: none skipped).

## Tests

`node --test scripts/lib/linear/*.test.mjs`: a scripted stand-in for Linear (`fake-linear.mjs`, invented data), no network,
no key (the CLI tests build their own environment). Each guard above was removed in turn and a test failed.

## Known limits

- Records the board format has no place for are skipped and counted (a comment on nothing it knows, a relation to a
  missing issue, an attachment with no issue); the run prints the counts.
- Initiatives, customers, views and templates are not read (none are used: inventory section 1).
- The incremental poll (A11) is a separate ticket; this reads everything.
