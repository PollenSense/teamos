import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_INTERNAL_DOMAINS, PersonDataReport, REPORT_LIMIT, redactText, redactValue, scanText, scanValue } from './person-data.mjs';

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

// ─── Fixes from the independent review (every case below leaked, or crashed, before) ───

const ch = (...codes) => String.fromCodePoint(...codes);
const ZWSP = ch(0x200b);
const BOM = ch(0xfeff);
const SOFT_HYPHEN = ch(0xad);
const shift = (digits, zero) => [...digits].map((d) => ch(zero + Number(d))).join('');

/** The text must be flagged and none of the invented secrets may survive in the redacted copy. */
function gone(input, ...secrets) {
	const r = redactText(input);
	assert.equal(r.flagged, true, `not flagged: ${JSON.stringify(input)}`);
	for (const secret of secrets) assert.ok(!r.text.includes(secret), `${JSON.stringify(secret)} survived in ${JSON.stringify(r.text)}`);
	return r;
}

test('an address is found after a quote, an underscore, a plus, an encoded space, or inside quotes and JSON', () => {
	for (const input of [
		"email = 'jo@example.org'",
		"{'email': 'jo@example.org'}",
		'x _jo@example.org',
		'to=%20jo@example.org',
		'see "jo@example.org".',
		'(jo@example.org)',
	]) gone(input, 'example.org');
	const both = gone('+15550100199@example.org', '5550100199', 'example.org');
	assert.equal(both.emails, 1);
	assert.equal(both.phones, 0, 'the digits inside the address are not a second finding');
	const quoted = gone('"jo doe"@example.org', 'doe', 'example.org');
	assert.equal(quoted.text, '[email]');
});

test('an encoded or look-alike at-sign, dot and letter case do not hide an address', () => {
	const at = ch(0xff20);
	const smallAt = ch(0xfe6b);
	const fullDot = ch(0xff0e);
	const ideographicDot = ch(0x3002);
	for (const input of [
		'jo%40example.org',
		'mailto:jo%40example.org?subject=x',
		'jo&#64;example.org',
		'jo&#x40;example.org',
		'jo&commat;example.org',
		`jo${at}example.org`,
		`jo${smallAt}example.org`,
		`jo@example${fullDot}org`,
		`jo@example${ideographicDot}org`,
		'JO@EXAMPLE.ORG',
		'jo@example.xn--p1ai',
	]) gone(input, 'example', 'EXAMPLE');
});

test('what follows an address does not hide it: colon, hyphen, a second address', () => {
	gone('jo@example.org:Phone', 'example.org');
	gone('jo@example.org- thanks', 'example.org');
	const two = gone('jo@example.org:smith@example.org', 'example.org');
	assert.equal(two.emails, 2);
	assert.equal(redactText('clone git@github.com:org/repo.git now').flagged, false, 'a repository address with a path is not a person');
	assert.equal(redactText('see icon@2x.png').flagged, false);
});

test('real top-level domains that look like file extensions are addresses', () => {
	for (const tld of ['md', 'py', 'zip']) gone(`jo@example.${tld}`, 'example');
	for (const ext of ['png', 'js', 'json', 'txt']) assert.equal(redactText(`name@2x.${ext}`).flagged, false, ext);
});

test('invisible characters inside an address or number do not hide it', () => {
	gone(`j${ZWSP}o@example.org`, 'example.org');
	gone(`jo${ZWSP}@example.org`, 'example.org');
	gone(`${BOM}jo@exam${SOFT_HYPHEN}ple.org`, 'org');
	gone(`555-010${ZWSP}-0199`, '0199');
	gone(`+1 555${BOM} 010 0199`, '0199');
	// the text around a match is untouched, also when the match holds dropped characters
	assert.equal(redactText(`call 555${ZWSP}-010-0199 now`).text, 'call [phone] now');
});

test('non-ASCII digits and spaces are read as digits and spaces, and the text around the match stays as it was', () => {
	for (const zero of [0x660, 0xff10, 0x966, 0x1d7d8]) {
		const written = shift('5550100199', zero);
		assert.equal(redactText(`call ${written} now`).text, 'call [phone] now', `zero at ${zero.toString(16)}`);
	}
	assert.equal(redactText(`555${ch(0x2003)}010${ch(0x3000)}0199`).text, '[phone]');
	assert.equal(redactText(`555${ch(0x2015)}010${ch(0x2015)}0199`).text, '[phone]');
	const around = `caf${E_ACUTE} jo@example.org ${ch(0x1f600)} 555-010-0199 ${ch(0x1f600)}`;
	assert.equal(redactText(around).text, `caf${E_ACUTE} [email] ${ch(0x1f600)} [phone] ${ch(0x1f600)}`);
	assert.equal(redactText(`${ch(0x1f600)}${ch(0x1f600)} 555-010-0199`).text, `${ch(0x1f600)}${ch(0x1f600)} [phone]`);
});

test('a number with an extension or a label glued on is a phone number', () => {
	assert.equal(redactText('555-010-0199x123').text, '[phone]x123');
	assert.equal(redactText('555-010-0199 ext.123').text, '[phone] ext.123');
	assert.equal(redactText('5550100199ext12').text, '[phone]ext12');
	for (const input of ['cell #555-010-0199', 'Tel.555-010-0199', 'wa.me/15550100199', 'tel/fax/555-010-0199']) gone(input, '0199');
	assert.equal(redactText('5550100199abc').flagged, false, 'digits glued to letters are an ID');
});

