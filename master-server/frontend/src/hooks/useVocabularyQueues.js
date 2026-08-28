import { useCallback, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'linkualog:vocabulary-queues:v1';
const STORAGE_VERSION = 3;
const QUEUE_NAMES = ['random', 'manual', 'todo', 'preprocess'];
const NAV_QUEUE_NAMES = ['random', 'manual', 'todo'];

const nowIso = () => new Date().toISOString();

export const QUEUE_LABELS = {
  random: '随机队列',
  manual: '手动队列',
  todo: '处理队列',
  preprocess: '预处理队列',
};

const normalizeFile = (value) => {
  const file = String(value || '').trim();
  if (!file) return '';
  return file.endsWith('.json') ? file : `${file}.json`;
};

export const normalizeQueueItem = (item, source = '') => {
  const category = String(item?.category || '').trim();
  const file = normalizeFile(item?.file || item?.filename || item?.key || item?.word);
  if (!category || !file) return null;
  const word = String(item?.word || file.replace(/\.json$/i, '')).trim();
  return {
    id: `${category}/${file}`,
    category,
    file,
    word,
    source: source || String(item?.source || '').trim() || 'manual',
    status: String(item?.status || (item?.locked ? 'locked' : 'ready')).trim() || 'ready',
    stage: String(item?.stage || '').trim(),
    stageLabel: String(item?.stageLabel || item?.stage_label || '').trim(),
    statusLabel: String(item?.statusLabel || item?.status_label || '').trim(),
    locked: Boolean(item?.locked),
    addedAt: String(item?.addedAt || item?.added_at || item?.queued_at || nowIso()),
    updatedAt: String(item?.updatedAt || item?.updated_at || nowIso()),
    meta: item?.meta && typeof item.meta === 'object' ? item.meta : {},
  };
};

const dedupeItems = (items) => {
  const map = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const normalized = normalizeQueueItem(item, item?.source);
    if (normalized && !map.has(normalized.id)) {
      map.set(normalized.id, normalized);
    }
  });
  return [...map.values()];
};

export const reconcileQueueItems = (currentItems, incomingItems) => {
  const incomingById = new Map((Array.isArray(incomingItems) ? incomingItems : [])
    .filter(Boolean)
    .map((item) => [item.id, item]));
  const used = new Set();
  const reconciled = (Array.isArray(currentItems) ? currentItems : [])
    .filter((item) => item?.id && incomingById.has(item.id))
    .map((item) => {
      used.add(item.id);
      return {
        ...item,
        ...incomingById.get(item.id),
        addedAt: item.addedAt || incomingById.get(item.id)?.addedAt || nowIso(),
      };
    });

  incomingItems.forEach((item) => {
    if (!item?.id || used.has(item.id)) return;
    reconciled.push(item);
  });

  return reconciled;
};

