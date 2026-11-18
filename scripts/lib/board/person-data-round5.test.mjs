import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactText, redactValue, scanText } from './person-data.mjs';

// CodeRabbit on PR #19 and #20, round 5 (R5-9): digits that sit next to an address must not join a phone number into a run
// that reaches into the address. The whole number used to be dropped (`phones: 0`, `flagged: false`) and stayed in the synced
// text. Every address and number below is invented (555-010-xxxx, example.org).

test('a phone number followed by an address that starts with digits is still found (internal address)', () => {
	for (const text of ['555-010-0199 12.x@pollensense.com', 'call 555-010-0199 123.x@pollensense.com', 'call 555-010-0199 12.x@mail.pollensense.com now']) {
		const s = scanText(text);
		assert.deepEqual([s.emails, s.internalEmails, s.phones, s.flagged], [0, 1, 1, true], JSON.stringify(text));
		const r = redactText(text);
		assert.equal(r.phones, 1, JSON.stringify(text));
		assert.ok(!r.text.includes('555-010-0199'), `the number is gone: ${JSON.stringify(r.text)}`);
		assert.ok(r.text.includes('[phone]'));
		assert.match(r.text, /\d+\.x@(mail\.)?pollensense\.com/, 'our own address stays');
	}
});

test('a phone number followed by an outside address that starts with digits: the number and the address are both redacted', () => {
	const r = redactText('555-010-0199 12.x@example.org');
	assert.equal(r.text, '[phone] [email]');
	assert.deepEqual([r.emails, r.internalEmails, r.phones, r.flagged], [1, 0, 1, true]);
	const v = redactValue({ note: 'ring 555-010-0199 123.x@example.org today' });
	assert.equal(v.value.note, 'ring [phone] [email] today');
	assert.deepEqual([v.emails, v.phones], [1, 1]);
});

test('an address before the number, and an address with the number in front of its dot, behave the same', () => {
	assert.equal(redactText('12.x@example.org 555-010-0199').text, '[email] [phone]');
	assert.equal(redactText('555-010-0199, 12.x@example.org, 555-010-0198').text, '[phone], [email], [phone]');
	// no space: the plus belongs to a new number, no longer hidden behind the end of the address
	assert.equal(redactText('jo@example.org+555-010-0199').text, '[email][phone]');
});

test('digits inside an address are still not a number, and a quoted internal address still hides no number', () => {
	for (const text of ['jo.5550100199@example.org', '555-010-0199@example.org', '1234567@example.org']) {
		const r = redactText(text);
		assert.equal(r.text, '[email]', text);
		assert.equal(r.phones, 0, text);
	}
	for (const text of ['5550100199@pollensense.com', '12.5550100199@pollensense.com']) {
		const r = redactText(text);
		assert.equal(r.text, text, 'our own address is kept whole');
		assert.deepEqual([r.phones, r.flagged], [0, false], text);
	}
	const quoted = redactText('"call 555-010-0199 now"@pollensense.com');
	assert.equal(quoted.phones, 1, 'a quoted local part of ours is free text, so a number in it is found');
});

test('a number with an address on each side is found once, and a second pass finds nothing more', () => {
	const text = 'a.b@example.org 555-010-0199 12.x@pollensense.com';
	const r = redactText(text);
	assert.deepEqual([r.emails, r.internalEmails, r.phones], [1, 1, 1]);
	assert.equal(r.text, '[email] [phone] 12.x@pollensense.com');
	const again = scanText(r.text);
	assert.deepEqual([again.emails, again.phones, again.flagged], [0, 0, false]);
});
