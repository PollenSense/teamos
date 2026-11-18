import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UPLOAD_HOST, dispositionFileName, extensionForType, findUploads, isFileEntry, isSafeName, isSafeRelativePath, needsTextScan, parseUploadUrl, redactFileName, safeFileName, splitExtension, uniqueName, uploadId } from './uploads.mjs';

/** Invented data only: hosts are the real upload host (a pattern, not data); ids, names and texts are made up. */

const U = (path) => `https://${UPLOAD_HOST}/ws-1/${path}`;

test('uploadId is the same for a link with or without a query string or fragment, and differs for another path', () => {
	const a = uploadId(U('aaa/bbb'));
	assert.match(a, /^[0-9a-f]{16}$/);
	assert.equal(uploadId(`${U('aaa/bbb')}?t=1#x`), a);
	assert.notEqual(uploadId(U('aaa/ccc')), a);
	assert.notEqual(uploadId(`https://${UPLOAD_HOST}/ws-2/aaa/bbb`), a);
});

test('parseUploadUrl keeps only https links on the upload host, drops sentence punctuation and the fragment', () => {
	assert.equal(parseUploadUrl(U('a/b')), U('a/b'));
	assert.equal(parseUploadUrl(`${U('a/b')}.`), U('a/b'));
	assert.equal(parseUploadUrl(`${U('a/b')}?x=1#frag`), `${U('a/b')}?x=1`);
	for (const bad of [
		`http://${UPLOAD_HOST}/ws/a/b`, `https://${UPLOAD_HOST}.example.invalid/ws/a/b`, `https://user:pw@${UPLOAD_HOST}/ws/a/b`, `https://${UPLOAD_HOST}:8443/ws/a/b`,
		`https://${UPLOAD_HOST}/`, 'https://example.invalid/ws/a/b', 'not a link', '', null, undefined, 5,
	]) assert.equal(parseUploadUrl(bad), null, String(bad));
});

test('findUploads finds links in descriptions and in comments on issues, one entry per issue key and link', () => {
	const found = findUploads({
		issues: [
			{ key: 'PSE-1', description: `Look: ![shot one](${U('a/one')}) and [a file](${U('a/two')}) and bare ${U('a/three')}, and ${U('a/one')} again.` },
			{ key: 'PSE-2', description: 'No uploads. [x](https://example.invalid/not/ours) ' },
		],
		comments: [
			{ id: 'c1', issueKey: 'PSE-1', body: `Same file ![](${U('a/one')}) and a new one ![label](${U('a/four')}?v=2)` },
			{ id: 'c2', issueKey: 'PSE-2', body: `![](${U('b/five')})` },
		],
	});
	assert.deepEqual([...found.byKey.keys()], ['PSE-1', 'PSE-2']);
	const one = found.byKey.get('PSE-1');
	assert.equal(one.size, 4);
	const first = one.get(uploadId(U('a/one')));
	assert.deepEqual(first.texts, [{ kind: 'description' }, { kind: 'comment', comment: 'c1' }], 'one upload used in the description and in a comment is one entry with both uses');
	assert.deepEqual(first.labels, ['shot one'], 'the link text of the markdown link; an empty one is not kept');
	assert.equal(one.get(uploadId(U('a/three'))).url, U('a/three'), 'a bare link loses the comma');
	assert.equal(one.get(uploadId(U('a/four'))).url, `${U('a/four')}?v=2`, 'a query string stays in the link that is fetched');
	assert.deepEqual(found.counts, { mentions: 7, distinct: 5, inDescriptions: 4, inComments: 3, cards: 2, refused: 0, leftForLater: 0 });
});

test('findUploads counts links that only sit in documents, project updates, attachments or comments on projects as left for later', () => {
	const found = findUploads({
		issues: [{ key: 'PSE-1', description: `![](${U('a/one')})` }],
		comments: [{ id: 'c1', projectId: 'p-1', body: `![](${U('x/proj')})` }, { id: 'c2', issueKey: 'PSE-1', body: `![](${U('a/one')})` }],
		documents: [{ id: 'd-1', content: `see ${U('x/doc')}` }],
		projectUpdates: [{ id: 'pu-1', body: `![](${U('x/upd')})` }, { id: 'pu-2', body: `![](${U('a/one')})` }],
		attachments: [{ id: 'at-1', issueKey: 'PSE-1', url: U('x/att') }],
	});
	assert.equal(found.counts.leftForLater, 4, 'four more links, none of them also in an issue text; the one used twice is counted once');
	assert.equal(found.counts.distinct, 1);
	assert.equal(found.byKey.size, 1);
});

