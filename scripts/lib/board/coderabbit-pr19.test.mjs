import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersonDataReport, redactText, redactValue, scanText } from './person-data.mjs';

// Regression tests for the CodeRabbit findings on PR #19 (2026-11-18, Devon's triage). Every address and number is
// invented (example.org, pollensense.com is only used as "one of our own domains", 555 numbers). Non-ASCII
// characters are built from code points, never typed.
const ch = (...cps) => String.fromCodePoint(...cps);
const LIGATURE_FFI = ch(0xfb03); // NFKC: ffi (1 character becomes 3)
const ELLIPSIS = ch(0x2026); // NFKC: ... (1 becomes 3)
const TEL_SYMBOL = ch(0x2121); // NFKC: TEL
const ACUTE = ch(0x301);
const GRAVE = ch(0x300);

// --- finding 7: the scan copy is longer than the text ---

test('a character that NFKC writes as several letters before an address does not hide the address', () => {
	for (const lead of [LIGATURE_FFI, ELLIPSIS, TEL_SYMBOL, `${LIGATURE_FFI}${LIGATURE_FFI}${ELLIPSIS}`]) {
		const r = redactText(`${lead} jo@example.org`);
		assert.equal(r.text, `${lead} [email]`, lead);
		assert.equal(r.emails, 1);
		assert.ok(!r.text.includes('example.org'));
	}
	const phone = redactText(`${LIGATURE_FFI} 555-010-0199 ${ELLIPSIS} jo@example.org end`);
	assert.equal(phone.text, `${LIGATURE_FFI} [phone] ${ELLIPSIS} [email] end`);
	assert.deepEqual([phone.emails, phone.phones], [1, 1]);
});

test('a long text of expanding characters maps back to the right places', () => {
	const unit = `${LIGATURE_FFI}${ELLIPSIS}${TEL_SYMBOL} jo@example.org `;
	const r = redactText(unit.repeat(2000));
	assert.equal(r.emails, 2000);
	assert.equal(r.text, `${LIGATURE_FFI}${ELLIPSIS}${TEL_SYMBOL} [email] `.repeat(2000));
});

// --- finding 8: combining marks ---

test('an address written with combining marks is found, in the local part, the domain and the last label', () => {
	const cases = [
		[`jose${ACUTE}@example.org`, '[email]'],
		[`a.jose${ACUTE}${GRAVE}@example.org`, '[email]'],
		[`jo@exampl${ACUTE}e.org`, '[email]'],
		[`jo@example.or${ACUTE}g`, '[email]'],
		[`jo@example.org${ACUTE}`, '[email]'],
		[`say jose${ACUTE}@example.org please`, 'say [email] please'],
	];
	for (const [input, expected] of cases) {
		const r = redactText(input);
		assert.equal(r.text, expected, JSON.stringify(input));
		assert.equal(r.emails, 1, JSON.stringify(input));
		assert.equal(r.flagged, true);
	}
	assert.equal(scanText(`jose${ACUTE}@example.org`).flagged, true);
	// a last label that is far too long is still no address
	assert.equal(redactText(`jo@example.${'o'.repeat(30)}`).emails, 0);
});

test('a mark right after the address does not stop it being found, whatever follows the mark (independent review)', () => {
	const VS16 = ch(0xfe0f);
	const KEYCAP = ch(0x20e3);
	const cases = [
		[`mail jo@example.org${ACUTE}5 please`, `mail [email]${ACUTE}5 please`],
		[`jo@example.org${VS16}2026`, `[email]${VS16}2026`],
		[`jo@example.org${KEYCAP}1`, `[email]${KEYCAP}1`],
		[`jo@example.org${ACUTE}ab5`, `[email]${ACUTE}ab5`],
		[`jo@example.org${ACUTE}-x`, `[email]${ACUTE}-x`],
	];
	for (const [input, expected] of cases) {
		const r = redactText(input);
		assert.equal(r.emails, 1, JSON.stringify(input));
		assert.equal(r.text, expected, JSON.stringify(input));
	}
});

test('a mark after the last label does not change which domain it is (our own address stays ours, a file name stays a file name)', () => {
	const VS16 = ch(0xfe0f);
	const ours = redactText(`jo@pollensense.com${VS16}`);
	assert.deepEqual([ours.emails, ours.internalEmails, ours.text], [0, 1, `jo@pollensense.com${VS16}`]);
	const file = redactText(`icon@2x.png${ACUTE}`);
	assert.deepEqual([file.emails, file.phones], [0, 0]);
	assert.equal(redactText(`jo@sub.pollensense.com${ACUTE}`).internalEmails, 1);
});

test('composed accented letters and plain ascii addresses still behave as before', () => {
	assert.equal(redactText(`jos${ch(0xe9)}@example.org`).text, '[email]');
	assert.equal(redactText('jo@example.org').text, '[email]');
	assert.equal(redactText('jo@example.org and sales@pollensense.com').text, '[email] and sales@pollensense.com');
	assert.equal(redactText('icon@2x.png').emails, 0);
});

// --- finding 9: the kept-run test must not restart at the first run ---

