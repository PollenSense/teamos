import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyInbox, countNeeds, needsReasons, readMarks, repliedIds, textMatches, validateMarks } from './inbox-rules.mjs';

test('validateMarks keeps only true marks, refuses both at once and non-booleans', () => {
	assert.deepEqual(validateMarks(), {});
	assert.deepEqual(validateMarks({ fyi: false, expectsReply: false }), {});
	assert.deepEqual(validateMarks({ fyi: true }), { fyi: true });
	assert.deepEqual(validateMarks({ expectsReply: true }), { expectsReply: true });
	assert.throws(() => validateMarks({ fyi: true, expectsReply: true }), (e) => e.status === 400 && /cannot both/.test(e.message));
	assert.throws(() => validateMarks({ fyi: 'yes' }), (e) => e.status === 400);
	assert.throws(() => validateMarks({ expectsReply: 1 }), (e) => e.status === 400);
});

test('readMarks reads the word true only; both marks in a hand-edited file read as the ask', () => {
	assert.deepEqual(readMarks({ fyi: 'true' }), { fyi: true });
	assert.deepEqual(readMarks({ expectsReply: 'true' }), { expectsReply: true });
	assert.deepEqual(readMarks({ fyi: 'false', expectsReply: 'no' }), {});
	assert.deepEqual(readMarks({ fyi: 'true', expectsReply: 'true' }), { expectsReply: true });
	assert.deepEqual(readMarks({}), {});
	assert.deepEqual(readMarks(undefined), {});
});

const ask = { id: 'm1', from: 'ivy', to: ['van'], expectsReply: true };

test('needsReasons: card, reply and pin each count; unmarked and fyi mail is FYI', () => {
	assert.deepEqual(needsReasons({ id: 'm1', from: 'ivy', to: ['van'] }, 'van'), []);
	assert.deepEqual(needsReasons({ id: 'm1', from: 'ivy', to: ['van'], fyi: true }, 'van'), []);
	assert.deepEqual(needsReasons(ask, 'van'), ['reply']);
	assert.deepEqual(needsReasons({ id: 'm1', from: 'ivy', to: ['van'] }, 'van', { cards: new Set(['m1']) }), ['card']);
	assert.deepEqual(needsReasons({ id: 'm1', from: 'ivy', to: ['van'] }, 'van', { pinned: new Set(['m1']) }), ['pin']);
	assert.deepEqual(needsReasons(ask, 'van', { cards: new Set(['m1']), pinned: new Set(['m1']) }), ['card', 'reply', 'pin']);
});

test('needsReasons: a reply ends the reply reason; a Cc is not asked; the sender is not asked', () => {
	assert.deepEqual(needsReasons(ask, 'van', { replied: new Set(['m1']) }), []);
	assert.deepEqual(needsReasons(ask, 'van', { replied: new Set(['m1']), pinned: new Set(['m1']) }), ['pin'], 'a pin outlives the reply');
	assert.deepEqual(needsReasons({ ...ask, to: ['nate'], cc: ['van'] }, 'van'), [], 'cc');
	assert.deepEqual(needsReasons({ ...ask, from: 'van', to: ['van'] }, 'van'), [], 'own message');
	assert.deepEqual(needsReasons({ id: 'm1', from: 'ivy', expectsReply: true }, 'van'), [], 'no To list: nothing is guessed');
});

test('repliedIds: every ancestor of what the member sent, however long the chain', async () => {
	const parents = { m3: 'm2', m2: 'm1', m1: undefined, x2: 'x1' };
	const seen = [];
	const parentOf = (id) => (seen.push(id), parents[id]);
	const replied = await repliedIds([{ id: 'r1', replyTo: 'm3' }], parentOf);
	assert.deepEqual([...replied].sort(), ['m1', 'm2', 'm3']);
	// a second reply in the same chain adds nothing and does not climb again
	seen.length = 0;
	const both = await repliedIds([{ id: 'r1', replyTo: 'm3' }, { id: 'r2', replyTo: 'm2' }, { id: 'r3', replyTo: 'x2' }], parentOf);
	assert.deepEqual([...both].sort(), ['m1', 'm2', 'm3', 'x1', 'x2']);
	assert.equal(seen.filter((id) => id === 'm2').length, 1, 'm2 climbed once');
	assert.deepEqual([...(await repliedIds([{ id: 'r1' }], parentOf))], [], 'a message that replies to nothing');
});

test('repliedIds survives a loop in a hand-edited store, and an async lookup', async () => {
	const parents = { a: 'b', b: 'a' };
	const replied = await repliedIds([{ id: 'r', replyTo: 'a' }], async (id) => parents[id]);
	assert.deepEqual([...replied].sort(), ['a', 'b']);
	assert.deepEqual([...(await repliedIds([{ id: 'a', replyTo: 'a' }], (id) => parents[id]))], [], 'a message replying to itself');
});

test('classifyInbox and countNeeds', () => {
	const inbox = [
		{ id: 'a', from: 'ivy', to: ['van'] },
		{ id: 'b', from: 'ivy', to: ['van'], expectsReply: true },
		{ id: 'c', from: 'ivy', to: ['van'], fyi: true },
	];
	const classified = classifyInbox(inbox, 'van', { cards: new Set(['a']) });
	assert.deepEqual([...classified], [['a', ['card']], ['b', ['reply']], ['c', []]]);
	assert.equal(countNeeds(classified), 2);
});

test('textMatches: subject, body, people and project; case-insensitive; needs two characters', () => {
	const msg = { subject: 'Palette', body: 'The Meadow option is calm', from: 'ivy', to: ['van'], cc: ['nate'], projectCode: 'airevoSite' };
	for (const q of ['palette', 'MEADOW', 'ivy', 'nate', 'airevo', ' calm ']) assert.ok(textMatches(msg, q), q);
	for (const q of ['', ' ', 'm', 'sky', undefined]) assert.ok(!textMatches(msg, q), String(q));
	assert.ok(!textMatches({ subject: 5, body: null }, 'xx'), 'odd fields do not throw');
});

test('needsReasons: a tag (mention) counts in To or Cc until the member replies; not for the sender; keeps its place in the reason order', () => {
	const tagged = { id: 'm1', from: 'ivy', to: ['nate'], cc: ['van'], mentions: ['van'] };
	assert.deepEqual(needsReasons(tagged, 'van'), ['mention'], 'a Cc is asked when tagged');
	assert.deepEqual(needsReasons({ ...tagged, to: ['van'], cc: [] }, 'van'), ['mention'], 'also in To');
	assert.deepEqual(needsReasons(tagged, 'nate'), [], 'not tagged: not asked');
	assert.deepEqual(needsReasons(tagged, 'van', { replied: new Set(['m1']) }), []);
	assert.deepEqual(needsReasons({ ...tagged, from: 'van' }, 'van'), [], 'own message');
	assert.deepEqual(
		needsReasons({ ...tagged, to: ['van'], expectsReply: true }, 'van', { cards: new Set(['m1']), pinned: new Set(['m1']) }),
		['card', 'reply', 'mention', 'pin'],
	);
	assert.deepEqual(needsReasons(tagged, 'van', { replied: new Set(['m1']), pinned: new Set(['m1']) }), ['pin']);
});
