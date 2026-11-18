import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { serializeDocument } from './frontmatter.mjs';
import { IssueIndex } from './issue-index.mjs';

// Regression tests for the second round of CodeRabbit findings on PR #15 (2026-11-18, Devon's triage).

let root;
let n = 0;
before(() => {
	root = mkdtempSync(join(tmpdir(), 'board-cr15b-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

function dirs() {
	const base = join(root, `i${n++}`);
	mkdirSync(join(base, 'issues', 'PSE'), { recursive: true });
	return { base, issues: join(base, 'issues'), cachePath: join(base, 'logs', 'index.json') };
}
function put(issues, id, fields = {}, body = '') {
	const path = join(issues, 'PSE', `${id}.md`);
	writeFileSync(path, serializeDocument({ id, title: `Title ${id}`, ...fields }, body));
	return path;
}

test('a cache file made for another issues folder is discarded, even when names, mtimes and sizes all match', async () => {
	const a = dirs();
	const b = dirs();
	const when = new Date('2026-05-05T10:00:00Z');
	for (let i = 1; i <= 3; i++) {
		const fromA = put(a.issues, `PSE-${i}`, { status: 'Todo' });
		const fromB = put(b.issues, `PSE-${i}`, { status: 'Done' }); // same length as 'Todo'
		utimesSync(fromA, when, when);
		utimesSync(fromB, when, when);
		assert.equal(statSync(fromA).size, statSync(fromB).size);
	}
	await new IssueIndex(a.issues, { cachePath: a.cachePath }).refresh();
	mkdirSync(join(b.base, 'logs'), { recursive: true });
	copyFileSync(a.cachePath, b.cachePath);

	const index = new IssueIndex(b.issues, { cachePath: b.cachePath });
	assert.deepEqual(await index.refresh(), { count: 3, reread: 3 });
	assert.equal(index.get('PSE-2').fields.status, 'Done', 'the fields come from the files of this folder');

	const again = new IssueIndex(b.issues, { cachePath: b.cachePath });
	assert.deepEqual(await again.refresh(), { count: 3, reread: 0 }, 'the cache this folder saved is used');
});

test('a version 1 cache file is discarded, with or without a folder in it', async () => {
	const { issues, cachePath } = dirs();
	for (let i = 1; i <= 3; i++) put(issues, `PSE-${i}`);
	await new IssueIndex(issues, { cachePath }).refresh();
	const saved = JSON.parse(readFileSync(cachePath, 'utf-8'));
	assert.equal(saved.version, 2);
	assert.equal(typeof saved.dir, 'string');
	writeFileSync(cachePath, JSON.stringify({ version: 1, dir: saved.dir, files: saved.files })); // right folder, old version
	assert.deepEqual(await new IssueIndex(issues, { cachePath }).refresh(), { count: 3, reread: 3 });
	writeFileSync(cachePath, JSON.stringify({ version: 1, files: saved.files })); // the old format itself
	assert.deepEqual(await new IssueIndex(issues, { cachePath }).refresh(), { count: 3, reread: 3 });
});

const HEAD_BYTES = 32 * 1024;

test('a head that is cut right after `---` of a longer line does not close the block: the whole file is read', async () => {
	const { issues, cachePath } = dirs();
	const open = '---\nid: "PSE-1"\ntitle: "';
	const close = '"\n';
	const pad = 'a'.repeat(HEAD_BYTES - 3 - Buffer.byteLength(open + close));
	const text = `${open}${pad}${close}${'-'.repeat(40)}\nafter: "x"\n---\n\nbody\n`;
	assert.equal(text.slice(HEAD_BYTES - 3, HEAD_BYTES), '---', 'the 32 KiB head ends with the first three dashes of the long line');
	writeFileSync(join(issues, 'PSE', 'PSE-1.md'), text);
	const index = new IssueIndex(issues, { cachePath });
	await index.refresh();
	assert.equal(index.get('PSE-1')?.fields.after, 'x', 'the field after the long line is read');
	assert.equal(index.get('PSE-1').fields.title.length, pad.length);
});

test('a big file whose front matter closed inside the head is not read a second time', async () => {
	const { issues, cachePath } = dirs();
	put(issues, 'PSE-1', {}, `${'line of the description\n'.repeat(3000)}---`.slice(0, 80000));
	const path = join(issues, 'PSE', 'PSE-1.md');
	assert.ok(statSync(path).size > HEAD_BYTES);
	const real = fsp.readFile;
	let wholeReads = 0;
	fsp.readFile = async (file, ...rest) => {
		if (String(file) === path) wholeReads++;
		return real(file, ...rest);
	};
	syncBuiltinESMExports();
	try {
		const index = new IssueIndex(issues, { cachePath });
		await index.refresh();
		assert.equal(index.get('PSE-1').fields.title, 'Title PSE-1');
	} finally {
		fsp.readFile = real;
		syncBuiltinESMExports();
	}
	assert.equal(wholeReads, 0);
});