export const replaceQueueItems = (currentState, sourceItem, targetItem = null) => {
  const source = normalizeQueueItem(sourceItem, sourceItem?.source);
  const target = targetItem ? normalizeQueueItem(targetItem, targetItem?.source || source?.source || 'manual') : null;
  if (!source?.id) return currentState;

  let changed = false;
  const nextQueues = { ...currentState.queues };
  const nextCursor = { ...currentState.cursor };
  const nextSkipped = { ...currentState.skipped };

  QUEUE_NAMES.forEach((queueName) => {
    const queue = Array.isArray(currentState.queues?.[queueName]) ? currentState.queues[queueName] : [];
    const sourceIndex = queue.findIndex((item) => item.id === source.id);
    const targetIndex = target?.id ? queue.findIndex((item) => item.id === target.id) : -1;
    if (sourceIndex < 0 && targetIndex < 0) return;

    let nextQueue = [...queue];
    if (target?.id) {
      if (sourceIndex >= 0) {
        if (targetIndex >= 0 && targetIndex !== sourceIndex) {
          nextQueue.splice(targetIndex, 1);
          if (nextCursor[queueName] !== undefined && targetIndex < (nextCursor[queueName] || 0)) {
            nextCursor[queueName] = Math.max(0, (nextCursor[queueName] || 0) - 1);
          }
        }
        const adjustedSourceIndex = targetIndex >= 0 && targetIndex < sourceIndex
          ? sourceIndex - 1
          : sourceIndex;
        const existingSource = nextQueue[adjustedSourceIndex] || {};
        nextQueue[adjustedSourceIndex] = {
          ...existingSource,
          ...target,
          source: existingSource.source || target.source || queueName,
          addedAt: existingSource.addedAt || target.addedAt || nowIso(),
          updatedAt: nowIso(),
        };
      } else {
        nextQueue[targetIndex] = {
          ...nextQueue[targetIndex],
          ...target,
          source: nextQueue[targetIndex]?.source || target.source || queueName,
          addedAt: nextQueue[targetIndex]?.addedAt || target.addedAt || nowIso(),
          updatedAt: nowIso(),
        };
      }
    } else if (sourceIndex >= 0) {
      nextQueue.splice(sourceIndex, 1);
      if (nextCursor[queueName] !== undefined) {
        const currentCursor = nextCursor[queueName] || 0;
        nextCursor[queueName] = sourceIndex < currentCursor
          ? Math.max(0, currentCursor - 1)
          : Math.min(currentCursor, Math.max(0, nextQueue.length - 1));
      }
    }

    if (nextCursor[queueName] !== undefined) {
      nextCursor[queueName] = Math.min(
        Math.max(0, nextCursor[queueName] || 0),
        Math.max(0, nextQueue.length - 1),
      );
    }
    nextQueues[queueName] = nextQueue;
    changed = true;
  });

  NAV_QUEUE_NAMES.forEach((queueName) => {
    const skipped = normalizeIdList(currentState.skipped?.[queueName]);
    if (!skipped.includes(source.id)) return;
    nextSkipped[queueName] = target?.id
      ? normalizeIdList(skipped.map((id) => (id === source.id ? target.id : id)))
      : skipped.filter((id) => id !== source.id);
    changed = true;
  });

  return changed
    ? {
        ...currentState,
        queues: nextQueues,
        cursor: nextCursor,
        skipped: nextSkipped,
      }
    : currentState;
};

const normalizeIdList = (items) => (
  [...new Set((Array.isArray(items) ? items : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))]
);

const pickQueueEntry = (queue, cursor = 0, options = {}) => {
  const items = Array.isArray(queue) ? queue.filter(Boolean) : [];
  if (!items.length) return null;

  const excluded = new Set(normalizeIdList(options?.excludeIds));
  const afterId = String(options?.afterId || '').trim();
  if (afterId) {
    const afterIndex = items.findIndex((item) => item.id === afterId);
    if (afterIndex >= 0) {
      for (let offset = 1; offset <= items.length; offset += 1) {
        const candidate = items[(afterIndex + offset) % items.length];
        if (candidate && !excluded.has(candidate.id)) return candidate;
      }
      return null;
    }
  }

  const visibleItems = items.filter((item) => !excluded.has(item.id));
  if (!visibleItems.length) return null;
  const index = Math.min(Math.max(0, Number(cursor || 0)), visibleItems.length - 1);
  return visibleItems[index] || null;
};

const defaultState = () => ({
  activeQueue: 'random',
  nextQueue: 'random',
  collapsed: false,
  dockPosition: null,
  mobileSheet: 'compact',
  queues: {
    random: [],
    manual: [],
    todo: [],
    preprocess: [],
  },
  cursor: {
    random: 0,
    manual: 0,
    todo: 0,
  },
  skipped: {
    random: [],
    manual: [],
    todo: [],
  },
  syncKey: {
    random: '',
    manual: '',
    todo: '',
    preprocess: '',
  },
});

const readStoredState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const base = defaultState();
    const activeQueue = QUEUE_NAMES.includes(raw.activeQueue) ? raw.activeQueue : base.activeQueue;
    const nextQueue = NAV_QUEUE_NAMES.includes(raw.nextQueue) ? raw.nextQueue : base.nextQueue;
    return {
      ...base,
      activeQueue,
      nextQueue,
      collapsed: Number(raw.version || 0) >= STORAGE_VERSION && typeof raw.collapsed === 'boolean' ? raw.collapsed : base.collapsed,
      dockPosition: raw?.dockPosition && Number.isFinite(Number(raw.dockPosition.x)) && Number.isFinite(Number(raw.dockPosition.y))
        ? { x: Number(raw.dockPosition.x), y: Number(raw.dockPosition.y) }
        : base.dockPosition,
      mobileSheet: ['compact', 'expanded'].includes(raw.mobileSheet) ? raw.mobileSheet : base.mobileSheet,
      queues: {
        random: dedupeItems(raw?.queues?.random),
        manual: dedupeItems(raw?.queues?.manual),
        todo: dedupeItems(raw?.queues?.todo),
        preprocess: [],
      },
      cursor: {
        random: Math.max(0, Number(raw?.cursor?.random || 0)),
        manual: Math.max(0, Number(raw?.cursor?.manual || 0)),
        todo: Math.max(0, Number(raw?.cursor?.todo || 0)),
      },
      skipped: Number(raw.version || 0) >= STORAGE_VERSION
        ? {
            random: normalizeIdList(raw?.skipped?.random),
            manual: normalizeIdList(raw?.skipped?.manual),
            todo: normalizeIdList(raw?.skipped?.todo),
          }
        : base.skipped,
      syncKey: Number(raw.version || 0) >= STORAGE_VERSION
        ? {
            random: String(raw?.syncKey?.random || ''),
            manual: String(raw?.syncKey?.manual || ''),
            todo: String(raw?.syncKey?.todo || ''),
            preprocess: '',
          }
        : base.syncKey,
    };
  } catch {
    return defaultState();
  }
};

