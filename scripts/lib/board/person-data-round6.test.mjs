import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactText, scanText } from './person-data.mjs';

// CodeRabbit on PR #21, round 6 (R5-18): a combining mark after the last label makes a different name. The address pattern
// gives the mark up when a digit follows (`com` + U+0301 + `5`), so the match ended at `com` and read as one of our own
// domains: the address stayed in the synced text. Every address is invented.

const ACUTE = String.fromCharCode(0x0301);

test('an address whose last label carries a mark and is followed by a digit is an outside address', () => {
	for (const text of [`jo@pollensense.com${ACUTE}5`, `mail jo@pollensense.com${ACUTE}5 now`, `jo@mail.pollensense.com${ACUTE}50`, `"q r"@pollensense.com${ACUTE}0`]) {
		const s = scanText(text);
		assert.deepEqual([s.emails, s.internalEmails, s.flagged], [1, 0, true], JSON.stringify(text));
		assert.ok(redactText(text).text.includes('[email]'), JSON.stringify(text));
		assert.ok(!redactText(text).text.includes('pollensense'), `the address is gone: ${JSON.stringify(redactText(text).text)}`);
	}
});

test('the cases next to it do not change: our own address stays, and a mark without a digit was already an outside address', () => {
	for (const text of ['jo@pollensense.com', 'jo@pollensense.com 5', 'jo@pollensense.com. 5', 'jo@mail.pollensense.com']) {
		assert.deepEqual([scanText(text).emails, scanText(text).internalEmails], [0, 1], text);
	}
	assert.equal(scanText(`jo@pollensense.com${ACUTE}`).emails, 1);
	assert.equal(scanText('jo@pollensense.com5').emails, 0, 'a last label with a digit is not an address (unchanged)');
});
