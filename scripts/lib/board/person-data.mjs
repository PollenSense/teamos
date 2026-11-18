/**
 * Person-data scan for board texts (design 7, rule A, decided by Van 2026-11-12): finds outside e-mail addresses and
 * phone-shaped numbers in any text, reports **counts only**, and redacts matches to `[email]` and `[phone]` for the
 * synced copy (the full text stays in the local-only `team/board/raw/`). Internal addresses (our own domains) are
 * counted but not redacted.
 *
 * Nothing here returns, logs or throws a matched string: a result holds counts and the redacted text, a report holds
 * counts per team and field. That is the point of the module; keep it so.
 *
 * It is a pattern scan and says so (`REPORT_LIMIT`). It leans toward redacting too much: a number or address that is
 * not personal costs a `[phone]` in the synced copy, one that is missed costs a leak. Input that is not text fails
 * closed: `scanText` and `redactText` refuse a non-string (a number, an object) instead of calling it clean; use
 * `scanValue` / `redactValue` for structured values (they walk arrays and objects, keys and values).
 *
 * The scan runs on a normalised copy (invisible format characters dropped, non-ASCII digits, spaces, dashes, dots and
 * at-signs folded to ASCII) and maps every match back to the original text, so `jo[zero-width space]@example.org`
 * and fullwidth digits do not get through.
 */

export const DEFAULT_INTERNAL_DOMAINS = ['pollensense.com', 'pollenwise.com'];

export const REPORT_LIMIT =
	'Limit: names of customers, sensor hosts and other people inside texts cannot be found by pattern; they are not counted or redacted. Neither are an address or number split across lines, written to dodge a scan ("jo at example dot org"), glued to a word by a hyphen (phone-555-010-0199), or an IP-literal address.';

// A file name such as `icon@2x.png` is not an address: the last label of the domain must be letters and not one of these.
// (Not `md`, `py` or `zip`: those are real top-level domains.)
const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp', 'js', 'mjs', 'ts', 'css', 'json', 'txt', 'pdf', 'html', 'xml', 'yml', 'yaml', 'csv', 'gz', 'log', 'dart', 'cs']);

// ─── Normalised copy ────────────────────────────────────────────────────────────

const NON_ASCII = /[^\x00-\x7f]/;
const IS_FORMAT = /^\p{Cf}$/u;
const IS_DIGIT = /^\p{Nd}$/u;
const AT_LIKE = new Set([0xff20, 0xfe6b]);
const DOT_LIKE = new Set([0xff0e, 0x3002, 0xff61, 0xfe52]);
const DASH_LIKE = new Set([0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe58, 0xfe63, 0xff0d]);

/** The value 0 to 9 of a non-ASCII decimal digit: every script writes its ten digits as one aligned run of code points. */
function digitValue(cp) {
	let start = cp;
	for (let guard = 0; guard < 60 && IS_DIGIT.test(String.fromCodePoint(start - 1)); guard++) start--;
	return (cp - start) % 10;
}

/** What one non-ASCII character becomes in the scan copy: null = dropped, a string = replaced, undefined = kept. */
function foldChar(cp) {
	const ch = String.fromCodePoint(cp);
	if (IS_FORMAT.test(ch)) return null; // zero-width space and joiners, BOM, soft hyphen, bidi marks
	if (IS_DIGIT.test(ch)) return String(digitValue(cp));
	if (AT_LIKE.has(cp)) return '@';
	if (DOT_LIKE.has(cp)) return '.';
	if (DASH_LIKE.has(cp)) return '-';
	const compat = ch.normalize('NFKC'); // fullwidth letters and punctuation, no-break and wide spaces
	return compat !== ch && !NON_ASCII.test(compat) ? compat : undefined;
}

