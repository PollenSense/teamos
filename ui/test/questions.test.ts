import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	type QuestionState,
	answerText,
	answeredLine,
	buildAnswers,
	mayAnswer,
	sendsOnTap,
	shortWhen,
	threadChip,
	waitingTitle,
} from '../src/lib/questions.js';

const state = (id: string, status: QuestionState['status'] = 'open', extra: Partial<QuestionState> = {}): QuestionState => ({
	id,
	text: `Question ${id}?`,
	options: [{ label: 'Meadow' }, { label: 'Sky' }],
	recommend: 1,
	waitingOn: ['kris'],
	status,
	answer: null,
	also: [],
	earlier: [],
	reopens: 0,
	reopenReason: null,
	reopenedAt: null,
	conflict: false,
	...extra,
});

describe('mayAnswer', () => {
	const ask = { from: 'ivy', to: ['kris'], cc: ['alton'] };
	it('lets anyone the message was sent to answer, not only the person it waits on', () => {
		assert.equal(mayAnswer(ask, 'kris'), true);
		assert.equal(mayAnswer(ask, 'alton'), true);
	});
	it('refuses the asker, strangers and nobody', () => {
		assert.equal(mayAnswer(ask, 'ivy'), false);
		assert.equal(mayAnswer(ask, 'nate'), false);
		assert.equal(mayAnswer(ask, null), false);
		assert.equal(mayAnswer({ from: 'ivy', to: ['kris'] }, 'alton'), false);
	});
});

describe('lines under a card', () => {
	const q = state('q1');
	it('says what was chosen', () => {
		assert.equal(answerText({ kind: 'option', option: 2, by: 'kris', at: '', messageId: 'm' }, q), 'option 2, Sky');
		assert.equal(answerText({ kind: 'option', option: 9, by: 'kris', at: '', messageId: 'm' }, q), 'option 9');
		assert.equal(answerText({ kind: 'other', other: 'green', by: 'kris', at: '', messageId: 'm' }, q), 'other: green');
		assert.equal(answerText({ kind: 'dismissed', by: 'kris', at: '', messageId: 'm' }, q), 'dismissed');
	});
	it('says who, and who wrote it down', () => {
		assert.equal(answeredLine({ kind: 'option', option: 1, by: 'kris', at: '', messageId: 'm' }, q), 'Answered by kris: option 1, Meadow');
		assert.equal(answeredLine({ kind: 'dismissed', by: 'van', at: '', messageId: 'm' }, q), 'Dismissed by van');
		assert.equal(
			answeredLine({ kind: 'option', option: 2, by: 'alton', recordedBy: 'ivy', via: 'M1', at: '', messageId: 'm' }, q),
			'Answered by alton: option 2, Sky (recorded by ivy from their reply)',
		);
	});
});

describe('picking and sending', () => {
	const states = [state('q1'), state('q2'), state('q3', 'answered')];
	it('sends only open questions that have a pick, in order, and trims other text', () => {
		assert.deepEqual(
			buildAnswers(states, { q2: { kind: 'other', other: '  my own  ' }, q1: { kind: 'option', option: 2 }, q3: { kind: 'option', option: 1 } }),
			[
				{ q: 'q1', option: 2 },
				{ q: 'q2', other: 'my own' },
			],
		);
		assert.deepEqual(buildAnswers(states, { q1: { kind: 'other', other: '   ' } }), []);
		assert.deepEqual(buildAnswers(states, {}), []);
	});
	it('a tap sends at once only when one question is open', () => {
		assert.equal(sendsOnTap([state('q1')]), true);
		assert.equal(sendsOnTap([state('q1'), state('q2', 'answered')]), true);
		assert.equal(sendsOnTap([state('q1'), state('q2')]), false);
		assert.equal(sendsOnTap([state('q1', 'dismissed')]), false);
	});
});

describe('chips and titles', () => {
	it('shows who a thread waits on, stronger when it is the viewer', () => {
		assert.deepEqual(threadChip({ open: 2, total: 2, waitingOn: ['kris', 'van'] }, 'ivy'), { label: '2 waiting on kris, van', tone: 'waiting' });
		assert.deepEqual(threadChip({ open: 1, total: 1, waitingOn: ['kris'] }, 'kris'), { label: 'waiting on you', tone: 'mine' });
		assert.deepEqual(threadChip({ open: 1, total: 3, waitingOn: ['kris', 'van', 'alton'] }, 'ivy'), { label: 'waiting on kris, van +1 (2 of 3 answered)', tone: 'waiting' });
		assert.deepEqual(threadChip({ open: 0, total: 2, waitingOn: [] }, 'kris'), { label: 'answered', tone: 'done' });
		assert.equal(threadChip(undefined, 'kris'), null);
		assert.equal(threadChip({ open: 0, total: 0, waitingOn: [] }, 'kris'), null);
	});
	it('titles the strip for the viewer or for the member being viewed', () => {
		assert.equal(waitingTitle('kris', 'kris', 3), 'Waiting on you (3)');
		assert.equal(waitingTitle('kris', 'van', 3), 'Waiting on kris (3)');
		assert.equal(waitingTitle('kris', null, 1), 'Waiting on kris (1)');
	});
	it('prints a time, with the weekday for another day', () => {
		const now = new Date('2026-10-13T12:00:00');
		assert.match(shortWhen('2026-10-13T09:05:00', now), /^\d{2}:\d{2}$/);
		assert.match(shortWhen('2026-10-12T09:05:00', now), /^\w{3,} \d{2}:\d{2}$/);
		assert.equal(shortWhen('nonsense', now), '');
	});
});
