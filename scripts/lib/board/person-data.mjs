/**
 * Person-data scan for board texts (design 7, rule A, decided by Van 2026-11-12): finds outside e-mail addresses and
 * phone-shaped numbers in any text, reports **counts only**, and redacts matches to `[email]` and `[phone]` for the
 * synced copy (the full text stays in the local-only `team/board/raw/`). Internal addresses (our own domains) are
 * counted but not redacted.
 *
 * Nothing here returns, logs or throws a matched string: a result holds counts and the redacted text, a report holds
 * counts per team and field. That is the point of the module; keep it so.
 *
 * It is a pattern scan and says so: names of customers, sensor hosts and other people inside a text cannot be found
 * this way (`REPORT_LIMIT`), and neither can an address written to dodge a scan (`jo at example dot org`) or an IP-literal
 * address (`jo@[192.0.2.1]`). It leans toward redacting too much: a number or address that is not personal costs a
 * `[phone]` in the synced copy, one that is missed costs a leak.
 */

export const DEFAULT_INTERNAL_DOMAINS = ['pollensense.com', 'pollenwise.com'];

export const REPORT_LIMIT = 'Limit: names of customers, sensor hosts and other people inside texts cannot be found by pattern; they are not counted or redacted.';

// A file name such as `icon@2x.png` is not an address: the last label of the domain must be letters and not one of these.
const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp', 'js', 'mjs', 'ts', 'css', 'json', 'md', 'txt', 'pdf', 'html', 'xml', 'yml', 'yaml', 'csv', 'zip', 'gz', 'log', 'dart', 'cs', 'py']);

// Letters and digits in any script, so `jo-e-acute@example.org` and `e-acute-lise@example.invalid` are whole addresses. Built from code points
// and \p classes (no \u escapes in this file).
const APOSTROPHE = String.fromCharCode(0x2019);
const LOCAL = `[\\p{L}\\p{N}._%+'${APOSTROPHE}-]`;
const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?';
const EMAIL = new RegExp(`(?<!${LOCAL})[\\p{L}\\p{N}]${LOCAL}*@(${LABEL}(?:\\.${LABEL})*\\.(\\p{L}{2,24}))(?![\\p{L}\\p{N}-])(?!:[A-Za-z0-9_./~-])`, 'gu');
// Dashes and spaces that are not ASCII (en dash, non-breaking hyphen, minus sign, no-break and thin spaces), seen in text copied
// from web pages and mail. Each is one UTF-16 unit, so the flattened copy has the same length and the same indexes as the text.
const DASHES = new RegExp(`[${String.fromCharCode(0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212)}]`, 'g');
const SPACES = new RegExp(`[${String.fromCharCode(0xa0, 0x2007, 0x2009, 0x202f)}]`, 'g');

// Things that look like phone numbers and are not: dates, times, and dotted versions or IP addresses. They are masked
// (same length) before the phone scan, so a date next to a number cannot join it into one run. A dotted run is kept
// when it is shaped like a phone (555.010.0199, 555.0199).
const NOT_PHONE = [
	/\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g,
	/\d{4}\/\d{1,2}\/\d{1,2}/g,
	/\d{1,2}[/.]\d{1,2}[/.]\d{4}/g,
	/\d{1,2}:\d{2}(?::\d{2})?/g,
];
const DOTTED = /(?<!\d)\d+(?:\.\d+){2,}/g;
const PHONE_DOTTED = /^(?:\d{3}\.\d{3}\.\d{4}|\d{3}\.\d{3}\.\d{3})$/;

