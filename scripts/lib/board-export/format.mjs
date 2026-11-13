/**
 * The board export format (version 1).
 *
 * A fetcher (today the Linear fetcher, `scripts/lib/linear/`) fills a folder; the importer reads it. Nothing
 * else connects them, so any other source (a hand-made folder, a different tracker) works if it writes
 * the same files.
 *
 *   <folder>/export.json      manifest: format, version, source, fetchedAt, one entry per file
 *   <folder>/<type>.json      { "type": "<type>", "version": 1, "records": [ ... ] }
 *
 * One file per entity type; record order inside a file and file order in the manifest do not matter.
 * Records name each other by `id` (the source's own opaque string) and, for issues, by `key` (`PSE-1061`).
 * A record may carry more fields than the spec below lists: they are kept and ignored.
 *
 * The folder holds descriptions, comments and e-mail addresses. It is never synced to Drive: see
 * `sync-filter.mjs` for the guard every writer calls first.
 *
 * Error messages name the type, the record's position and the field, never a value: values can be person
 * data and error text lands in logs.
 */

export const FORMAT = 'teamos-board-export';
export const FORMAT_VERSION = 1;
export const MANIFEST_FILE = 'export.json';

/** Error with a stable `code` (tests and callers switch on it); the message never contains a record value. */
export class ExportError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'ExportError';
		this.code = code;
	}
}

// Field kinds. A trailing `?` means the field may be missing or null.
//   string   non-empty-or-empty string      iso      ISO 8601 date or date-time string
//   int      integer                        number   finite number
//   bool     boolean                        strings  array of strings
//   object   plain object (not an array)    key      issue key like PSE-1061
//   teamkey  team key like PSE
const TEAM_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}$/;
const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * The entity types of version 1. `id` names the field that identifies a record inside its type (unique).
 * `refs` lists where a record points to another type, for reference checks by the importer.
 */
export const ENTITY_TYPES = {
	users: {
		id: 'id',
		fields: {
			id: 'string', name: 'string', displayName: 'string?', email: 'string?',
			active: 'bool', app: 'bool', admin: 'bool', guest: 'bool', createdAt: 'iso?',
		},
	},
	teams: {
		id: 'id',
		fields: {
			id: 'string', key: 'teamkey', name: 'string', private: 'bool', archivedAt: 'iso?',
			cyclesEnabled: 'bool', cycleDuration: 'int?',
		},
	},
	states: {
		id: 'id',
		fields: { id: 'string', name: 'string', type: 'string', teamKey: 'teamkey', archivedAt: 'iso?', position: 'number?' },
	},
	labels: {
		id: 'id',
		fields: { id: 'string', name: 'string', teamKey: 'teamkey?', parentId: 'string?', isGroup: 'bool', retiredAt: 'iso?' },
	},
	cycles: {
		id: 'id',
		fields: {
			id: 'string', teamKey: 'teamkey', number: 'int', name: 'string?', startsAt: 'iso', endsAt: 'iso',
			completedAt: 'iso?',
		},
	},
	projects: {
		id: 'id',
		fields: {
			id: 'string', name: 'string', description: 'string?', content: 'string?', status: 'string?',
			statusType: 'string?', leadId: 'string?', teamKeys: 'strings', startDate: 'iso?', targetDate: 'iso?',
			archivedAt: 'iso?', completedAt: 'iso?', canceledAt: 'iso?', createdAt: 'iso?',
		},
	},
	milestones: {
		id: 'id',
		fields: { id: 'string', projectId: 'string', name: 'string', description: 'string?', targetDate: 'iso?', sortOrder: 'number?' },
	},
	projectUpdates: {
		id: 'id',
		fields: { id: 'string', projectId: 'string', body: 'string', health: 'string?', authorId: 'string?', createdAt: 'iso' },
	},
	documents: {
		id: 'id',
		fields: {
			id: 'string', title: 'string', content: 'string?', projectId: 'string?', issueKey: 'key?',
			createdAt: 'iso?', updatedAt: 'iso?',
		},
	},
	issues: {
		id: 'id',
		unique: ['key'],
		fields: {
			id: 'string', key: 'key', teamKey: 'teamkey', number: 'int', title: 'string', description: 'string?',
			priority: 'int?', estimate: 'number?', dueDate: 'iso?', createdAt: 'iso', updatedAt: 'iso?',
			archivedAt: 'iso?', completedAt: 'iso?', canceledAt: 'iso?', startedAt: 'iso?', stateId: 'string',
			projectId: 'string?', milestoneId: 'string?', cycleId: 'string?', parentId: 'string?',
			assigneeId: 'string?', creatorId: 'string?', labelIds: 'strings', previousKeys: 'strings',
			branchName: 'string?',
		},
	},
	comments: {
		id: 'id',
		fields: {
			id: 'string', issueKey: 'key?', projectUpdateId: 'string?', documentId: 'string?', body: 'string',
			createdAt: 'iso', updatedAt: 'iso?', authorId: 'string?', botName: 'string?', externalUserName: 'string?',
		},
	},
	relations: {
		id: 'id',
		fields: { id: 'string', type: 'string', issueKey: 'key', relatedIssueKey: 'key' },
	},
	attachments: {
		id: 'id',
		fields: {
			id: 'string', issueKey: 'key', sourceType: 'string?', url: 'string', title: 'string?',
			subtitle: 'string?', metadata: 'object?', createdAt: 'iso?',
		},
	},
};

