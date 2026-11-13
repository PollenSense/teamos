import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOCUMENTS, DOCUMENT_NAMES } from './documents.mjs';

/** Remove string literals so words inside them do not count. */
const code = (doc) => doc.replace(/"(?:[^"\\]|\\.)*"/g, '""');

test('the list is frozen and every document is exactly one query', () => {
	assert.ok(Object.isFrozen(DOCUMENTS));
	assert.deepEqual(DOCUMENT_NAMES, Object.keys(DOCUMENTS));
	for (const [name, spec] of Object.entries(DOCUMENTS)) {
		assert.ok(Object.isFrozen(spec), `${name} frozen`);
		assert.match(spec.doc, /^query [A-Za-z]+(\(|\s)/, `${name} starts with query`);
		assert.equal((code(spec.doc).match(/\bquery\b/g) ?? []).length, 1, `${name}: one operation`);
		assert.ok(!/\b(mutation|subscription|fragment)\b/i.test(code(spec.doc)), `${name}: no mutation, subscription or fragment`);
		let depth = 0;
		let parens = 0;
		for (const ch of code(spec.doc)) {
			if (ch === '{') depth++;
			if (ch === '}') depth--;
			if (ch === '(') parens++;
			if (ch === ')') parens--;
			assert.ok(depth >= 0 && parens >= 0, `${name}: closes before it opens`);
		}
		assert.equal(depth, 0, `${name}: braces balance`);
		assert.equal(parens, 0, `${name}: parentheses balance`);
	}
});

test('declared variables are the ones the document uses and the client allows', () => {
	for (const [name, spec] of Object.entries(DOCUMENTS)) {
		const declared = [...spec.doc.matchAll(/\$([A-Za-z]+)\s*:/g)].map((m) => m[1]).sort();
		assert.deepEqual([...spec.variables].sort(), declared, `${name}`);
		const used = [...new Set([...spec.doc.matchAll(/\$([A-Za-z]+)/g)].map((m) => m[1]))].sort();
		assert.deepEqual(used, declared, `${name}: every variable that is used is declared`);
	}
});

test('every connection pages with pageInfo and reads archived records; users include suspended ones', () => {
	for (const [name, spec] of Object.entries(DOCUMENTS)) {
		if (spec.size === 0) continue;
		assert.match(spec.doc, /pageInfo \{ hasNextPage endCursor \}/, `${name} pages`);
		assert.match(spec.doc, /after: \$after/, `${name} takes a cursor`);
		assert.ok(/includeArchived: true|includeDisabled: true/.test(spec.doc), `${name} includes archived records`);
		assert.match(spec.doc, new RegExp(`first: ${spec.size}\\b`), `${name} page size matches the table`);
	}
	assert.match(DOCUMENTS.users.doc, /includeDisabled: true/);
	assert.match(DOCUMENTS.issues.doc, /filter: \{ team: \{ id: \{ eq: \$team \} \} \}/);
});

test('nested connections say whether they are truncated', () => {
	assert.match(DOCUMENTS.issues.doc, /labels\(first: \d+\) \{ pageInfo \{ hasNextPage \}/);
	assert.match(DOCUMENTS.projects.doc, /projectMilestones\(first: \d+\) \{ pageInfo \{ hasNextPage \}/);
	assert.match(DOCUMENTS.projects.doc, /teams\(first: \d+\) \{ pageInfo \{ hasNextPage \}/);
});

// Needs the schema (github.com/linear/linear, packages/sdk/src/schema.graphql) and graphql-js:
//   LINEAR_SCHEMA_FILE=<schema.graphql> GRAPHQL_MODULE=<path of graphql/index.mjs> node --test scripts/lib/linear/
// `retiredAt` on labels is served by the live API (probed read-only on 2026-11-13: 2 of 15 labels have it set,
// `archivedAt` none) but is missing from the public master schema, so that one field is swapped before checking.
const schemaOk = process.env.LINEAR_SCHEMA_FILE && process.env.GRAPHQL_MODULE;
test('every document validates against Linear\'s public schema', { skip: schemaOk ? false : 'LINEAR_SCHEMA_FILE and GRAPHQL_MODULE are not set' }, async () => {
	const { buildSchema, parse, validate } = await import(process.env.GRAPHQL_MODULE);
	const schema = buildSchema(readFileSync(process.env.LINEAR_SCHEMA_FILE, 'utf8'), { assumeValid: true });
	for (const [name, spec] of Object.entries(DOCUMENTS)) {
		const errors = validate(schema, parse(spec.doc.replace('retiredAt', 'archivedAt')));
		assert.deepEqual(errors.map((e) => e.message), [], name);
	}
});