test('international and national formats written without the usual grouping', () => {
	for (const input of [
		'+44 7700900123',
		'+1 5550100199',
		'+49 1711234567',
		'Jo (5550100199)',
		'07700900123',
		'09171234567',
		'0612345678',
		'01.23.45.67.89',
		'+1.555.010.0199',
		'+44.20.7946.0958',
	]) gone(input, '5550100199', '7700900123', '1711234567', '09171234567', '0612345678', '23.45.67', '555.010', '7946');
	for (const input of ['+1.2.3', '123456789012', '10.0.19041.1234', '3.14159265', '1699999999']) assert.equal(redactText(input).flagged, false, input);
});

test('two numbers in one run are both found, whatever separates them', () => {
	for (const input of ['555-010-0199 / 555-010-0188', '555-010-0199/555-010-0188', '555-010-0199 555-010-0188', '555-010-0199 555-010-0188 555-010-0177']) {
		const r = gone(input, '0199', '0188', '0177', '010');
		assert.ok(r.phones >= 2, `${input}: ${r.phones}`);
	}
});

test('a value that is not text is refused, not called clean', () => {
	for (const bad of [5550100199, true, {}, ['jo@example.org'], new Date(), Buffer.from('jo@example.org'), 10n]) {
		assert.throws(() => scanText(bad), TypeError);
		assert.throws(() => redactText(bad), TypeError);
	}
	try {
		scanText({ email: 'zebra.quokka@example.org' });
	} catch (err) {
		assert.ok(!String(err.message).includes('zebra'), 'the refusal names the type, not the value');
	}
});

test('structured values: arrays, objects, keys and numbers are walked; what cannot be scanned throws', () => {
	const value = {
		title: 'Call 555-010-0199',
		list: ['jo@example.org', 'fine', 42, 5550100199, { deep: '+44 7700900123' }],
		'jo@example.org': 'a key that is an address',
		when: new Date(0),
		flag: true,
		none: null,
		internal: 'someone-else@pollensense.com',
	};
	const r = redactValue(value);
	assert.equal(r.flagged, true);
	assert.deepEqual(r.value.list, ['[email]', 'fine', 42, '[phone]', { deep: '[phone]' }]);
	assert.equal(r.value.title, 'Call [phone]');
	assert.equal(r.value['[email]'], 'a key that is an address');
	assert.equal(r.value.when.getTime(), 0);
	assert.equal(r.value.internal, 'someone-else@pollensense.com');
	assert.deepEqual([r.emails, r.internalEmails, r.phones], [2, 1, 3]);
	assert.deepEqual(scanValue(value), { emails: 2, internalEmails: 1, phones: 3, flagged: true });
	assert.equal(JSON.stringify(value).includes('[email]'), false, 'the input is not changed');

	// two keys that redact to the same text stay two keys
	assert.deepEqual(Object.keys(redactValue({ 'a@example.org': 1, 'b@example.org': 2 }).value), ['[email]', '[email]#2']);

	const circular = {};
	circular.self = circular;
	let deep = 'x';
	for (let i = 0; i < 70; i++) deep = [deep];
	for (const bad of [circular, deep, Buffer.from('x'), new Map(), new (class Thing {})(), () => 1, Symbol('s')]) {
		assert.throws(() => redactValue(bad), TypeError);
	}
	assert.equal(redactValue([[['x']]]).flagged, false);
});

test('dense matches stay fast: no work grows with the square of the text', () => {
	const dense = 'jo@example.org 555-010-0199 '.repeat(36000); // about 1 MB, 72,000 matches
	let started = Date.now();
	const r = redactText(dense);
	assert.equal(r.emails, 36000);
	assert.equal(r.phones, 36000);
	assert.ok(Date.now() - started < 3000, `dense text took ${Date.now() - started} ms`);
	started = Date.now();
	redactText('1 '.repeat(500000));
	assert.ok(Date.now() - started < 3000, `digit list took ${Date.now() - started} ms`);
	started = Date.now();
	const wide = `${ch(0x4e2d, 0x6587)} 555-010-0199 `.repeat(60000); // non-ASCII text takes the mapping path
	assert.equal(redactText(wide).phones, 60000);
	assert.ok(Date.now() - started < 3000, `non-ASCII text took ${Date.now() - started} ms`);
});

test('the report prints names, so a name that could carry data is refused without echoing it', () => {
	const report = new PersonDataReport();
	for (const [team, field] of [['PSE', 'jo@example.org'], ['a b', 'description'], ['PSE', ''], [5, 'x']]) {
		assert.throws(() => report.add(team, field, 'text'), (err) => err instanceof TypeError && !String(err.message).includes('example.org'));
	}
	report.add('PSE', 'description', { notes: ['jo@example.org'] });
	assert.equal(report.summary()[0].withEmail, 1);
	assert.throws(() => report.add('PSE', 'description', new Map()), TypeError);
	assert.ok(!report.format().includes('example.org'));
});

test('digits delimited by dots or underscores inside an address are part of the address, not a second finding', () => {
	for (const input of ['jo.5550100199.x@example.org', 'a.555-010-0199.b@example.org', 'sales_5550100199_eu@example.org']) {
		const r = redactText(input);
		assert.deepEqual([r.text, r.emails, r.phones], ['[email]', 1, 0], input);
	}
	// and next to an address the number is still its own finding
	const next = redactText('jo@example.org 555-010-0199');
	assert.deepEqual([next.text, next.emails, next.phones], ['[email] [phone]', 1, 1]);
});

test('a cut-out piece with dots mixed with spaces is a pair of decimals, not a number; two dotted numbers are two numbers', () => {
	for (const input of ['lat 33.448376 -112.074036', '33.448376 -112.074036 40.712776', '1.5 2.5 3.5 4.5 5.5 6.5 7.5 8.5 9.5']) assert.equal(redactText(input).flagged, false, input);
	const two = redactText('555.010.0199 555.010.0188');
	assert.deepEqual([two.text, two.phones], ['[phone] [phone]', 2]);
});