const persistState = (state) => {
  const payload = {
    version: STORAGE_VERSION,
    activeQueue: state.activeQueue,
    nextQueue: state.nextQueue,
    collapsed: state.collapsed,
    dockPosition: state.dockPosition,
    mobileSheet: state.mobileSheet,
    queues: {
      random: state.queues.random,
      manual: state.queues.manual,
      todo: state.queues.todo,
    },
    cursor: state.cursor,
    skipped: state.skipped,
    syncKey: {
      random: state.syncKey.random,
      manual: state.syncKey.manual,
      todo: state.syncKey.todo,
    },
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
};

export function useVocabularyQueues() {
  const [state, setState] = useState(readStoredState);

  useEffect(() => {
    persistState(state);
  }, [state]);

  const setActiveQueue = useCallback((queueName) => {
    setState((current) => {
      const activeQueue = QUEUE_NAMES.includes(queueName) ? queueName : current.activeQueue;
      return {
        ...current,
        activeQueue,
      };
    });
  }, []);

  const setNextQueue = useCallback((queueName) => {
    if (!NAV_QUEUE_NAMES.includes(queueName)) return;
    setState((current) => ({ ...current, nextQueue: queueName }));
  }, []);

  const setCollapsed = useCallback((collapsed) => {
    setState((current) => ({ ...current, collapsed: Boolean(collapsed) }));
  }, []);

  const setDockPosition = useCallback((position) => {
    setState((current) => {
      if (!position) return { ...current, dockPosition: null };
      const x = Number(position.x);
      const y = Number(position.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return current;
      return { ...current, dockPosition: { x, y } };
    });
  }, []);

  const resetDockPosition = useCallback(() => {
    setState((current) => ({ ...current, dockPosition: null }));
  }, []);

  const setMobileSheet = useCallback((sheet) => {
    if (!['compact', 'expanded'].includes(sheet)) return;
    setState((current) => ({ ...current, mobileSheet: sheet }));
  }, []);

  const syncQueue = useCallback((queueName, items, source = queueName, options = {}) => {
    if (!QUEUE_NAMES.includes(queueName)) return;
    const normalizedItems = dedupeItems((Array.isArray(items) ? items : [])
      .map((item) => ({ ...item, source })));
    setState((current) => ({
      ...current,
      ...(() => {
        const nextSyncKey = String(options?.syncKey || '');
        const syncKeyChanged = nextSyncKey !== String(current.syncKey?.[queueName] || '');
        const shouldReplaceItems = Boolean(options?.replace)
          || (syncKeyChanged && options?.preserveOrder !== true);
        const mergedItems = shouldReplaceItems
          ? normalizedItems
          : reconcileQueueItems(current.queues?.[queueName] || [], normalizedItems);
        const validIds = new Set(normalizedItems.map((item) => item.id));
        const skippedIds = syncKeyChanged && options?.preserveSkipped !== true
          ? []
          : normalizeIdList(current.skipped?.[queueName]).filter((id) => validIds.has(id));
        const skippedSet = new Set(skippedIds);
        const visibleItems = mergedItems.filter((item) => !skippedSet.has(item.id));
        return {
          queues: {
            ...current.queues,
            [queueName]: visibleItems,
          },
          cursor: current.cursor[queueName] !== undefined
            ? {
                ...current.cursor,
                [queueName]: Math.min(current.cursor[queueName] || 0, Math.max(0, visibleItems.length - 1)),
              }
            : current.cursor,
          skipped: {
            ...current.skipped,
            [queueName]: skippedIds,
          },
          syncKey: {
            ...current.syncKey,
            [queueName]: nextSyncKey,
          },
        };
      })(),
    }));
  }, []);

  const skipQueueItem = useCallback((queueName, itemId) => {
    if (!NAV_QUEUE_NAMES.includes(queueName)) return;
    const targetId = String(itemId || '').trim();
    if (!targetId) return;
    setState((current) => {
      const queue = current.queues[queueName] || [];
      const index = queue.findIndex((item) => item.id === targetId);
      const nextQueue = queue.filter((item) => item.id !== targetId);
      const currentCursor = current.cursor[queueName] || 0;
      const nextCursor = index >= 0 && index < currentCursor
        ? Math.max(0, currentCursor - 1)
        : Math.min(currentCursor, Math.max(0, nextQueue.length - 1));
      return {
        ...current,
        queues: {
          ...current.queues,
          [queueName]: nextQueue,
        },
        cursor: {
          ...current.cursor,
          [queueName]: nextCursor,
        },
        skipped: {
          ...current.skipped,
          [queueName]: normalizeIdList([...(current.skipped?.[queueName] || []), targetId]),
        },
      };
    });
  }, []);

  const replaceQueueItem = useCallback((sourceItem, targetItem = null) => {
    setState((current) => replaceQueueItems(current, sourceItem, targetItem));
  }, []);

  const addToTodo = useCallback((items) => {
    const normalizedItems = dedupeItems((Array.isArray(items) ? items : [items])
      .map((item) => ({ ...item, source: 'todo', status: item?.status || 'ready' })));
    if (!normalizedItems.length) return;
    setState((current) => {
      const existing = new Map(current.queues.todo.map((item) => [item.id, item]));
      normalizedItems.forEach((item) => {
        existing.set(item.id, {
          ...(existing.get(item.id) || {}),
          ...item,
          source: 'todo',
          addedAt: existing.get(item.id)?.addedAt || nowIso(),
          updatedAt: nowIso(),
        });
      });
      return {
        ...current,
        queues: {
          ...current.queues,
          todo: [...existing.values()],
        },
        skipped: {
          ...current.skipped,
          todo: normalizeIdList(current.skipped?.todo).filter((id) => !normalizedItems.some((item) => item.id === id)),
        },
      };
    });
  }, []);

  const removeTodo = useCallback((itemId) => {
    setState((current) => {
      const index = current.queues.todo.findIndex((item) => item.id === itemId);
      const todo = current.queues.todo.filter((item) => item.id !== itemId);
      const currentCursor = current.cursor.todo || 0;
      const nextCursor = index >= 0 && index < currentCursor
        ? Math.max(0, currentCursor - 1)
        : Math.min(currentCursor, Math.max(0, todo.length - 1));
      return {
        ...current,
        queues: { ...current.queues, todo },
        cursor: { ...current.cursor, todo: nextCursor },
      };
    });
  }, []);

  const clearTodo = useCallback(() => {
    setState((current) => ({
      ...current,
      queues: { ...current.queues, todo: [] },
      cursor: { ...current.cursor, todo: 0 },
      skipped: { ...current.skipped, todo: [] },
    }));
  }, []);

  const getNextEntry = useCallback((queueName = state.nextQueue, options = {}) => {
    if (!NAV_QUEUE_NAMES.includes(queueName)) return null;
    return pickQueueEntry(state.queues[queueName] || [], state.cursor[queueName] || 0, options);
  }, [state.cursor, state.nextQueue, state.queues]);

  const advanceQueue = useCallback((queueName = state.nextQueue) => {
    if (!NAV_QUEUE_NAMES.includes(queueName)) return;
    setState((current) => {
      const queue = current.queues[queueName] || [];
      if (!queue.length) return current;
      const currentCursor = current.cursor[queueName] || 0;
      return {
        ...current,
        cursor: {
          ...current.cursor,
          [queueName]: (currentCursor + 1) % queue.length,
        },
      };
    });
  }, [state.nextQueue]);

  const todoIds = useMemo(() => new Set(state.queues.todo.map((item) => item.id)), [state.queues.todo]);

  return {
    ...state,
    todoIds,
    setActiveQueue,
    setNextQueue,
    setCollapsed,
    setDockPosition,
    resetDockPosition,
    setMobileSheet,
    syncQueue,
    skipQueueItem,
    replaceQueueItem,
    addToTodo,
    removeTodo,
    clearTodo,
    getNextEntry,
    advanceQueue,
  };
}