test('many dotted international numbers are scanned in linear time', () => {
	for (const unit of ['+44.20.7946.0958 ', '+1.555.010.0199 ']) {
		const started = Date.now();
		const r = redactText(unit.repeat(128000));
		const ms = Date.now() - started;
		assert.equal(r.phones, 128000, unit);
		assert.ok(ms < 5000, `${ms} ms for 128,000 of "${unit.trim()}"`);
	}
	// kept runs and masked ones interleave: a date, a version number, then a dotted phone, over and over
	const mixed = '2026-11-13 1.2.3 +44.20.7946.0958 10:42 '.repeat(20000);
	const started = Date.now();
	assert.equal(redactText(mixed).phones, 20000);
	assert.ok(Date.now() - started < 5000);
});

test('a dotted phone next to a date or a version number is still one phone, and the date and the version stay', () => {
	const r = redactText('on 2026-11-13 v1.2.3 call +44.20.7946.0958 at 10:42');
	assert.equal(r.text, 'on 2026-11-13 v1.2.3 call [phone] at 10:42');
	assert.equal(r.phones, 1);
});

// --- finding 10: a number inside one of our own addresses is part of the address ---

test('digits inside an internal address are not a phone number; a number next to it still is', () => {
	for (const input of ['sales.5550100199.x@pollensense.com', '5550100199@pollensense.com', 'jo_5550100199@pollensense.com']) {
		const r = redactText(input);
		assert.equal(r.text, input, input);
		assert.equal(r.phones, 0, input);
		assert.equal(r.internalEmails, 1, input);
		assert.equal(r.flagged, false, input);
	}
	const outside = redactText('jo.5550100199.x@example.org');
	assert.deepEqual([outside.text, outside.phones, outside.emails], ['[email]', 0, 1]);
	const beside = redactText('call 555-010-0199 or sales@pollensense.com');
	assert.equal(beside.text, 'call [phone] or sales@pollensense.com');
	assert.deepEqual([beside.phones, beside.internalEmails], [1, 1]);
	// a quoted local part holds free text, so a number inside it is still a number (outside addresses are redacted whole)
	const quoted = redactText('"call 555-010-0199 now"@pollensense.com');
	assert.deepEqual([quoted.phones, quoted.internalEmails, quoted.text], [1, 1, '"call [phone] now"@pollensense.com']);
	const quotedOutside = redactText('"call 555-010-0199 now"@example.org and 555-010-0198');
	assert.deepEqual([quotedOutside.text, quotedOutside.emails, quotedOutside.phones], ['[email] and [phone]', 1, 1]);
	const both = redactText('555-010-0199 sales.5550100199.x@pollensense.com jo@example.org 555-010-0198');
	assert.equal(both.text, '[phone] sales.5550100199.x@pollensense.com [email] [phone]');
	assert.deepEqual([both.phones, both.emails, both.internalEmails], [2, 1, 1]);
});

// --- finding 11: an own __proto__ key ---

test('an own __proto__ key survives redactValue, as a plain own key, and its value is redacted', () => {
	const input = JSON.parse('{"__proto__":{"note":"jo@example.org"},"other":"x"}');
	assert.equal(Object.hasOwn(input, '__proto__'), true);
	const r = redactValue(input);
	assert.equal(Object.hasOwn(r.value, '__proto__'), true, 'the key is still there');
	assert.deepEqual(r.value.__proto__, { note: '[email]' });
	assert.equal(Object.getPrototypeOf(r.value), Object.prototype, 'the output object did not get a new prototype');
	assert.equal(r.value.note, undefined, 'nothing leaked onto the output through the prototype');
	assert.equal(r.value.other, 'x');
	assert.equal(r.emails, 1);
	assert.equal(Object.keys(r.value).join(','), '__proto__,other');
	// a string value, and a key that collides with a redacted one
	assert.equal(redactValue(JSON.parse('{"__proto__":"keep"}')).value.__proto__, 'keep');
	const collide = redactValue(JSON.parse('{"__proto__":1,"jo@example.org":2,"mail@example.org":3}'));
	assert.deepEqual(Object.keys(collide.value), ['__proto__', '[email]', '[email]#2']);
});

// --- finding 12: the report prints names ---

test('a team or field name that holds a phone-shaped number is refused without echoing it', () => {
	const report = new PersonDataReport();
	for (const [team, field] of [['PSE', '555-010-0199'], ['5550100199', 'description'], ['PSE', 'call.5550100199.x'], ['+15550100199', 'x']]) {
		assert.throws(
			() => report.add(team, field, 'plain'),
			(err) => err instanceof TypeError && /must not contain a number that looks like a phone number|plain name/.test(err.message) && !/555|0199/.test(err.message),
			`${team} ${field}`,
		);
	}
	assert.equal(report.summary().length, 0, 'nothing was counted');
	assert.ok(!/555|0199/.test(report.format().split('\n').slice(0, -1).join('\n')), 'the table has no number (the last line is the fixed limit text)');
	// ordinary names are fine, and a name that was accepted once is not scanned again
	report.add('PSE', 'description', 'plain');
	report.add('PSE', 'description', 'plain again');
	report.add('INS', 'title_2026-11-13', 'x');
	report.add('OPS', 'v1.2.3', 'x');
	assert.equal(report.summary().length, 3);
	assert.ok(!/555|0199/.test(JSON.stringify(report.summary())));
});