/** `{ norm, startOf, endOf }`: the scan copy and, per UTF-16 unit of it, where that unit starts and ends in the original (null = identical). */
function normalise(text) {
	if (!NON_ASCII.test(text)) return { norm: text, startOf: null, endOf: null };
	// The scan copy can be longer than the original (a ligature or a symbol that NFKC writes as several letters), so
	// the maps grow with it: a typed array ignores a write past its end, which once left such a span unmapped.
	let capacity = text.length + 16;
	let startOf = new Int32Array(capacity);
	let endOf = new Int32Array(capacity);
	const out = [];
	for (let i = 0; i < text.length; ) {
		const cp = text.codePointAt(i);
		const len = cp > 0xffff ? 2 : 1;
		const rep = cp < 0x80 ? undefined : foldChar(cp);
		if (rep !== null) {
			const s = rep === undefined ? text.slice(i, i + len) : rep;
			if (out.length + s.length > capacity) {
				capacity = Math.max(capacity * 2, out.length + s.length);
				const grownStart = new Int32Array(capacity);
				const grownEnd = new Int32Array(capacity);
				grownStart.set(startOf);
				grownEnd.set(endOf);
				startOf = grownStart;
				endOf = grownEnd;
			}
			for (let k = 0; k < s.length; k++) {
				startOf[out.length] = i;
				endOf[out.length] = i + len;
				out.push(s[k]);
			}
		}
		i += len;
	}
	return { norm: out.join(''), startOf, endOf };
}

// ─── E-mail ─────────────────────────────────────────────────────────────────────

// Letters and digits in any script, so an accented local part is a whole address. Built from code points and \p classes.
const APOSTROPHE = String.fromCharCode(0x2019);
// Combining marks (\p{M}) belong to the letters they sit on: `e` + U+0301 is a letter written in two code points.
const LOCAL = `[\\p{L}\\p{N}\\p{M}._%+'${APOSTROPHE}-]`;
const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}\\p{M}-]*[\\p{L}\\p{N}\\p{M}])?';
// The at-sign as it appears in query strings and HTML (fullwidth and small forms are folded to `@` in the scan copy).
const AT = '(?:@|%40|&#0*64;|&#x0*40;|&commat;)';
// The local part starts at the first character of its run (so a quote, `_`, `+` or `%20` before it is swallowed, never a gap),
// or is a quoted string. The domain ends at a letter-only (or punycode) last label that is not followed by more label text;
// `git@github.com:org/repo.git` (a path after the colon) is a repository address, not a person.
const EMAIL = new RegExp(
	`(?:(?<!${LOCAL})${LOCAL}+|"[^"\\r\\n@]{1,64}")${AT}(${LABEL}(?:\\.${LABEL})*\\.(xn--[a-z0-9-]{1,59}|(?:\\p{L}\\p{M}*){2,24}))(?![\\p{L}\\p{N}])(?!-[\\p{L}\\p{N}])(?!:[A-Za-z0-9_.~-]*/)`,
	'giu',
);

// ─── Phone ──────────────────────────────────────────────────────────────────────

// Things that look like phone numbers and are not: dates, times, and dotted versions or IP addresses. They are masked
// (same length) before the phone scan, so a date next to a number cannot join it into one run. A dotted run is kept
// when it is shaped like a phone (555.010.0199, 555.0199, 01.23.45.67.89, +1.555.010.0199).
const NOT_PHONE = [
	/\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g,
	/\d{4}\/\d{1,2}\/\d{1,2}/g,
	/\d{1,2}[/.]\d{1,2}[/.]\d{4}/g,
	/\d{1,2}:\d{2}(?::\d{2})?/g,
];
const DOTTED = /(?<!\d)\d+(?:\.\d+){2,}/g;
const PHONE_DOTTED = /^(?:\d{3}\.\d{3}\.\d{3,4}|\d{2}(?:\.\d{2}){4})$/;

