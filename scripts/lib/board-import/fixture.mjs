import { buildFixture } from '../board-export/fixture-data.mjs';

/**
 * Invented members and an invented export for the reference importer's tests. Nothing here comes from a tracker:
 * names, texts and addresses are made up (the `.invalid` domain never resolves).
 */

export const MEMBERS = [
	{ name: 'alice', email: 'One@Example.invalid', active: true },
	{ name: 'bob', email: 'bob@example.invalid', active: true },
];

/** The shared export fixture, with a second project, a second team label and a few milestones and updates added. */
export function buildExport() {
	const e = buildFixture();
	e.projects.push({
		id: 'p-2', name: 'Second project', description: 'Another invented project.', status: 'Planned', statusType: 'planned', teamKeys: ['PSE', 'INS'],
		createdAt: '2025-03-01T10:00:00.000Z',
	});
	e.milestones.push({ id: 'm-2', projectId: 'p-1', name: 'Zeta milestone', description: 'Last one.', sortOrder: 9 });
	e.milestones.push({ id: 'm-3', projectId: 'p-1', name: 'Alpha milestone', sortOrder: 0.5 });
	return e;
}

/** A synthetic export with the inventory's counts (design 1.1: 63 projects, 15 labels, 17 documents, 18 users, 4 teams). */
export function buildInventorySizedExport() {
	const teamKeys = ['PSE', 'INS', 'REV', 'AER'];
	const e = {
		users: Array.from({ length: 18 }, (_, i) => ({ id: `u-${i}`, name: `Invented${i} Person`, email: `invented${i}@example.invalid`, active: i < 9, app: i === 17, admin: false, guest: false })),
		teams: teamKeys.map((key, i) => ({ id: `t-${i}`, key, name: `Team ${key}`, private: false, cyclesEnabled: true, cycleDuration: 1 })),
		states: teamKeys.flatMap((key, i) => ['Backlog', 'Todo', 'Done'].map((name, j) => ({ id: `s-${i}-${j}`, name, type: ['backlog', 'unstarted', 'completed'][j], teamKey: key, position: j }))),
		labels: Array.from({ length: 15 }, (_, i) => ({ id: `l-${i}`, name: `Label ${i}`, teamKey: null, isGroup: false })),
		cycles: Array.from({ length: 40 }, (_, i) => ({ id: `c-${i}`, teamKey: teamKeys[i % 4], number: Math.floor(i / 4) + 1, startsAt: '2025-01-06T08:00:00.000Z', endsAt: '2025-01-13T08:00:00.000Z' })),
		projects: Array.from({ length: 63 }, (_, i) => ({ id: `p-${i}`, name: `Invented project ${i}`, status: 'Started', teamKeys: [teamKeys[i % 4]], createdAt: `2025-01-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z` })),
		milestones: Array.from({ length: 27 }, (_, i) => ({ id: `m-${i}`, projectId: `p-${i}`, name: `Milestone ${i}` })),
		projectUpdates: Array.from({ length: 29 }, (_, i) => ({ id: `pu-${i}`, projectId: `p-${i}`, body: `Invented update ${i}.`, health: 'onTrack', createdAt: '2025-02-01T12:00:00.000Z' })),
		documents: Array.from({ length: 17 }, (_, i) => ({ id: `d-${i}`, title: `Invented document ${i}`, content: `Invented content ${i}.`, projectId: `p-${i}` })),
	};
	return e;
}

/**
 * The inventory-sized export plus 1,464 invented issues with the inventory's shape (design 1.1): PSE 1,030, INS 178, REV
 * 130, AER 126; 573 archived (439, 118, 6, 10); 600 carry one earlier key (549, 0, 41, 10); about one in eight has a parent.
 * Nothing here comes from a tracker. Earlier keys are `<TEAM>-9<nnnn>`, numbers no issue has. `divisor` shrinks every count
 * (a write is O(files) in the store, so the full size takes about 40 s per run: tests use a tenth unless asked).
 */
export function buildInventorySizedIssues(divisor = 1) {
	const e = buildInventorySizedExport();
	const teams = [['PSE', 1030, 439, 549], ['INS', 178, 118, 0], ['REV', 130, 6, 41], ['AER', 126, 10, 10]].map(([key, total, archived, moved]) => [key, Math.ceil(total / divisor), Math.round(archived / divisor), Math.round(moved / divisor)]);
	e.issues = [];
	e.milestones = e.milestones ?? [];
	let day = 0;
	teams.forEach(([key, total, archived, moved], t) => {
		for (let n = 1; n <= total; n++) {
			const created = new Date(Date.UTC(2024, 0, 1) + (day++) * 3_600_000).toISOString();
			e.issues.push({
				id: `i-${key}-${n}`, key: `${key}-${n}`, teamKey: key, number: n, title: `Invented issue ${key} ${n}`, description: n % 3 === 0 ? `Invented description ${n}.` : null,
				priority: n % 5, estimate: n % 4 === 0 ? n % 8 : null, dueDate: null, createdAt: created, updatedAt: created, archivedAt: n <= archived ? created : null,
				completedAt: null, canceledAt: null, startedAt: null, stateId: `s-${t}-${n % 3}`, projectId: n % 7 === 0 ? `p-${n % 63}` : null, milestoneId: null, cycleId: null,
				parentId: n > 1 && n % 8 === 0 ? `i-${key}-${n - 1}` : null, assigneeId: n % 2 === 0 ? `u-${n % 18}` : null, creatorId: `u-${(n + 1) % 18}`,
				labelIds: n % 5 === 0 ? [`l-${n % 15}`] : [], previousKeys: n <= moved ? [`${key}-9${String(n).padStart(4, '0')}`] : [], branchName: null,
			});
		}
	});
	return e;
}
