import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizeQueueItem,
  reconcileQueueItems,
  replaceQueueItems,
} from './useVocabularyQueues.js';

test('reconcileQueueItems keeps existing order and appends new entries', () => {
  const current = [
    normalizeQueueItem({ category: 'daily', file: 'alpha.json', word: 'alpha', addedAt: 'a' }, 'random'),
    normalizeQueueItem({ category: 'daily', file: 'bravo.json', word: 'bravo', addedAt: 'b' }, 'random'),
    normalizeQueueItem({ category: 'daily', file: 'charlie.json', word: 'charlie', addedAt: 'c' }, 'random'),
  ];
  const incoming = [
    normalizeQueueItem({ category: 'daily', file: 'charlie.json', word: 'Charlie updated' }, 'random'),
    normalizeQueueItem({ category: 'daily', file: 'alpha.json', word: 'Alpha updated' }, 'random'),
    normalizeQueueItem({ category: 'daily', file: 'delta.json', word: 'delta' }, 'random'),
  ];

  const reconciled = reconcileQueueItems(current, incoming);

  assert.deepEqual(reconciled.map((item) => item.id), [
    'daily/alpha.json',
    'daily/charlie.json',
    'daily/delta.json',
  ]);
  assert.equal(reconciled[0].word, 'Alpha updated');
  assert.equal(reconciled[0].addedAt, 'a');
  assert.equal(reconciled[1].word, 'Charlie updated');
  assert.equal(reconciled[1].addedAt, 'c');
});

test('replaceQueueItems keeps the source position when merging entries', () => {
  const state = {
    queues: {
      random: [
        normalizeQueueItem({ category: 'daily', file: 'alpha.json', word: 'alpha', addedAt: 'a' }, 'random'),
        normalizeQueueItem({ category: 'daily', file: 'bravo.json', word: 'bravo', addedAt: 'b' }, 'random'),
        normalizeQueueItem({ category: 'daily', file: 'charlie.json', word: 'charlie', addedAt: 'c' }, 'random'),
      ],
      manual: [],
      todo: [],
      preprocess: [],
    },
    cursor: { random: 2, manual: 0, todo: 0 },
    skipped: { random: [], manual: [], todo: [] },
  };

  const nextState = replaceQueueItems(
    state,
    { category: 'daily', file: 'charlie.json', word: 'charlie', source: 'random' },
    { category: 'daily', file: 'alpha.json', word: 'alpha-updated', source: 'random' },
  );

  assert.deepEqual(nextState.queues.random.map((item) => item.id), [
    'daily/bravo.json',
    'daily/alpha.json',
  ]);
  assert.equal(nextState.queues.random[1].word, 'alpha-updated');
  assert.equal(nextState.queues.random[1].addedAt, 'c');
  assert.equal(nextState.cursor.random, 1);
});
