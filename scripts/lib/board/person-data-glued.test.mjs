import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactText, scanText } from './person-data.mjs';

// Devon, 11/18 (TeamOS todo nx4w): an address glued to the one before it by `_ - . + %` was missed, and the scan then read the
// earlier domain as a local part, so `u1@` (and on longer chains whole addresses) stayed in the synced text. Every address is
// invented.

const ACUTE = String.fromCharCode(0x0301);
const chain = (k, sep, domain = 'outside.example.invalid') => Array.from({ length: k }, (_, i) => `u${i}@${domain}`).join(sep);

for (const sep of ['_', '-', '.', '+', '%']) {
	test(`addresses joined by ${JSON.stringify(sep)}: every one is found and no at-sign is left (2 to 6 addresses)`, () => {
		for (let k = 2; k <= 6; k++) {
			const r = redactText(chain(k, sep));
			assert.equal(r.emails, k, `${k} joined by ${sep}`);
			// Only labels and joining characters are left (with `-` the first domain may end one label early: the hyphen-letter
			// rule keeps `invalid-u1` together, so `.invalid-u1@...` is read as the next address; nothing of either stays).
			assert.match(r.text, /^\[email\](?:[._%+-]\[email\])*$/, `${k} joined by ${sep}: ${r.text}`);
			assert.equal(r.text.split('[email]').length - 1, k);
			assert.equal(scanText(chain(k, sep)).emails, k);
		}
	});
}

test('a dot join with a letters-only local part is two addresses, not a longer domain and a stray at-sign', () => {
	assert.equal(redactText('jo@example.org.bob@example.net').text, '[email].[email]');
	assert.equal(redactText('a@example.org.bob@pollensense.com').text, '[email].bob@pollensense.com');
});

test('our own address glued after an outside one is counted, not redacted', () => {
	const r = redactText('jo@example.org_sales@pollensense.com');
	assert.deepEqual([r.text, r.emails, r.internalEmails], ['[email]_sales@pollensense.com', 1, 1]);
});

test('a number in quotes between two of our addresses is still a number', () => {
	const r = redactText("x@pollensense.com'555-010-0199'sales@pollensense.com");
	assert.equal(r.text, "x@pollensense.com'[phone]'sales@pollensense.com");
	assert.deepEqual([r.emails, r.internalEmails, r.phones], [0, 2, 1]);
});

test('a number right after a chain ending in our own address is still a number', () => {
	assert.equal(redactText('jo@example.org_+u1@pollenwise.com+555-010-0199').text, '[email]_+u1@pollenwise.com[phone]');
});

test('glued after an apostrophe or a mark, and with non-ASCII local parts', () => {
	assert.equal(redactText(`jo@example.org'bo@example.net`).text, `[email]'[email]`);
	assert.equal(redactText(`jo@example.org${ACUTE}_bo@example.net`).text.includes('@'), false);
	assert.equal(redactText('josé@example.org_üß@example.net').text, '[email]_[email]');
});

test('a file name before the address keeps its separator and stays', () => {
	assert.equal(redactText('photo@2x.png_jane@outside.example.invalid').text, 'photo@2x.png_[email]');
});

test('the unglued cases do not change', () => {
	assert.equal(redactText('jo@example.org bo@example.net').text, '[email] [email]');
	assert.equal(redactText('jo@example.org, sales@pollensense.com').text, '[email], sales@pollensense.com');
	assert.equal(redactText('_jo@example.org').text, '[email]');
});
