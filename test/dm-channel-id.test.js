const test = require('node:test');
const assert = require('node:assert');
const { dmChannelId, isDmChannelId } = require('../libs/v3-envelope');

/**
 * TRIM_4_12_CONTRACT §1. The client derives the same id in Dart, so this
 * fixture vector is the cross-repo contract: change it and DMs stop routing.
 */
const ALICE = 'a3f2e8c5d';
const BOB = 'b1c2d3e4f';
const FIXTURE = 'dddb157c8f60f31b6a37bd1dbac44245';

test('the fixture pair derives the agreed channel id', () => {
  assert.strictEqual(dmChannelId(ALICE, BOB), FIXTURE);
});

test('the derivation is symmetric — both sides compute the same id offline', () => {
  assert.strictEqual(dmChannelId(BOB, ALICE), FIXTURE);
});

test('an id is `d` plus 31 hex chars, 32 in total', () => {
  const id = dmChannelId('000000001', 'fffffffff');
  assert.strictEqual(id.length, 32);
  assert.match(id, /^d[0-9a-f]{31}$/);
  assert.strictEqual(id, 'daea83a8c892d7aea12609dc292aa1a8');
});

test('a different peer derives a different id', () => {
  assert.notStrictEqual(dmChannelId(ALICE, BOB), dmChannelId(ALICE, 'c2d3e4f5a'));
});

test('a self DM is derivable and stable', () => {
  assert.strictEqual(dmChannelId(ALICE, ALICE), dmChannelId(ALICE, ALICE));
});

test('only a derived id is a DM id — a group UUID never is', () => {
  assert.ok(isDmChannelId(FIXTURE));
  // a UUID starting with `d` still has a dash at index 8, so the two id
  // spaces cannot collide
  assert.ok(!isDmChannelId('d1efabcd-7000-8000-8abc-000000000002'));
  assert.ok(!isDmChannelId('g1efabcd7000800'));
  assert.ok(!isDmChannelId(''));
  assert.ok(!isDmChannelId(undefined));
});
