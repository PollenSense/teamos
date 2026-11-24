import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactText, redactValue, scanText } from './person-data.mjs';

// CodeRabbit on PR #19, round 4: a mark after the last letter of the domain made an outside address look like ours.
// Every address below is invented (someone@..., example.org).
const ch = (...codes) => String.fromCodePoint(...codes);
const ACUTE = ch(0x0301);
const DOT_BELOW = ch(0x0323);

test('an address whose domain only looks like ours (a combining mark after the last letter) is an outside address and is redacted', () => {
	for (const domain of ['pollensense.com', 'mail.pollensense.com', 'pollenwise.com', 'POLLENSENSE.COM']) {
		for (const marks of [ACUTE, `${ACUTE}${DOT_BELOW}`]) {
			const text = `write to someone@${domain}${marks} please`;
			const r = redactText(text);
			assert.equal(r.emails, 1, `counted as outside: ${JSON.stringify(text)}`);
			assert.equal(r.internalEmails, 0, JSON.stringify(text));
			assert.equal(r.text, 'write to [email] please', JSON.stringify(text));
			assert.equal(r.flagged, true);
			const s = scanText(text);
			assert.deepEqual([s.emails, s.internalEmails, s.flagged], [1, 0, true]);
		}
	}
	// the same inside structured values
	const v = redactValue({ who: `someone@pollensense.com${ACUTE}`, ours: 'someone@pollensense.com' });
	assert.equal(v.value.who, '[email]');
	assert.equal(v.value.ours, 'someone@pollensense.com');
	assert.deepEqual([v.emails, v.internalEmails], [1, 1]);
});

test('our own addresses are still counted and kept', () => {
	const text = 'someone@pollensense.com, x@mail.pollensense.com and someone@pollenwise.com.';
	const r = redactText(text);
	assert.equal(r.text, text);
	assert.deepEqual([r.emails, r.internalEmails, r.flagged], [0, 3, false]);
});
