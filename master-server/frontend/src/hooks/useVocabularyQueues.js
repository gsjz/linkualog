import { useCallback, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'linkualog:vocabulary-queues:v1';
const STORAGE_VERSION = 2;
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

const normalizeQueueItem = (item, source = '') => {
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

  const syncQueue = useCallback((queueName, items, source = queueName) => {
    if (!QUEUE_NAMES.includes(queueName)) return;
    const normalizedItems = dedupeItems((Array.isArray(items) ? items : [])
      .map((item) => ({ ...item, source })));
    setState((current) => ({
      ...current,
      queues: {
        ...current.queues,
        [queueName]: normalizedItems,
      },
      cursor: current.cursor[queueName] !== undefined
        ? {
            ...current.cursor,
            [queueName]: Math.min(current.cursor[queueName] || 0, Math.max(0, normalizedItems.length - 1)),
          }
        : current.cursor,
    }));
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
    }));
  }, []);

  const getNextEntry = useCallback((queueName = state.nextQueue) => {
    if (!NAV_QUEUE_NAMES.includes(queueName)) return null;
    const queue = state.queues[queueName] || [];
    if (!queue.length) return null;
    const index = Math.min(state.cursor[queueName] || 0, queue.length - 1);
    return queue[index] || null;
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
    addToTodo,
    removeTodo,
    clearTodo,
    getNextEntry,
    advanceQueue,
  };
}