// A run that starts and ends with a digit and holds only digits and phone separators; judged by `isPhone` below.
const PHONE_CANDIDATE = /(?<![A-Za-z0-9_.@/+#-])(\+?\(?\d[\d ()./-]{5,22}\d)(?![A-Za-z0-9_@#])/g;

function maskNonPhones(text) {
	let out = text;
	for (const pattern of NOT_PHONE) out = out.replace(pattern, (m) => '#'.repeat(m.length));
	return out.replace(DOTTED, (m) => (PHONE_DOTTED.test(m) ? m : '#'.repeat(m.length)));
}

/** True when a masked candidate run looks like a telephone number and not an ID or a counter. */
function isPhone(raw) {
	const text = raw.trim();
	const digits = text.replace(/\D/g, '');
	if (digits.length < 7 || digits.length > 15) return false;
	const plus = text.startsWith('+');
	const groups = text.split(/[^\d]+/).filter(Boolean);
	// A run of digits and dots is a phone only as 555.010.0199, 555.010.019 or 555.0199; 3.14159265 and the like are numbers.
	if (text.includes('.') && /^[\d.]+$/.test(text)) return /^\d{3}\.\d{3}\.\d{3,4}$/.test(text) || /^\d{3}\.\d{4}$/.test(text);
	if (/^0\d{2,5}\/\d{4,9}$/.test(text)) return true; // 0171/1234567: area code, slash, number
	if (text.includes('/')) return false; // any other slash joins an ID or a fraction, not a phone number
	if (/^\d( \d{3})+$/.test(text)) return false; // 1 000 000: a quantity written with spaces
	if (/^\+?\d+$/.test(text)) {
		// No separator at all: a phone only with a plus, or as a US/NANP number (10 digits, or 1 and 10). Epoch times
		// (10 digits starting 1, 13 digits) and long ids are not.
		if (plus) return digits.length >= 8;
		if (/^00\d{8,13}$/.test(digits)) return true; // 0044...: the international prefix written as 00
		return /^[2-9]\d{9}$/.test(digits) || /^1[2-9]\d{9}$/.test(digits);
	}
	// Written in pieces (0171 1234567, 555 010 0199): a phone unless one piece is a long ID.
	return !groups.some((g) => g.length > 9);
}

/** `{ emails, internalEmails, phones }`, the redacted text and the match spans, for one text. Internal use. */
function findAll(text, internalDomains) {
	const spans = [];
	let emails = 0;
	let internalEmails = 0;
	for (const m of text.matchAll(EMAIL)) {
		if (FILE_EXTENSIONS.has(m[2].toLowerCase())) continue;
		const domain = m[1].toLowerCase();
		if (internalDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) {
			internalEmails++;
			continue;
		}
		emails++;
		spans.push({ start: m.index, end: m.index + m[0].length, label: '[email]' });
	}
	let phones = 0;
	const masked = maskNonPhones(text.replace(DASHES, '-').replace(SPACES, ' '));
	for (const m of masked.matchAll(PHONE_CANDIDATE)) {
		const start = m.index;
		const end = start + m[1].length;
		if (spans.some((s) => start < s.end && end > s.start)) continue; // digits inside an address
		if (!isPhone(m[1])) continue;
		phones++;
		spans.push({ start, end, label: '[phone]' });
	}
	return { emails, internalEmails, phones, spans };
}

function options(opts) {
	return { internalDomains: (opts?.internalDomains ?? DEFAULT_INTERNAL_DOMAINS).map((d) => d.toLowerCase()) };
}

/** Counts for one text: `{ emails, internalEmails, phones, flagged }`. `flagged` = an outside address or a phone-shaped number. */
export function scanText(text, opts) {
	if (typeof text !== 'string' || text === '') return { emails: 0, internalEmails: 0, phones: 0, flagged: false };
	const { emails, internalEmails, phones } = findAll(text, options(opts).internalDomains);
	return { emails, internalEmails, phones, flagged: emails + phones > 0 };
}

/** `{ text, emails, internalEmails, phones, flagged }`: the text with outside addresses as `[email]` and phone-shaped numbers as `[phone]`. */
export function redactText(text, opts) {
	if (typeof text !== 'string' || text === '') return { text: typeof text === 'string' ? text : '', emails: 0, internalEmails: 0, phones: 0, flagged: false };
	const { emails, internalEmails, phones, spans } = findAll(text, options(opts).internalDomains);
	let out = '';
	let at = 0;
	for (const s of spans.sort((a, b) => a.start - b.start)) {
		out += text.slice(at, s.start) + s.label;
		at = s.end;
	}
	out += text.slice(at);
	return { text: out, emails, internalEmails, phones, flagged: emails + phones > 0 };
}

/**
 * Counts per team and field over a whole import: `add('PSE', 'description', text)`, then `summary()` or `format()`.
 * It counts TEXTS (how many descriptions hold an outside address, how many hold a phone-shaped number, how many are
 * flagged), the same unit as the inventory (design 7), and keeps no text.
 */
export class PersonDataReport {
	constructor(opts) {
		this.opts = opts;
		this.rows = new Map(); // `${team}\u0000${field}` -> counts
	}

	add(team, field, text) {
		const key = `${team}\u0000${field}`;
		const row = this.rows.get(key) ?? { team, field, texts: 0, withEmail: 0, withPhone: 0, flagged: 0, internalOnly: 0 };
		const r = scanText(text, this.opts);
		row.texts++;
		if (r.emails) row.withEmail++;
		if (r.phones) row.withPhone++;
		if (r.flagged) row.flagged++;
		else if (r.internalEmails) row.internalOnly++;
		this.rows.set(key, row);
		return r;
	}

	summary() {
		return [...this.rows.values()].sort((a, b) => (a.team === b.team ? (a.field < b.field ? -1 : 1) : a.team < b.team ? -1 : 1));
	}

	format() {
		const lines = ['team  field        texts  outside-email  phone  flagged  internal-only'];
		for (const r of this.summary()) {
			lines.push(`${r.team.padEnd(5)} ${r.field.padEnd(12)} ${String(r.texts).padStart(5)}  ${String(r.withEmail).padStart(13)}  ${String(r.withPhone).padStart(5)}  ${String(r.flagged).padStart(7)}  ${String(r.internalOnly).padStart(13)}`);
		}
		lines.push(REPORT_LIMIT);
		return lines.join('\n');
	}
}