// A run of digits and phone separators that starts and ends with a digit, not glued to letters. The end may be followed by an
// extension (`x123`, `ext.123`). Judged, and cut into numbers when it holds more than one, by `phoneSpansIn`.
const PHONE_RUN = /(?<![A-Za-z0-9_@+-])(\+?\(?\d[\d ()./-]*\d)(?!(?!(?:x|ext)\.?\d)[A-Za-z0-9_@])/gi;

function maskNonPhones(text) {
	// A dotted run led by a plus (+1.555.010.0199, +44.20.7946.0958) is a phone: keep it out of the date and version masks.
	const kept = [...text.matchAll(/\+\d+(?:\.\d+){2,}/g)].map((m) => [m.index, m.index + m[0].length]);
	// One replace pass visits its matches in increasing order and `kept` is sorted and does not overlap, so a cursor
	// that only moves forward answers "does this match touch a kept run" in linear time for the whole pass (a
	// search from the first run on every match was quadratic: 128,000 dotted numbers took 25 s).
	const overlapTest = () => {
		let cursor = 0;
		return (offset, length) => {
			while (cursor < kept.length && kept[cursor][1] <= offset) cursor++;
			return cursor < kept.length && kept[cursor][0] < offset + length;
		};
	};
	let out = text;
	for (const pattern of NOT_PHONE) {
		const inKept = overlapTest();
		out = out.replace(pattern, (m, ...rest) => (inKept(rest[rest.length - 2], m.length) ? m : '#'.repeat(m.length)));
	}
	const inKept = overlapTest();
	return out.replace(DOTTED, (m, offset) => (inKept(offset, m.length) || PHONE_DOTTED.test(m) ? m : '#'.repeat(m.length)));
}

/** True when a masked candidate run looks like a telephone number and not an ID or a counter. */
function isPhone(raw) {
	const text = raw.trim().replace(/^\((?=\d+$)/, '');
	const digits = text.replace(/\D/g, '');
	if (digits.length < 7 || digits.length > 15) return false;
	const plus = text.startsWith('+');
	const groups = text.split(/[^\d]+/).filter(Boolean);
	// A run of digits and dots is a phone only as 555.010.0199, 555.010.019, 555.0199 or 01.23.45.67.89; 3.14159265 and the like are numbers.
	if (text.includes('.') && /^[\d.]+$/.test(text)) return PHONE_DOTTED.test(text) || /^\d{3}\.\d{4}$/.test(text);
	if (/^0\d{2,5}\/\d{4,9}$/.test(text)) return true; // 0171/1234567: area code, slash, number
	if (text.includes('/')) return false; // any other slash joins an ID or a fraction, not a phone number
	if (/^\d( \d{3})+$/.test(text)) return false; // 1 000 000: a quantity written with spaces
	if (plus) return digits.length >= 8; // +44 7700900123, +49 171 1234567: a plus makes it international, whatever the pieces
	if (/^\d+$/.test(text)) {
		// No separator at all: a phone as a US/NANP number (10 digits, or 1 and 10), a national number with its leading 0, or 00 and a
		// country code. Epoch times (10 digits starting 1, 13 digits) and long ids are not.
		if (/^00\d{8,13}$/.test(digits)) return true;
		if (/^0[1-9]\d{8,10}$/.test(digits)) return true;
		return /^[2-9]\d{9}$/.test(digits) || /^1[2-9]\d{9}$/.test(digits);
	}
	// Written in pieces (0171 1234567, 555 010 0199): a phone unless one piece is a long ID.
	return !groups.some((g) => g.length > 9);
}

/** `isPhone` for a piece cut out of a longer run: dots mixed with spaces or hyphens (33.448376 -112.074036) are decimals, not a number. */
function isPhoneInRun(piece) {
	if (piece.includes('.') && !/^[\d.]+$/.test(piece)) return false;
	return isPhone(piece);
}

/** The phone numbers inside one run, as `{ start, end }` offsets into the run. A run that is one number is one span; a longer run is cut into the longest numbers it holds. */
function phoneSpansIn(run) {
	if (isPhone(run)) return [{ start: 0, end: run.length }];
	const groups = [...run.matchAll(/\d+/g)].map((g) => ({ start: g.index, end: g.index + g[0].length, n: g[0].length }));
	const spans = [];
	let i = 0;
	while (i < groups.length) {
		let start = groups[i].start;
		while (start > 0 && (run[start - 1] === '+' || run[start - 1] === '(')) start--;
		// Cut at the first valid number of ten digits or more (two numbers in a row stay two numbers); a run of seven to nine
		// digits (555-0100) is cut at the longest valid prefix.
		let best = -1;
		let digits = 0;
		for (let j = i; j < groups.length; j++) {
			digits += groups[j].n;
			if (digits > 15) break;
			if (run[start - 1] === '.' || run[groups[j].end] === '.') continue; // a fragment of a dotted number, not a number
			if (digits >= 7 && isPhoneInRun(run.slice(start, groups[j].end))) {
				best = j;
				if (digits >= 10) break;
			}
		}
		if (best >= 0) {
			spans.push({ start, end: groups[best].end });
			i = best + 1;
		} else {
			i++;
		}
	}
	return spans;
}

// ─── Scan ───────────────────────────────────────────────────────────────────────

/** `{ emails, internalEmails, phones, spans }` for one string; spans are offsets into the original text, sorted, not overlapping. Internal use. */
function findAll(text, internalDomains) {
	const { norm, startOf, endOf } = normalise(text);
	const emailSpans = []; // the addresses that are replaced (outside ones)
	const addressSpans = []; // every address, ours too: digits inside any of them are part of the address, not a number
	let emails = 0;
	let internalEmails = 0;
	for (const m of norm.matchAll(EMAIL)) {
		// A mark that trails the last label makes it a different name (`com` + U+0301 is not `com`), so for the file
		// extension test it is stripped (the text is then still a file name) but the internal-domain comparison below
		// uses the whole domain: an address that only looks like one of ours is an outside address and is redacted.
		const bare = (label) => label.replace(/\p{M}+$/u, '').toLowerCase();
		if (FILE_EXTENSIONS.has(bare(m[2]))) continue;
		const domain = m[1].toLowerCase();
		const span = { start: m.index, end: m.index + m[0].length, label: '[email]' };
		const internal = internalDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
		// A quoted local part can hold free text (`"call 555-010-0199 now"@...`): for one of our own addresses it does not hide a number.
		if (!(internal && m[0].startsWith('"'))) addressSpans.push(span);
		if (internal) {
			internalEmails++;
			continue;
		}
		emails++;
		emailSpans.push(span);
	}
	const phoneSpans = [];
	// Digits inside an address are part of the address, not a number; and digits beside one must not join a number into a run that
	// reaches into the address (`555-010-0199 12.x@example.org`: the run `555-010-0199 12` was dropped whole and the number stayed in
	// the synced text). So every address span is cut out of the scan copy first, with `#` of the same length (a character no run
	// holds), and the phone scan sees the number up to the address and nothing of the address.
	let phoneText = norm;
	if (addressSpans.length > 0) {
		const parts = [];
		let at = 0;
		for (const s of addressSpans) {
			parts.push(norm.slice(at, s.start), '#'.repeat(s.end - s.start));
			at = s.end;
		}
		parts.push(norm.slice(at));
		phoneText = parts.join('');
	}
	for (const m of maskNonPhones(phoneText).matchAll(PHONE_RUN)) {
		const base = m.index;
		for (const s of phoneSpansIn(m[1])) phoneSpans.push({ start: base + s.start, end: base + s.end, label: '[phone]' });
	}
	const spans = [...emailSpans, ...phoneSpans].sort((a, b) => a.start - b.start);
	if (startOf) for (const s of spans) [s.start, s.end] = [startOf[s.start], endOf[s.end - 1]];
	return { emails, internalEmails, phones: phoneSpans.length, spans };
}

function options(opts) {
	return { internalDomains: (opts?.internalDomains ?? DEFAULT_INTERNAL_DOMAINS).map((d) => d.toLowerCase()) };
}

function requireText(text, who) {
	if (text === undefined || text === null || typeof text === 'string') return;
	throw new TypeError(`${who}: expected a string, got ${typeof text}; use scanValue/redactValue for structured values`);
}

/** Counts for one text: `{ emails, internalEmails, phones, flagged }`. `flagged` = an outside address or a phone-shaped number. A non-string (other than null or undefined) throws. */
export function scanText(text, opts) {
	requireText(text, 'scanText');
	if (typeof text !== 'string' || text === '') return { emails: 0, internalEmails: 0, phones: 0, flagged: false };
	const { emails, internalEmails, phones } = findAll(text, options(opts).internalDomains);
	return { emails, internalEmails, phones, flagged: emails + phones > 0 };
}

/** `{ text, emails, internalEmails, phones, flagged }`: the text with outside addresses as `[email]` and phone-shaped numbers as `[phone]`. A non-string (other than null or undefined) throws. */
export function redactText(text, opts) {
	requireText(text, 'redactText');
	if (typeof text !== 'string' || text === '') return { text: '', emails: 0, internalEmails: 0, phones: 0, flagged: false };
	const { emails, internalEmails, phones, spans } = findAll(text, options(opts).internalDomains);
	let out = '';
	let at = 0;
	for (const s of spans) {
		out += text.slice(at, s.start) + s.label;
		at = s.end;
	}
	out += text.slice(at);
	return { text: out, emails, internalEmails, phones, flagged: emails + phones > 0 };
}

// ─── Structured values ──────────────────────────────────────────────────────────

const MAX_DEPTH = 64;

function isPlainObject(value) {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Redact a structured value: strings as `redactText`, numbers and bigints as the text they print (a number that is a phone
 * becomes the string `[phone]`), arrays and plain objects walked, object KEYS redacted too. Booleans, null, undefined and
 * dates pass. Anything else (a buffer, a map, a class instance, a function, a symbol, a cycle, a value nested deeper than 64)
 * throws a TypeError instead of passing unscanned.
 * Returns `{ value, emails, internalEmails, phones, flagged }`.
 */
export function redactValue(value, opts) {
	const totals = { emails: 0, internalEmails: 0, phones: 0 };
	const active = new Set();
	const text = (s) => {
		const r = redactText(s, opts);
		totals.emails += r.emails;
		totals.internalEmails += r.internalEmails;
		totals.phones += r.phones;
		return r.text;
	};
	const walk = (v, depth) => {
		if (v === null || v === undefined || typeof v === 'boolean') return v;
		if (typeof v === 'string') return text(v);
		if (typeof v === 'number' || typeof v === 'bigint') {
			const printed = String(v);
			const redacted = text(printed);
			return redacted === printed ? v : redacted;
		}
		if (typeof v !== 'object') throw new TypeError(`redactValue: cannot scan a value of type ${typeof v}`);
		if (v instanceof Date) return v;
		if (depth >= MAX_DEPTH) throw new TypeError('redactValue: value nested deeper than 64 levels');
		if (active.has(v)) throw new TypeError('redactValue: circular value');
		active.add(v);
		try {
			if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
			if (!isPlainObject(v)) throw new TypeError('redactValue: cannot scan an object that is not a plain object or array');
			const out = {};
			for (const [key, item] of Object.entries(v)) {
				const redacted = text(key);
				let name = redacted;
				for (let n = 2; Object.hasOwn(out, name); n++) name = `${redacted}#${n}`; // two keys that redact to the same text stay two keys
				// defineProperty, not assignment: `out['__proto__'] = x` would set the prototype and lose the key.
				Object.defineProperty(out, name, { value: walk(item, depth + 1), enumerable: true, writable: true, configurable: true });
			}
			return out;
		} finally {
			active.delete(v);
		}
	};
	const result = walk(value, 0);
	return { value: result, ...totals, flagged: totals.emails + totals.phones > 0 };
}

/** Counts for a structured value (see `redactValue` for what is walked and what is refused): `{ emails, internalEmails, phones, flagged }`. */
export function scanValue(value, opts) {
	const { emails, internalEmails, phones, flagged } = redactValue(value, opts);
	return { emails, internalEmails, phones, flagged };
}

// ─── Report ─────────────────────────────────────────────────────────────────────

const SAFE_NAME = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * Counts per team and field over a whole import: `add('PSE', 'description', value)`, then `summary()` or `format()`.
 * It counts TEXTS (how many descriptions hold an outside address, how many hold a phone-shaped number, how many are
 * flagged), the same unit as the inventory (design 7), and keeps no text. A team or field name that is not a plain name
 * throws (the report prints names; they must not carry data).
 */
export class PersonDataReport {
	constructor(opts) {
		this.opts = opts;
		this.rows = new Map(); // team -> field -> counts
		this.checkedNames = new Set();
	}

	/** A name the report may print: a plain name that the phone scan finds no number in. The message never holds the name. */
	_checkName(name, what) {
		if (typeof name !== 'string' || !SAFE_NAME.test(name)) throw new TypeError(`PersonDataReport.add: ${what} must be a plain name (letters, digits, _ . -, at most 40)`);
		if (this.checkedNames.has(name)) return;
		if (scanText(name, this.opts).flagged) throw new TypeError(`PersonDataReport.add: ${what} must not contain a number that looks like a phone number`);
		this.checkedNames.add(name);
	}

	add(team, field, value) {
		this._checkName(team, 'team');
		this._checkName(field, 'field');
		const r = scanValue(value, this.opts);
		const fields = this.rows.get(team) ?? new Map();
		const row = fields.get(field) ?? { team, field, texts: 0, withEmail: 0, withPhone: 0, flagged: 0, internalOnly: 0 };
		row.texts++;
		if (r.emails) row.withEmail++;
		if (r.phones) row.withPhone++;
		if (r.flagged) row.flagged++;
		else if (r.internalEmails) row.internalOnly++;
		fields.set(field, row);
		this.rows.set(team, fields);
		return r;
	}

	summary() {
		return [...this.rows.values()]
			.flatMap((fields) => [...fields.values()])
			.sort((a, b) => (a.team === b.team ? (a.field < b.field ? -1 : 1) : a.team < b.team ? -1 : 1));
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
