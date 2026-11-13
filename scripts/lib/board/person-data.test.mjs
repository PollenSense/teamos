import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_INTERNAL_DOMAINS, PersonDataReport, REPORT_LIMIT, redactText, scanText } from './person-data.mjs';

// Every number and address below is invented (555 / example.org / reserved documentation ranges).
const EN_DASH = String.fromCharCode(0x2013);
const NB_HYPHEN = String.fromCharCode(0x2011);
const NBSP = String.fromCharCode(0xa0);
const THIN_NBSP = String.fromCharCode(0x202f);
const E_ACUTE = String.fromCharCode(0xe9);
const PHONES = [
	['call +1 (555) 010-0199 now', 'call [phone] now'],
	['555-010-0199', '[phone]'],
	['555.010.0199', '[phone]'],
	['5550100199', '[phone]'],
	['+44 20 7946 0958', '[phone]'],
	['+63 2 8555 0100', '[phone]'],
	['tel 555 0100', 'tel [phone]'],
	['(555) 010-0199', '[phone]'],
	['1-555-210-0199', '[phone]'],
	['+15552100199', '[phone]'],
	['+1 555 210 0199, then +44 20 7946 0958', '[phone], then [phone]'],
	['2026-11-13 10:42 call 555-010-0199', '2026-11-13 10:42 call [phone]'],
	['on 13/11/2026 555-010-0199 please', 'on 13/11/2026 [phone] please'],
	['ip 192.0.2.45 port 555-010-0199', 'ip 192.0.2.45 port [phone]'],
	// the shapes a copy from a web page or a mail client produces, and national formats
	[`555${EN_DASH}010${EN_DASH}0199`, '[phone]'],
	[`555${NB_HYPHEN}010${NB_HYPHEN}0199`, '[phone]'],
	[`+1${NBSP}555${NBSP}010${NBSP}0199`, '[phone]'],
	[`555${THIN_NBSP}010${THIN_NBSP}0199`, '[phone]'],
	['00441234567890', '[phone]'],
	['+44 (0)20 7946 0958', '[phone]'],
	['Tel.: 0171 1234567', 'Tel.: [phone]'],
	['0171/1234567', '[phone]'],
	['+49 171 1234567', '[phone]'],
	['06 12 34 56 78', '[phone]'],
	['555 - 010 - 0199', '[phone]'],
	['tel:+15550100199', 'tel:[phone]'],
];
const NOT_PHONES = [
	'v10.0.100', '1.2.3.4', '192.0.2.45', '10.0.100.5', 'versions 10.0.100 and 8.0.404', // versions and IPs
	'2026-11-13', '13/11/2026', '13.11.2026', '2026/11/13', '2026-11-13T10:42:52Z', 'at 2026-11-13T10:42:52.123Z', '10:42:52', // dates and times
	'1731494572', '1731494572000', '20261113', '12345678901234567890', '1234567', // epoch times, counters, long numbers
	'a3f9c2d4-1b2c-4d5e-8f90-123456789abc', 'PSE-1061', 'PSE-1234567', 'sha 3f786850e387550fdab836ed7e6dc881de23001b', // ids and hashes
	'1 000 000', '3.14159265', '4/5/6', 'build 10.0.100 on 2026-11-13',
];
const EMAILS = [
	['mail jo.doe@example.org please', 'mail [email] please'],
	['a@b.co, c@d.io', '[email], [email]'],
	["o'brien+tag@sub.example.org.", '[email].'],
	['Jo.Doe@EXAMPLE.ORG', '[email]'],
	[`jo${E_ACUTE}@example.org`, '[email]'],
	[`${E_ACUTE}lise@example.invalid`, '[email]'],
	[`mail jo@exam${E_ACUTE}ple.org now`, 'mail [email] now'],
	['mailto:jo@example.org', 'mailto:[email]'],
];
const NOT_EMAILS = ['icon@2x.png', 'logo@3x.webp', 'git@github.com:org/repo.git', '@van said', '@types/node', 'user@localhost', 'a @ b', 'name@', '@example.org', 'foo@bar.js'];

test('phone-shaped numbers are redacted to [phone]', () => {
	for (const [text, want] of PHONES) {
		const r = redactText(text);
		assert.equal(r.text, want, text);
		assert.ok(r.phones >= 1, text);
		assert.equal(r.flagged, true);
	}
});

test('versions, IPs, dates, times, epoch times, hashes and IDs are not phone numbers', () => {
	for (const text of NOT_PHONES) {
		const r = redactText(text);
		assert.equal(r.text, text, text);
		assert.equal(r.phones, 0, text);
		assert.equal(r.flagged, false, text);
	}
});

