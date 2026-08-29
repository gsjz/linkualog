import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyQueueIdentityRedirects,
  normalizeQueueItem,
  pickQueueEntry,
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

test('reconcileQueueItems keeps valid queue slots during transient recommendation changes', () => {
  const current = [
    normalizeQueueItem({ category: 'daily', file: 'alpha.json', word: 'alpha', addedAt: 'a' }, 'random'),
    normalizeQueueItem({ category: 'daily', file: 'bravo.json', word: 'bravo', addedAt: 'b' }, 'random'),
    normalizeQueueItem({ category: 'daily', file: 'charlie.json', word: 'charlie', addedAt: 'c' }, 'random'),
  ];
  const incoming = [
    normalizeQueueItem({ category: 'daily', file: 'delta.json', word: 'delta' }, 'random'),
    normalizeQueueItem({ category: 'daily', file: 'alpha.json', word: 'Alpha refreshed' }, 'random'),
  ];
  const validPool = [
    ...current,
    normalizeQueueItem({ category: 'daily', file: 'delta.json', word: 'delta' }, 'random'),
  ];

  const reconciled = reconcileQueueItems(current, incoming, validPool, 3);

  assert.deepEqual(reconciled.map((item) => item.id), [
    'daily/alpha.json',
    'daily/bravo.json',
    'daily/charlie.json',
  ]);
  assert.equal(reconciled[0].word, 'Alpha refreshed');
  assert.equal(reconciled[0].addedAt, 'a');
});

test('reconcileQueueItems removes invalid entries without moving surviving entries', () => {
  const current = [
    normalizeQueueItem({ category: 'daily', file: 'alpha.json', word: 'alpha' }, 'random'),
    normalizeQueueItem({ category: 'daily', file: 'bravo.json', word: 'bravo' }, 'random'),
    normalizeQueueItem({ category: 'daily', file: 'charlie.json', word: 'charlie' }, 'random'),
  ];
  const incoming = [
    normalizeQueueItem({ category: 'daily', file: 'delta.json', word: 'delta' }, 'random'),
  ];
  const validPool = [current[0], current[2], incoming[0]];

  const reconciled = reconcileQueueItems(current, incoming, validPool, 3);

  assert.deepEqual(reconciled.map((item) => item.id), [
    'daily/alpha.json',
    'daily/charlie.json',
    'daily/delta.json',
  ]);
});

test('reconcileQueueItems fills a skipped slot after preserving later valid entries', () => {
  const current = [
    normalizeQueueItem({ category: 'daily', file: 'alpha.json', word: 'alpha' }, 'random'),
    normalizeQueueItem({ category: 'daily', file: 'bravo.json', word: 'bravo' }, 'random'),
    normalizeQueueItem({ category: 'daily', file: 'charlie.json', word: 'charlie' }, 'random'),
  ];
  const incoming = [
    current[1],
    current[2],
    normalizeQueueItem({ category: 'daily', file: 'delta.json', word: 'delta' }, 'random'),
  ];

  const reconciled = reconcileQueueItems(current, incoming, incoming);

  assert.deepEqual(reconciled.map((item) => item.id), [
    'daily/bravo.json',
    'daily/charlie.json',
    'daily/delta.json',
  ]);
});

test('pickQueueEntry anchors next navigation to the current entry instead of the cursor', () => {
  const queue = ['alpha', 'bravo', 'charlie'].map((word) => (
    normalizeQueueItem({ category: 'daily', file: `${word}.json`, word }, 'random')
  ));

  const picked = pickQueueEntry(queue, 0, {
    afterId: 'daily/bravo.json',
    excludeIds: ['daily/bravo.json'],
  });

  assert.equal(picked.id, 'daily/charlie.json');
});

test('applyQueueIdentityRedirects prevents a stale snapshot from restoring a merged source', () => {
  const redirects = new Map([[
    'daily/alpha.json',
    { category: 'daily', file: 'bravo.json', word: 'bravo' },
  ]]);

  const stale = applyQueueIdentityRedirects([
    { category: 'daily', file: 'alpha.json', word: 'alpha' },
    { category: 'daily', file: 'charlie.json', word: 'charlie' },
  ], redirects);

  assert.deepEqual(stale.map((item) => item.file), ['bravo.json', 'charlie.json']);
  assert.equal(redirects.size, 1);

  const settled = applyQueueIdentityRedirects([
    { category: 'daily', file: 'bravo.json', word: 'bravo' },
    { category: 'daily', file: 'charlie.json', word: 'charlie' },
  ], redirects);

  assert.deepEqual(settled.map((item) => item.file), ['bravo.json', 'charlie.json']);
  assert.equal(redirects.size, 1);
});

test('applyQueueIdentityRedirects follows chained merges', () => {
  const redirects = new Map([
    ['daily/alpha.json', { category: 'daily', file: 'bravo.json', word: 'bravo' }],
    ['daily/bravo.json', { category: 'daily', file: 'charlie.json', word: 'charlie' }],
  ]);

  const result = applyQueueIdentityRedirects([
    { category: 'daily', file: 'alpha.json', word: 'alpha' },
  ], redirects);

  assert.equal(result[0].file, 'charlie.json');
});