export const TYPE_NAMES = Object.keys(ENTITY_TYPES);

/** The file name of an entity type inside the folder (a fixed name, never taken from the manifest). */
export function fileNameFor(type) {
	if (!Object.prototype.hasOwnProperty.call(ENTITY_TYPES, type)) {
		throw new ExportError('unknown-type', `"${String(type).slice(0, 40)}" is not an entity type of export format ${FORMAT_VERSION}`);
	}
	return `${type}.json`;
}

function isPlainObject(v) {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An ISO date or date-time whose calendar day exists (Date.parse alone rolls 2026-02-30 over to March). */
export function isIsoDate(value) {
	if (typeof value !== 'string' || !ISO.test(value) || Number.isNaN(Date.parse(value))) return false;
	const y = Number(value.slice(0, 4));
	const m = Number(value.slice(5, 7));
	const d = Number(value.slice(8, 10));
	const check = new Date(Date.UTC(y, m - 1, d));
	return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

/** Does `value` have the kind `kind` (without the `?`)? */
function hasKind(kind, value) {
	switch (kind) {
		case 'string': return typeof value === 'string';
		case 'int': return Number.isSafeInteger(value);
		case 'number': return typeof value === 'number' && Number.isFinite(value);
		case 'bool': return typeof value === 'boolean';
		case 'strings': return Array.isArray(value) && value.every((v) => typeof v === 'string');
		case 'object': return isPlainObject(value);
		case 'iso': return isIsoDate(value);
		case 'key': return typeof value === 'string' && ISSUE_KEY.test(value);
		case 'teamkey': return typeof value === 'string' && TEAM_KEY.test(value);
		default: return false;
	}
}

/**
 * Check one record. Returns a list of problems (empty when the record is valid); each problem is
 * `{ field, expected }` where `expected` is the kind or 'missing'. No value is ever in a problem.
 */
export function validateRecord(type, record) {
	fileNameFor(type);
	if (!isPlainObject(record)) return [{ field: '(record)', expected: 'object' }];
	const problems = [];
	const spec = ENTITY_TYPES[type].fields;
	for (const [field, rawKind] of Object.entries(spec)) {
		const optional = rawKind.endsWith('?');
		const kind = optional ? rawKind.slice(0, -1) : rawKind;
		const present = Object.prototype.hasOwnProperty.call(record, field);
		const value = present ? record[field] : undefined;
		if (!present || value === undefined || value === null) {
			if (!optional) problems.push({ field, expected: present ? kind : 'missing' });
			continue;
		}
		if (!hasKind(kind, value)) problems.push({ field, expected: kind });
	}
	return problems;
}

/**
 * Validate the whole list of records of one type: each record, and uniqueness of `id` (and of `unique`
 * fields). Throws ExportError('invalid-record' | 'duplicate-id') on the first problem, naming the position.
 */
export function validateRecords(type, records) {
	fileNameFor(type);
	if (!Array.isArray(records)) throw new ExportError('invalid-record', `${type}: "records" is not a list`);
	const spec = ENTITY_TYPES[type];
	const seen = new Map([[spec.id, new Set()], ...(spec.unique ?? []).map((f) => [f, new Set()])]);
	for (let i = 0; i < records.length; i++) {
		const problems = validateRecord(type, records[i]);
		if (problems.length > 0) {
			const first = problems[0];
			throw new ExportError(
				'invalid-record',
				`${type}: record ${i + 1} has ${problems.length} problem${problems.length === 1 ? '' : 's'}; first: field "${first.field}" should be ${first.expected === 'missing' ? 'present' : `of kind ${first.expected}`}`,
			);
		}
		for (const [field, set] of seen) {
			const value = records[i][field];
			if (set.has(value)) throw new ExportError('duplicate-id', `${type}: record ${i + 1} repeats a "${field}" seen earlier`);
			set.add(value);
		}
	}
}