test('outside e-mail addresses are redacted to [email]; file names, ssh URLs, mentions and half addresses are not addresses', () => {
	for (const [text, want] of EMAILS) {
		const r = redactText(text);
		assert.equal(r.text, want, text);
		assert.ok(r.emails >= 1);
	}
	for (const text of NOT_EMAILS) {
		const r = redactText(text);
		assert.equal(r.text, text, text);
		assert.equal(r.emails, 0, text);
	}
});

test('our own domains (and their subdomains) are counted, not redacted; a lookalike domain is outside; the list can be replaced', () => {
	const text = 'someone@pollensense.com, x@mail.pollensense.com, someone@pollenwise.com, evil@notpollensense.com';
	const r = redactText(text);
	assert.equal(r.text, 'someone@pollensense.com, x@mail.pollensense.com, someone@pollenwise.com, [email]');
	assert.equal(r.internalEmails, 3);
	assert.equal(r.emails, 1);
	assert.deepEqual(DEFAULT_INTERNAL_DOMAINS, ['pollensense.com', 'pollenwise.com']);
	const other = redactText('a@example.org nobody@pollensense.com', { internalDomains: ['example.org'] });
	assert.equal(other.text, 'a@example.org [email]');
	assert.equal(scanText('only someone@pollensense.com here').flagged, false);
	assert.equal(scanText('only someone@pollensense.com here').internalEmails, 1);
});

test('digits inside an address are not counted again as a phone number', () => {
	const r = redactText('mail 5550100199@example.org or 5550100199');
	assert.equal(r.text, 'mail [email] or [phone]');
	assert.equal(r.emails, 1);
	assert.equal(r.phones, 1);
});

test('redacting twice changes nothing more; empty and non-string input is safe', () => {
	for (const [text] of [...PHONES, ...EMAILS]) {
		const once = redactText(text).text;
		const again = redactText(once);
		assert.equal(again.text, once);
		assert.equal(again.flagged, false);
	}
	assert.deepEqual(scanText(''), { emails: 0, internalEmails: 0, phones: 0, flagged: false });
	assert.deepEqual(scanText(undefined), { emails: 0, internalEmails: 0, phones: 0, flagged: false });
	assert.deepEqual(redactText(null), { text: '', emails: 0, internalEmails: 0, phones: 0, flagged: false });
});

test('a result and a report hold counts only: no matched string appears in anything they return or format', () => {
	const secretAddress = 'zebra.quokka@example.org';
	const secretPhone = '555-017-0142';
	const text = `Contact ${secretAddress} or ${secretPhone}`;
	const scan = scanText(text);
	assert.equal(JSON.stringify(scan).includes('zebra'), false);
	assert.equal(JSON.stringify(scan).includes('0142'), false);
	const report = new PersonDataReport();
	report.add('PSE', 'description', text);
	report.add('PSE', 'description', 'nothing personal here');
	report.add('PSE', 'comment', 'only someone@pollensense.com');
	report.add('INS', 'title', 'plain');
	const out = report.format() + JSON.stringify(report.summary());
	assert.equal(out.includes('zebra'), false);
	assert.equal(out.includes('0142'), false);
	assert.equal(out.includes('example.org'), false);
	assert.ok(out.includes(REPORT_LIMIT));
	assert.deepEqual(report.summary().find((r) => r.team === 'PSE' && r.field === 'description'), { team: 'PSE', field: 'description', texts: 2, withEmail: 1, withPhone: 1, flagged: 1, internalOnly: 0 });
	assert.equal(report.summary().find((r) => r.field === 'comment').internalOnly, 1);
	assert.deepEqual(report.summary().map((r) => `${r.team}/${r.field}`), ['INS/title', 'PSE/comment', 'PSE/description']);
});

test('hostile input stays fast: long runs of digits, separators, dots and at-signs', () => {
	const cases = ['1234567890'.repeat(20000), '1 2 3 4 5 6 7 '.repeat(5000), '(.)-/ '.repeat(30000), 'a'.repeat(200000), `a@${'b.'.repeat(20000)}`, 'a@'.repeat(50000), '1.2.3.'.repeat(30000)];
	for (const text of cases) {
		const t0 = performance.now();
		redactText(text);
		assert.ok(performance.now() - t0 < 3000, `${text.slice(0, 12)}... took ${performance.now() - t0} ms`);
	}
});