test('findUploads refuses a comment whose id could not be named in a thread file and a text with no issue key', () => {
	const found = findUploads({
		issues: [{ description: `![](${U('a/one')})` }, { key: 'PSE-1', description: '' }],
		comments: [
			{ id: 'bad id!', issueKey: 'PSE-1', body: `![](${U('a/two')})` },
			{ id: '__proto__', issueKey: 'PSE-1', body: `![](${U('a/three')})` },
			{ id: 'ok-1', issueKey: 'PSE-1', body: `![](${U('a/four')})` },
		],
	});
	assert.equal(found.counts.refused, 3, 'the issue without a key, the id with a space and the id that starts with an underscore');
	assert.equal(found.byKey.size, 1);
	assert.deepEqual([...found.byKey.get('PSE-1').values()].map((u) => u.texts[0].comment), ['ok-1']);
});

test('safeFileName: nothing leaves its folder, nothing a sync client or Windows refuses, nothing hidden', () => {
	const nasty = [
		'../../etc/passwd', '..\\..\\boot.ini', '/abs/path.png', 'C:\\x\\y.png', '.hidden.png', '...', '..', '.', ' ', '', 'a:b*c?"d<e>f|g.png',
		'con.png', 'NUL', 'Lpt1.txt', 'name.', 'name .png', ' lead.png', 'tab\there.png', 'line\nbreak.png', `u${String.fromCharCode(0x2028)}sep.png`, `bom${String.fromCharCode(0xfeff)}.png`,
		'x'.repeat(300) + '.png', String.fromCodePoint(0x1f600).repeat(79) + '.png', 'con.tar.gz', 'CONIN$', 'Conout$.txt', 'COM' + String.fromCharCode(0xb9) + '.txt', 'a/b/c/d.png', 'dots....png', '.png', 'png.', 'weird.ext-too-long',
	];
	for (const text of nasty) {
		const name = safeFileName(text);
		assert.equal(/[\\/:*?"<>|]/.test(name), false, `${JSON.stringify(text)} -> ${JSON.stringify(name)} has a forbidden character`);
		assert.equal([...name].some((ch) => { const n = ch.codePointAt(0); return n < 0x20 || n === 0x7f || n === 0x85 || n === 0x2028 || n === 0x2029 || n === 0xfeff; }), false, `${JSON.stringify(text)} has a control or line-end character`);
		assert.equal(name.startsWith('.'), false, `${JSON.stringify(text)} is hidden`);
		assert.equal(name.includes('..'), false, `${JSON.stringify(text)} has ..`);
		assert.equal(/[. ]$/.test(name), false, `${JSON.stringify(text)} ends in a dot or space`);
		assert.ok(name.length > 0 && [...name].length <= 80 + 9, `${JSON.stringify(text)} length`);
		assert.ok(Buffer.byteLength(name) <= 200, `${JSON.stringify(text)} is more than 200 bytes`);
		assert.equal(isSafeName(name), true, `${JSON.stringify(text)} -> ${JSON.stringify(name)} is not a safe name by the reading check`);
		assert.equal(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name), false, `${JSON.stringify(text)} is a device name`);
	}
	assert.equal(safeFileName('Shot One.PNG'), 'Shot One.png', 'the extension goes to lower case, the stem stays');
	assert.equal(safeFileName('a:b*c?.png'), 'a_b_c_.png');
	assert.equal(safeFileName('con.png'), '_con.png');
	assert.equal(safeFileName('con.tar.gz'), '_con.tar.gz', 'on Windows CON.anything is the device');
	assert.equal(safeFileName('.hidden.png'), 'hidden.png');
	assert.equal(safeFileName(''), 'upload');
	assert.equal(safeFileName('', { fallbackExt: 'PNG' }), 'upload.png');
	assert.equal(safeFileName('plain', { fallbackExt: 'jpg' }), 'plain.jpg');
	assert.equal(safeFileName('plain.txt', { fallbackExt: 'jpg' }), 'plain.txt', 'a name with an extension keeps it');
	assert.equal(safeFileName('x'.repeat(100) + '.png'), `${'x'.repeat(80)}.png`);
	assert.equal(safeFileName('archive.tar.gz'), 'archive.tar.gz');
	assert.equal(safeFileName(undefined), 'upload');
});

test('uniqueName numbers a name the folder has, without regard to case, and leaves the set alone', () => {
	const taken = new Set(['shot.png', 'shot-2.png', 'noext']);
	assert.equal(uniqueName('fresh.png', taken), 'fresh.png');
	assert.equal(uniqueName('Shot.PNG', taken), 'Shot-3.PNG');
	assert.equal(uniqueName('shot.png', taken), 'shot-3.png');
	assert.equal(uniqueName('noext', taken), 'noext-2');
	assert.equal(taken.size, 3);
});

test('dispositionFileName reads the quoted, escaped, extended and bare forms', () => {
	assert.equal(dispositionFileName('inline; filename="shot one.png"'), 'shot one.png');
	assert.equal(dispositionFileName('attachment; filename="a \\"quoted\\" name.csv"'), 'a "quoted" name.csv');
	assert.equal(dispositionFileName("attachment; filename*=UTF-8''caf%C3%A9.png"), 'café.png');
	assert.equal(dispositionFileName("attachment; filename=plain.png; filename*=UTF-8''better%20name.png"), 'better name.png', 'the extended form wins');
	assert.equal(dispositionFileName("attachment; filename*=UTF-8''bad%E0%A4%A.png; filename=\"fallback.png\""), 'fallback.png', 'a bad escape falls back to the plain form');
	assert.equal(dispositionFileName('attachment; filename=bare.txt'), 'bare.txt');
	assert.equal(dispositionFileName('inline'), null);
	assert.equal(dispositionFileName('inline; filename=""'), null);
	assert.equal(dispositionFileName(''), null);
	assert.equal(dispositionFileName(undefined), null);
});

test('extensionForType knows the types the real export has and answers empty for the rest', () => {
	assert.equal(extensionForType('image/png'), 'png');
	assert.equal(extensionForType('IMAGE/JPEG; charset=x'), 'jpg');
	assert.equal(extensionForType('video/quicktime'), 'mov');
	assert.equal(extensionForType('application/octet-stream'), '');
	assert.equal(extensionForType(undefined), '');
});

test('isFileEntry and isSafeRelativePath accept what the importer writes and nothing that could leave the folder', () => {
	const good = { upload: '0123456789abcdef', path: 'files/PSE-1/a.png', name: 'a.png', bytes: 3, sha256: 'a'.repeat(64) };
	assert.equal(isFileEntry(good), true);
	for (const bad of [null, [], 'x', { ...good, upload: 'xyz' }, { ...good, bytes: -1 }, { ...good, bytes: 1.5 }, { ...good, sha256: 'a'.repeat(63) }, { ...good, path: '' }, { ...good, name: 5 }]) assert.equal(isFileEntry(bad), false);
	assert.equal(isSafeRelativePath('files/PSE-1/a.png'), true);
	assert.equal(isSafeRelativePath('files/INS-5/a b.png'), true, 'a card that moved keeps its old folder');
	assert.equal(isSafeRelativePath('raw/files/PSE-1/list.csv'), true, 'a text file kept local-only');
	for (const bad of ['files/../x.png', 'files/PSE-1/../x.png', 'files/PSE-1/.hidden', '/etc/passwd', 'files/PSE-1/a/b.png', 'files/foo/a.png', 'files/PSE-1/', 'files/PSE-1/a:b.png', 'other/PSE-1/a.png', 'files/PSE-1/a\nb.png', 'raw/files/PSE-1/../x', 'raw/other/PSE-1/a.csv', 'raw/files/PSE-1/a/b.csv', 'raw/files/PSE-1/.hidden', 'raw/files/foo/a.csv', 'files/raw/PSE-1/a.csv', 'raw/PSE-1/a.csv', 5, null]) assert.equal(isSafeRelativePath(bad), false, String(bad));
});

test('splitExtension takes the last dot as the extension only when 1 to 8 letters or digits follow it', () => {
	assert.deepEqual(splitExtension('a.b.png'), { stem: 'a.b', ext: 'png' });
	assert.deepEqual(splitExtension('plain'), { stem: 'plain', ext: '' });
	assert.deepEqual(splitExtension('.png'), { stem: '.png', ext: '' });
	assert.deepEqual(splitExtension('trailing.'), { stem: 'trailing.', ext: '' });
	assert.deepEqual(splitExtension('x.ext-too-long'), { stem: 'x.ext-too-long', ext: '' });
	assert.deepEqual(splitExtension('x.abcdefghi'), { stem: 'x.abcdefghi', ext: '' }, 'nine characters are no extension');
	assert.deepEqual(splitExtension('x.abcdefgh'), { stem: 'x', ext: 'abcdefgh' });
	assert.deepEqual(splitExtension(undefined), { stem: '', ext: '' });
});

test('redactFileName scans the whole name and the stem: an address that ends the name, and one before an extension', () => {
	assert.deepEqual(redactFileName('jane.roe@outside.example.org'), { value: '[email]', flagged: true }, 'the whole name: org looks like an extension to the stem scan');
	assert.deepEqual(redactFileName('from jane@outside.example.invalid.png'), { value: 'from [email].png', flagged: true }, 'the stem without the extension');
	assert.deepEqual(redactFileName('call 555-010-0199 notes.txt'), { value: 'call [phone] notes.txt', flagged: true });
	// a finding of one scan never hides the other: a phone number in front of an address that ends in an extension
	assert.deepEqual(redactFileName('555-010-0199 jane@outside.example.invalid.png'), { value: '[phone] [email].png', flagged: true });
	assert.deepEqual(redactFileName('jane@outside.example.invalid 555-010-0199.png'), { value: '[email] [phone].png', flagged: true });
	assert.deepEqual(redactFileName('555-010-0199 jane@outside.example.org'), { value: '[phone] [email]', flagged: true });
	// an address before an inner extension, wherever it sits in the name
	assert.deepEqual(redactFileName('jane@outside.example.invalid.png 555-010-0199.png'), { value: '[email].png [phone].png', flagged: true });
	assert.deepEqual(redactFileName('jane@outside.example.invalid.png (1).png'), { value: '[email].png (1).png', flagged: true });
	assert.deepEqual(redactFileName('export jane@outside.example.invalid.csv.gz'), { value: 'export [email].csv.gz', flagged: true });
	assert.deepEqual(redactFileName('a jane@outside.example.invalid.png b joe@outside.example.invalid.png.png'), { value: 'a [email].png b [email].png.png', flagged: true });
	// a token with an at-sign before it can swallow the address after it; addresses glued with hyphens or underscores
	assert.deepEqual(redactFileName('photo@2x.png_jane@outside.example.invalid.txt'), { value: 'photo@2x.png_[email].txt', flagged: true });
	assert.equal(redactFileName('v2_photo@2x.txt_jane@outside.example.invalid.pdf').value, 'v2_photo@2x.txt_[email].pdf');
	const glued = redactFileName('jane@outside.example.invalid.csv-jane@outside.example.invalid-joe.q@outside-example.org-report.v2');
	assert.equal(glued.flagged, true);
	for (const original of ['jane@outside.example.invalid', 'joe.q@outside-example.org']) assert.equal(glued.value.includes(original), false, 'no address is left');
	// timestamps are not phone numbers once a closer look cuts their digits
	for (const fine of ['2026-05-01-14-30-22-export.csv', '2026-05-01-14-30-22.csv', 'export 2026-05-01 14-30-22.csv', 'a.b.2026.05.01.14.30.22.png', '2026-05-01-14-30-22_0501143022.png', '20260501-143022_20260501-143022.csv', 'build 1234567 2026.05.01.csv']) assert.equal(redactFileName(fine).flagged, false, fine);
	// the name without its last extension is scanned for anything, as before (a number the whole name hides behind `.123`)
	assert.deepEqual(redactFileName('5550100199.123'), { value: '[phone].123', flagged: true });
	assert.deepEqual(redactFileName('555.010.0199.123'), { value: '[phone].123', flagged: true });
	for (const fine of ['report.final.v2.pdf', 'scan 2026.05.01 10.12.45.png', 'notes.tar.gz', 'IMG_0001 (2).jpeg', 'user@2x.v2.png', '.hidden', 'a.b.c.d.e.f.g.h.i.j.png']) assert.equal(redactFileName(fine).flagged, false, fine);
	for (const fine of ['Screenshot 2026-05-01 at 10.12.45.png', 'image', 'a@b.png', 'photo@2x.png', '', undefined]) assert.equal(redactFileName(fine).flagged, false, String(fine));
	assert.equal(redactFileName('plain name.png').value, 'plain name.png');
});

test('needsTextScan: everything is scanned except pictures, video, audio, PDF and archives', () => {
	for (const [type, name] of [['text/csv', 'a.csv'], ['application/octet-stream', 'contacts.vcf'], ['application/octet-stream', 'mail.eml'], ['application/json', 'a.json'], ['image/svg+xml', 'a.svg'], ['', 'noext'], [undefined, 'a.txt']]) assert.equal(needsTextScan(type, name), true, `${type} ${name}`);
	for (const [type, name] of [['image/png', 'a.png'], ['video/mp4', 'a.mp4'], ['audio/mpeg', 'a.mp3'], ['application/pdf', 'a.pdf'], ['application/zip', 'a.zip'], ['application/octet-stream', 'a.PNG'], ['application/octet-stream', 'model.glb'], ['application/octet-stream', 'sheet.xlsx']]) assert.equal(needsTextScan(type, name), false, `${type} ${name}`);
});

test('isSafeName refuses what safeFileName never makes: a trailing dot or space, a device name, a hidden file, too many bytes', () => {
	for (const bad of ['', '.', '..', '.hidden', 'a.', 'a ', 'con.txt', 'a/b', 'a\\b', 'x'.repeat(300), 'tab\there', 5, null, undefined]) assert.equal(isSafeName(bad), false, JSON.stringify(bad));
	assert.equal(isSafeName('ok name (1).png'), true);
});
