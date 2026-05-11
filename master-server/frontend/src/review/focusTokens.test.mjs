import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tokenizeNonSpace } from './focusTokens.js';

test('tokenizeNonSpace keeps CJK note text as a single token for focusPositions', () => {
  const text = 'while keeping the trolls (恶意挑衅的帖子) at bay.';

  assert.deepEqual(tokenizeNonSpace(text), [
    'while',
    'keeping',
    'the',
    'trolls',
    '(',
    '恶意挑衅的帖子',
    ')',
    'at',
    'bay',
    '.',
  ]);
});

test('tokenizeNonSpace matches keep-sth-at-bay focusPositions after a CJK note', () => {
  const text = 'Ms Gomez’s multi-millionaire status has allowed her to take the “social” out of social media, so she can continue to leverage her enormous fame while keeping the trolls (恶意挑衅的帖子) at bay.';
  const tokens = tokenizeNonSpace(text);

  assert.equal(tokens.length, 41);
  assert.equal(tokens[32], 'keeping');
  assert.equal(tokens[38], 'at');
  assert.equal(tokens[39], 'bay');
});
