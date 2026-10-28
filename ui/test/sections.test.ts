import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	defaultSection,
	inSection,
	markBadge,
	matchesSearch,
	needsLabel,
	reasonWord,
	reasonsText,
	rowReasons,
	sectionCounts,
	sectionOf,
	storedSection,
} from '../src/lib/sections.js';

const counts = (inboxCount: number, needsCount = 0, archiveCount = 0, sentCount = 0) => ({ inboxCount, needsCount, archiveCount, sentCount });

describe('sections', () => {
	it('a thread with something that needs me is in Needs you only, never also in FYI', () => {
		const t = counts(2, 1);
		assert.equal(inSection(t, 'needs'), true);
		assert.equal(inSection(t, 'fyi'), false);
		assert.equal(sectionOf(t), 'needs');
	});

	it('inbox mail that needs nothing is FYI; archived and sent threads are listed in Done and Sent', () => {
		assert.equal(sectionOf(counts(1)), 'fyi');
		assert.equal(sectionOf(counts(0, 0, 3)), 'done');
		assert.equal(sectionOf(counts(0, 0, 0, 1)), 'sent');
		assert.equal(sectionOf(counts(0)), null);
		const both = counts(1, 0, 2, 1);
		assert.deepEqual(['needs', 'fyi', 'done', 'sent'].filter((s) => inSection(both, s as 'needs')), ['fyi', 'done', 'sent']);
	});

	it('an open question on archived mail still needs me, and is also listed in Done', () => {
		const t = counts(0, 1, 1);
		assert.equal(inSection(t, 'needs'), true);
		assert.equal(inSection(t, 'done'), true);
		assert.equal(inSection(t, 'fyi'), false);
	});

	it('Needs you counts messages (the same number as the member card); the other lists count conversations', () => {
		const c = sectionCounts([counts(3, 2), counts(1), counts(1), counts(0, 0, 1), counts(0, 0, 0, 2), counts(2, 1, 1, 1)]);
		assert.deepEqual(c, { needs: 3, fyi: 2, done: 2, sent: 2, needsMessages: 3 });
		assert.deepEqual(sectionCounts([]), { needs: 0, fyi: 0, done: 0, sent: 0, needsMessages: 0 });
	});

	it('lands on Needs you, else the first list with something in it, never an empty one when there is mail', () => {
		assert.equal(defaultSection([counts(1, 1), counts(1)]), 'needs');
		assert.equal(defaultSection([counts(1)]), 'fyi');
		assert.equal(defaultSection([counts(0, 0, 4)]), 'done');
		assert.equal(defaultSection([counts(0, 0, 0, 1)]), 'sent');
		assert.equal(defaultSection([]), 'needs');
	});

	it('the old stored filters map to the nearest section; All and junk mean no pick', () => {
		assert.equal(storedSection('inbox'), 'needs');
		assert.equal(storedSection('archives'), 'done');
		assert.equal(storedSection('sent'), 'sent');
		assert.equal(storedSection('fyi'), 'fyi');
		for (const v of ['all', '', 'junk', null, undefined]) assert.equal(storedSection(v), null, String(v));
	});

	it('search covers the thread text and the archived message ids the server found', () => {
		const t = {
			subject: 'Palette choice',
			preview: 'Meadow or Sky?',
			participants: ['ivy', 'van'],
			projectCodes: ['airevoSite'],
			messages: [{ id: 'm1' }, { id: 'm2' }] as never,
		};
		for (const q of ['palette', 'SKY', 'ivy', 'airevo', '  van ']) assert.equal(matchesSearch(t, q, new Set()), true, q);
		assert.equal(matchesSearch(t, 'budget', new Set()), false);
		assert.equal(matchesSearch(t, 'budget', new Set(['m2'])), true, 'body text found by the server');
		assert.equal(matchesSearch(t, 'budget', new Set(['other'])), false);
		assert.equal(matchesSearch(t, '   ', new Set()), true, 'no text, no filter');
	});

	it('a row says why it needs me, except for cards (the question chip does that)', () => {
		const m = (needs?: ('card' | 'reply' | 'mention' | 'pin')[]) => ({ id: 'x', needs }) as never;
		assert.deepEqual(rowReasons({ messages: [m(['card']), m(), m(['pin', 'reply'])] }), ['reply', 'pin']);
		assert.deepEqual(rowReasons({ messages: [m(['pin']), m(['mention'])] }), ['mention', 'pin']);
		assert.deepEqual(rowReasons({ messages: [m(['card'])] }), []);
		assert.deepEqual(rowReasons({ messages: [] }), []);
		assert.equal(reasonWord('reply'), 'reply wanted');
		assert.equal(reasonWord('pin'), 'pinned');
		assert.equal(reasonWord('mention'), 'tagged you');
	});

	it('labels: the member card number, the reasons, the sender marks', () => {
		assert.equal(needsLabel('van', 'van', 2), '2 need you');
		assert.equal(needsLabel('van', 'van', 1), '1 needs you');
		assert.equal(needsLabel('nate', 'van', 1), '1 needs nate');
		assert.equal(needsLabel('nate', null, 3), '3 need nate');
		assert.equal(reasonsText(['card', 'pin']), 'open question, pinned');
		assert.equal(reasonsText(['mention', 'pin']), 'tagged you, pinned');
		assert.equal(reasonsText(undefined), '');
		assert.equal(markBadge({ fyi: true })?.label, 'FYI');
		assert.equal(markBadge({ expectsReply: true })?.label, 'reply wanted');
		assert.equal(markBadge({ fyi: true, expectsReply: true })?.label, 'reply wanted', 'an ask is never shown as FYI');
		assert.equal(markBadge({}), null);
	});
});
