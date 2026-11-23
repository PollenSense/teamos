import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendableFields } from '../src/server/sendable-fields.js';

test('the effort a person picks in the compose box reaches sendMessage', () => {
	const out = sendableFields({ from: 'van', to: ['cy'], subject: 's', body: 'b', effort: 'high' });
	assert.equal(out.effort, 'high');
});

test('the marks, questions, answers and attachments pass; server-only options and unknown fields do not', () => {
	const out = sendableFields({
		from: 'cy', to: ['van'], body: 'b', fyi: true, expectsReply: false, questions: [{ text: 'q' }], answers: [{ ask: 'a', q: 'q1' }],
		attachments: ['tok'], tags: false, mentions: ['sal'], resolvedBy: 'x', ask: 'fyi',
	});
	assert.deepEqual(Object.keys(out).sort(), ['answers', 'attachments', 'body', 'cc', 'effort', 'expectsReply', 'from', 'fyi', 'projectCode', 'questions', 'replyTo', 'subject', 'to']);
	assert.equal((out as Record<string, unknown>).tags, undefined);
	assert.equal((out as Record<string, unknown>).mentions, undefined);
	assert.equal((out as Record<string, unknown>).ask, undefined);
});
