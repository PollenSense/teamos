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
