/**
 * An invented export: every entity type, a few records each, nothing taken from a real tracker.
 * Names, texts and addresses are made up (the `.invalid` domain never resolves).
 */

export function buildFixture() {
	return {
		users: [
			{ id: 'u-1', name: 'Test Person One', displayName: 'tp1', email: 'one@example.invalid', active: true, app: false, admin: true, guest: false, createdAt: '2025-01-05T10:00:00.000Z' },
			{ id: 'u-2', name: 'Test Person Two', displayName: 'tp2', email: 'two@example.invalid', active: false, app: false, admin: false, guest: false },
			{ id: 'u-3', name: 'Test Agent', active: true, app: true, admin: false, guest: false },
		],
		teams: [
			{ id: 't-1', key: 'PSE', name: 'Test Engineering', private: false, cyclesEnabled: true, cycleDuration: 1 },
			{ id: 't-2', key: 'INS', name: 'Test Insights', private: false, cyclesEnabled: false },
		],
		states: [
			{ id: 's-1', name: 'Todo', type: 'unstarted', teamKey: 'PSE', position: 1 },
			{ id: 's-2', name: 'Done', type: 'completed', teamKey: 'PSE', position: 2 },
			{ id: 's-3', name: 'Old state', type: 'unstarted', teamKey: 'INS', archivedAt: '2025-06-01T00:00:00.000Z' },
		],
		labels: [
			{ id: 'l-1', name: 'Area', teamKey: null, isGroup: true },
			{ id: 'l-2', name: 'Portal', teamKey: 'PSE', parentId: 'l-1', isGroup: false },
		],
		cycles: [
			{ id: 'c-1', teamKey: 'PSE', number: 1, name: null, startsAt: '2025-02-03T08:00:00.000Z', endsAt: '2025-02-10T08:00:00.000Z', completedAt: '2025-02-10T08:00:00.000Z' },
			{ id: 'c-2', teamKey: 'PSE', number: 2, startsAt: '2025-02-10T08:00:00.000Z', endsAt: '2025-02-17T08:00:00.000Z' },
		],
		projects: [
			{ id: 'p-1', name: 'Test project', description: 'An invented project.', content: 'Longer invented text.', status: 'In Progress', statusType: 'started', leadId: 'u-1', teamKeys: ['PSE'], startDate: '2025-01-15', targetDate: null, createdAt: '2025-01-10T09:00:00.000Z' },
		],
		milestones: [
			{ id: 'm-1', projectId: 'p-1', name: 'First milestone', targetDate: '2025-03-01', sortOrder: 1.5 },
		],
		projectUpdates: [
			{ id: 'pu-1', projectId: 'p-1', body: 'Invented update text.', health: 'onTrack', authorId: 'u-1', createdAt: '2025-02-01T12:00:00.000Z' },
		],
		documents: [
			{ id: 'd-1', title: 'Invented document', content: 'Invented content.', projectId: 'p-1', createdAt: '2025-02-02T12:00:00.000Z' },
		],
		issues: [
			{ id: 'i-1', key: 'PSE-1', teamKey: 'PSE', number: 1, title: 'Invented parent issue', description: 'Invented description.', priority: 2, estimate: null, dueDate: '2025-03-01', createdAt: '2025-01-20T10:00:00.000Z', updatedAt: '2025-02-05T10:00:00.000Z', stateId: 's-1', projectId: 'p-1', milestoneId: 'm-1', cycleId: 'c-1', assigneeId: 'u-1', creatorId: 'u-2', labelIds: ['l-2'], previousKeys: [] },
			{ id: 'i-2', key: 'PSE-2', teamKey: 'PSE', number: 2, title: 'Invented child issue moved from another team', createdAt: '2025-01-21T10:00:00.000Z', completedAt: '2025-02-06T10:00:00.000Z', stateId: 's-2', parentId: 'i-1', labelIds: [], previousKeys: ['INS-5'], branchName: 'invented/branch' },
			{ id: 'i-3', key: 'INS-9', teamKey: 'INS', number: 9, title: 'Invented archived issue', createdAt: '2025-01-22T10:00:00.000Z', archivedAt: '2025-03-01T10:00:00.000Z', stateId: 's-3', labelIds: [], previousKeys: [] },
		],
		comments: [
			{ id: 'cm-1', issueKey: 'PSE-1', body: 'Invented comment.', createdAt: '2025-02-01T09:00:00.000Z', authorId: 'u-1' },
			{ id: 'cm-2', issueKey: 'PSE-1', body: 'Invented bot comment.', createdAt: '2025-02-01T09:05:00.000Z', botName: 'Test Bot' },
			{ id: 'cm-3', projectUpdateId: 'pu-1', body: 'Invented comment on an update.', createdAt: '2025-02-02T09:00:00.000Z', externalUserName: 'Outside Person' },
		],
		relations: [
			{ id: 'r-1', type: 'blocks', issueKey: 'PSE-1', relatedIssueKey: 'PSE-2' },
		],
		attachments: [
			{ id: 'a-1', issueKey: 'PSE-1', sourceType: 'github', url: 'https://example.invalid/pull/1', title: 'Invented pull request', metadata: { state: 'merged' } },
		],
	};
}
