import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import VocabularyReview from './VocabularyReview.jsx';
import ReviewWorkspace from '../review/App.jsx';
import UiIcon from './UiIcon.jsx';
import VocabularyQueueDock from './VocabularyQueueDock.jsx';
import { useVocabularyQueues } from '../hooks/useVocabularyQueues.js';
import {
  fetchVocabularyPreprocessQueue,
  fetchReviewAnalysisJob,
  startVocabularyPreprocessJob,
} from '../api/client.js';

const normalizeVocabularyLaunchWord = (value) => String(value || '')
  .trim()
  .replace(/\.json$/i, '');

const normalizeWorkspaceFocus = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'connection' || normalized === 'connect') return 'connection';
  return 'editor';
};

const buildReviewLaunchRequest = ({ category = '', word = '', focus = 'clean' } = {}) => {
  const normalizedWord = normalizeVocabularyLaunchWord(word);
  if (!normalizedWord) return null;

  return {
    category: String(category || '').trim(),
    filename: normalizedWord.endsWith('.json') ? normalizedWord : `${normalizedWord}.json`,
    word: normalizedWord,
    fileKey: normalizedWord,
    focus: normalizeWorkspaceFocus(focus),
  };
};

const AUTO_LLM_STORAGE_KEY = 'vocabWorkspaceAutoLlmOnOpen';
const QUEUE_LIMITS_STORAGE_KEY = 'linkualog:vocabulary-queue-limits:v1';
const QUEUE_LIMIT_DEFAULTS = {
  randomQueueLimit: 8,
  preprocessLimit: 50,
};

const getStoredAutoLlmOnOpen = () => (
  localStorage.getItem(AUTO_LLM_STORAGE_KEY) !== '0'
);

const normalizeQueueLimit = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(50, parsed));
};

const normalizeQueueLimits = (value = {}) => ({
  randomQueueLimit: normalizeQueueLimit(value.randomQueueLimit, QUEUE_LIMIT_DEFAULTS.randomQueueLimit),
  preprocessLimit: normalizeQueueLimit(value.preprocessLimit, QUEUE_LIMIT_DEFAULTS.preprocessLimit),
});

const getStoredQueueLimits = () => {
  try {
    return normalizeQueueLimits(JSON.parse(localStorage.getItem(QUEUE_LIMITS_STORAGE_KEY) || '{}'));
  } catch {
    return normalizeQueueLimits();
  }
};

const buildAutoLlmLaunchToken = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const randomSnapshotMetaKey = (snapshot) => [
  String(snapshot?.randomSeed || ''),
  String(snapshot?.randomScope || ''),
  String(snapshot?.randomFilter || ''),
  String(snapshot?.randomQuery || ''),
  String(snapshot?.randomLimit || ''),
  String(snapshot?.randomPreferences || ''),
].join('\u0001');

const sleep = (ms) => new Promise((resolve) => {
  window.setTimeout(resolve, ms);
});

const isTerminalAnalysisJob = (job) => ['success', 'error'].includes(String(job?.status || '').trim());

const preprocessStageLabel = (item) => {
  const label = String(item?.stage_label || item?.status_label || '').trim();
  if (label) return label;
  const stage = String(item?.stage || item?.status || '').trim();
  if (stage === 'refine') return '编辑建议';
  if (stage === 'relations') return '连边建议';
  if (stage === 'queued') return '等待';
  if (stage === 'success') return '完成';
  if (stage === 'error') return '失败';
  return '预处理';
};

const preprocessCacheStatus = (item, key) => (
  String(item?.summary?.[key]?.cache?.status || '').trim()
);

const preprocessSuggestionCount = (item, key) => (
  Number(item?.summary?.[key]?.suggestion_count ?? item?.summary?.[key]?.suggestionCount ?? 0)
);

const preprocessItemReadyFilesByCategory = (items, key) => {
  const ready = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const category = String(item?.category || '').trim();
    const file = String(item?.file || '').trim();
    if (!category || !file) return;
    const status = String(item?.status || '').trim();
    const phaseStatus = String(item?.summary?.[key]?.status || '').trim();
    const llmError = item?.summary?.[key]?.llm_error;
    const cacheStatus = preprocessCacheStatus(item, key);
    const suggestionCount = preprocessSuggestionCount(item, key);
    const completeEnough = status === 'success' || status === 'skipped' || phaseStatus === 'success';
    if (!completeEnough || llmError || !['hit', 'stored'].includes(cacheStatus) || suggestionCount <= 0) return;
    const files = ready.get(category) || [];
    files.push(file);
    ready.set(category, files);
  });
  return ready;
};

const waitForAnalysisJob = async (jobOrId, onUpdate = null) => {
  const jobId = String(jobOrId?.job_id || jobOrId?.id || jobOrId || '').trim();
  if (!jobId) {
    throw new Error('后台分析任务 id 为空');
  }

  let current = typeof jobOrId === 'object' ? jobOrId : null;
  if (typeof onUpdate === 'function' && current) onUpdate(current);

  while (!isTerminalAnalysisJob(current)) {
    await sleep(1200);
    current = await fetchReviewAnalysisJob(jobId);
    if (typeof onUpdate === 'function') onUpdate(current);
  }

  return current;
};

function SurfaceLaunchButton({
  surface,
  label,
  icon,
  disabled,
  onOpen,
  active = false,
  hasReadySuggestion = false,
  title = '',
  compactIconOnly = false,
}) {
  return (
    <button
      type="button"
      className={`vocab-mode-switch${active ? ' is-on' : ''}${hasReadySuggestion ? ' has-ready-suggestion' : ''}${compactIconOnly ? ' is-icon-only' : ''}`}
      aria-label={`打开${label}面板`}
      data-tooltip={title || `打开${label}面板`}
      onClick={() => onOpen(surface)}
      disabled={disabled}
    >
      {hasReadySuggestion ? <span className="vocab-mode-switch-dot" aria-hidden="true" /> : null}
      <span className="vocab-mode-switch-icon">
        <UiIcon name={icon} size={17} />
      </span>
      {compactIconOnly ? null : <span className="vocab-mode-switch-copy">{label}</span>}
    </button>
  );
}

export default function VocabularyWorkspace({
  currentSelection = null,
  launchRequest = null,
  mobileSimple = false,
  compactDesktop = false,
  onOpenConfig = null,
  onSelectionChange = null,
}) {
  const [studyMode, setStudyMode] = useState('random');
  const [editorSurface, setEditorSurface] = useState('');
  const [autoLlmLaunchToken, setAutoLlmLaunchToken] = useState('');
  const [autoLlmOnOpen, setAutoLlmOnOpen] = useState(getStoredAutoLlmOnOpen);
  const [reviewEntryUpdate, setReviewEntryUpdate] = useState(null);
  const [prefetchedRefineUpdate, setPrefetchedRefineUpdate] = useState(null);
  const [prefetchedRelationUpdate, setPrefetchedRelationUpdate] = useState(null);
  const [queueDockControlsHost, setQueueDockControlsHost] = useState(null);
  const [editorHeaderActionsHost, setEditorHeaderActionsHost] = useState(null);
  const [visibleScope, setVisibleScope] = useState({
    entries: [],
    selectedEntry: null,
    selectedCategory: '',
    entryFilter: '',
    wordQuery: '',
    totalCount: 0,
  });
  const [prefetchingRefine, setPrefetchingRefine] = useState(false);
  const [prefetchingRelations, setPrefetchingRelations] = useState(false);
  const [prefetchProgress, setPrefetchProgress] = useState({ done: 0, total: 0 });
  const [relationPrefetchProgress, setRelationPrefetchProgress] = useState({ done: 0, total: 0 });
  const [preprocessQueue, setPreprocessQueue] = useState({ items: [], active_count: 0, total: 0 });
  const [preprocessQueueError, setPreprocessQueueError] = useState('');
  const [queueLimits, setQueueLimits] = useState(getStoredQueueLimits);
  const [queueJumpRequest, setQueueJumpRequest] = useState(null);
  const [currentEntryActions, setCurrentEntryActions] = useState(null);
  const [queueSettingsOpen, setQueueSettingsOpen] = useState(false);
  const overlayReadyAutoLoadRef = useRef({ editor: '', connection: '' });
  const randomSnapshotMetaKeyRef = useRef('');
  const {
    activeQueue,
    nextQueue,
    collapsed: queueDockCollapsed,
    dockPosition: queueDockPosition,
    mobileSheet: queueDockMobileSheet,
    queues,
    cursor,
    todoIds,
    setActiveQueue,
    setNextQueue,
    setCollapsed: setQueueDockCollapsed,
    setDockPosition: setQueueDockPosition,
    resetDockPosition: resetQueueDockPosition,
    setMobileSheet: setQueueDockMobileSheet,
    syncQueue,
    addToTodo,
    removeTodo,
    clearTodo,
    getNextEntry,
    skipQueueItem,
    replaceQueueItem,
  } = useVocabularyQueues();
  const reviewSurfaceMobileSimple = mobileSimple;

  const sharedLaunchRequest = useMemo(() => {
    const request = buildReviewLaunchRequest({
      category: currentSelection?.category || launchRequest?.category,
      word: currentSelection?.word || currentSelection?.filename || launchRequest?.fileKey || launchRequest?.word,
      focus: launchRequest?.focus || 'editor',
    });
    const queueSource = String(launchRequest?.queueSource || launchRequest?.sourceQueue || '').trim();
    return request && queueSource ? { ...request, queueSource } : request;
  }, [currentSelection?.category, currentSelection?.filename, currentSelection?.word, launchRequest?.category, launchRequest?.fileKey, launchRequest?.focus, launchRequest?.queueSource, launchRequest?.sourceQueue, launchRequest?.word]);

  const reviewSurfaceCompactDesktop = compactDesktop;
  const hasSelection = Boolean(sharedLaunchRequest?.filename);
  const overlayLaunchRequest = useMemo(() => (
    editorSurface
      ? buildReviewLaunchRequest({
          category: sharedLaunchRequest?.category,
          word: sharedLaunchRequest?.filename || sharedLaunchRequest?.word,
          focus: editorSurface,
        })
      : null
  ), [editorSurface, sharedLaunchRequest?.category, sharedLaunchRequest?.filename, sharedLaunchRequest?.word]);
  const finalOverlayLaunchRequest = useMemo(() => (
    overlayLaunchRequest
      ? {
          ...overlayLaunchRequest,
          autoRefineToken: editorSurface === 'editor' ? autoLlmLaunchToken : '',
          autoRelationSuggestToken: editorSurface === 'connection' ? autoLlmLaunchToken : '',
        }
      : null
  ), [autoLlmLaunchToken, editorSurface, overlayLaunchRequest]);

  useEffect(() => {
    const handleConfigUpdate = () => {
      setAutoLlmOnOpen(getStoredAutoLlmOnOpen());
    };

    window.addEventListener('config-updated', handleConfigUpdate);
    return () => window.removeEventListener('config-updated', handleConfigUpdate);
  }, []);

  const handleQueueLimitsChange = useCallback((nextLimitsOrUpdater) => {
    setQueueLimits((current) => normalizeQueueLimits(
      typeof nextLimitsOrUpdater === 'function'
        ? nextLimitsOrUpdater(current)
        : nextLimitsOrUpdater,
    ));
  }, []);

  useEffect(() => {
    localStorage.setItem(QUEUE_LIMITS_STORAGE_KEY, JSON.stringify(queueLimits));
  }, [queueLimits]);

  const openWorkspaceSurface = (surface = 'editor') => {
    if (!hasSelection) return;
    setAutoLlmLaunchToken(autoLlmOnOpen ? buildAutoLlmLaunchToken() : '');
    setEditorSurface(surface);
  };

  const handleAutoLlmOnOpenChange = useCallback((enabled) => {
    const nextEnabled = Boolean(enabled);
    setAutoLlmOnOpen(nextEnabled);
    localStorage.setItem(AUTO_LLM_STORAGE_KEY, nextEnabled ? '1' : '0');
    window.dispatchEvent(new Event('config-updated'));
    if (nextEnabled && editorSurface && hasSelection) {
      setAutoLlmLaunchToken(buildAutoLlmLaunchToken());
    }
  }, [editorSurface, hasSelection]);
  const markRefineCached = useCallback((category, files) => {
    const normalizedCategory = String(category || '').trim();
    const fileSet = new Set((Array.isArray(files) ? files : [])
      .map((file) => String(file || '').trim())
      .filter(Boolean));
    if (!normalizedCategory || !fileSet.size) return;
    const normalizedFiles = [...fileSet];

    setVisibleScope((current) => ({
      ...current,
      entries: (Array.isArray(current.entries) ? current.entries : []).map((entry) => (
        String(entry.category || '').trim() === normalizedCategory && fileSet.has(String(entry.file || '').trim())
          ? { ...entry, refineCached: true, refine_cached: true }
          : entry
      )),
      selectedEntry: current.selectedEntry
        && String(current.selectedEntry.category || '').trim() === normalizedCategory
        && fileSet.has(String(current.selectedEntry.file || '').trim())
        ? { ...current.selectedEntry, refineCached: true, refine_cached: true }
        : current.selectedEntry,
    }));
    setPrefetchedRefineUpdate({
      category: normalizedCategory,
      files: normalizedFiles,
      token: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
  }, []);

  const markRelationCached = useCallback((category, files) => {
    const normalizedCategory = String(category || '').trim();
    const fileSet = new Set((Array.isArray(files) ? files : [])
      .map((file) => String(file || '').trim())
      .filter(Boolean));
    if (!normalizedCategory || !fileSet.size) return;
    const normalizedFiles = [...fileSet];

    setVisibleScope((current) => ({
      ...current,
      entries: (Array.isArray(current.entries) ? current.entries : []).map((entry) => (
        String(entry.category || '').trim() === normalizedCategory && fileSet.has(String(entry.file || '').trim())
          ? { ...entry, relationCached: true, relation_cached: true }
          : entry
      )),
      selectedEntry: current.selectedEntry
        && String(current.selectedEntry.category || '').trim() === normalizedCategory
        && fileSet.has(String(current.selectedEntry.file || '').trim())
        ? { ...current.selectedEntry, relationCached: true, relation_cached: true }
        : current.selectedEntry,
    }));
    setPrefetchedRelationUpdate({
      category: normalizedCategory,
      files: normalizedFiles,
      token: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
  }, []);

  const refreshPreprocessQueue = useCallback(async () => {
    try {
      const queue = await fetchVocabularyPreprocessQueue({ includeFinished: true, limit: 160 });
      const items = Array.isArray(queue?.items) ? queue.items : [];
      setPreprocessQueue({
        items,
        active: Array.isArray(queue?.active) ? queue.active : [],
        active_count: Number(queue?.active_count || 0),
        total: Number(queue?.total || 0),
      });
      preprocessItemReadyFilesByCategory(items, 'refine').forEach((files, categoryName) => {
        markRefineCached(categoryName, files);
      });
      preprocessItemReadyFilesByCategory(items, 'relations').forEach((files, categoryName) => {
        markRelationCached(categoryName, files);
      });
      setPreprocessQueueError('');
      return queue;
    } catch (error) {
      setPreprocessQueueError(error?.message || '读取预处理队列失败');
      return null;
    }
  }, [markRefineCached, markRelationCached]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    const poll = async () => {
      if (cancelled) return;
      const queue = await refreshPreprocessQueue();
      if (cancelled) return;
      const hasActive = Number(queue?.active_count || 0) > 0 || prefetchingRefine || prefetchingRelations;
      timer = window.setTimeout(poll, hasActive ? 1600 : 7000);
    };

    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [prefetchingRefine, prefetchingRelations, refreshPreprocessQueue]);

  const handleVisibleScopeChange = useCallback((scope) => {
    setVisibleScope(scope || {});
  }, []);

  const handleQueueSnapshotChange = useCallback((snapshot) => {
    if (Array.isArray(snapshot?.manual)) {
      syncQueue('manual', snapshot.manual, 'manual', { syncKey: snapshot?.manualSyncKey });
    }
    if (Array.isArray(snapshot?.random)) {
      const nextRandomMetaKey = randomSnapshotMetaKey(snapshot);
      const preserveRandomOrder = Boolean(
        nextRandomMetaKey
        && randomSnapshotMetaKeyRef.current
        && randomSnapshotMetaKeyRef.current === nextRandomMetaKey
      );
      randomSnapshotMetaKeyRef.current = nextRandomMetaKey;
      syncQueue('random', snapshot.random, 'random', {
        syncKey: snapshot?.randomSyncKey,
        preserveOrder: preserveRandomOrder,
        preserveSkipped: preserveRandomOrder,
      });
    } else {
      randomSnapshotMetaKeyRef.current = '';
    }
  }, [syncQueue]);

  const handleQueueDockControlsHostRef = useCallback((node) => {
    setQueueDockControlsHost(node);
  }, []);

  const handleEditorHeaderActionsHostRef = useCallback((node) => {
    setEditorHeaderActionsHost(node);
  }, []);

  const handleCurrentEntryActionsChange = useCallback((actions) => {
    setCurrentEntryActions(actions || null);
  }, []);

  const handlePrefetchVisible = useCallback(async () => {
    if (prefetchingRefine || prefetchingRelations) return;

    const rawEntries = Array.isArray(visibleScope.entries) ? visibleScope.entries : [];
    const preprocessLimit = normalizeQueueLimit(queueLimits.preprocessLimit, QUEUE_LIMIT_DEFAULTS.preprocessLimit);
    const targetsByCategory = new Map();
    rawEntries
      .filter((entry) => (
        (entry?.needsProcessing && !entry?.refineCached)
        || !entry?.relationCached
      ))
      .slice(0, preprocessLimit)
      .forEach((entry) => {
        const category = String(entry.category || '').trim();
        const file = String(entry.file || '').trim();
        if (!category || !file) return;
        const files = targetsByCategory.get(category) || [];
        files.push(file);
        targetsByCategory.set(category, files);
      });

    const total = [...targetsByCategory.values()].reduce((sum, files) => sum + files.length, 0);
    if (!total) return;

    setPrefetchingRefine(true);
    setPrefetchingRelations(true);
    setPrefetchProgress({ done: 0, total });
    setRelationPrefetchProgress({ done: 0, total });
    let completedBeforeCategory = 0;
    try {
      for (const [category, files] of targetsByCategory.entries()) {
        try {
          const job = await startVocabularyPreprocessJob(category, files, { limit: files.length });
          void refreshPreprocessQueue();
          const finalJob = await waitForAnalysisJob(job, (currentJob) => {
            const progress = currentJob?.progress || {};
            const done = Math.min(total, completedBeforeCategory + Number(progress.done || 0));
            setPrefetchProgress({ done, total });
            setRelationPrefetchProgress({
              done,
              total,
            });
            void refreshPreprocessQueue();
          });
          void refreshPreprocessQueue();
          const resultItems = Array.isArray(finalJob?.result?.results) ? finalJob.result.results : [];
          const refineReadyFiles = resultItems
            .filter((item) => (
              ['success', 'partial'].includes(String(item?.status || ''))
              && !item?.refine?.llm_error
              && ['hit', 'stored'].includes(String(item?.refine?.cache?.status || ''))
              && Number(item?.refine?.suggestion_count ?? item?.refine?.suggestionCount ?? 0) > 0
            ))
            .map((item) => item.file)
            .filter(Boolean);
          const relationReadyFiles = resultItems
            .filter((item) => (
              ['success', 'partial'].includes(String(item?.status || ''))
              && !item?.relations?.llm_error
              && ['hit', 'stored'].includes(String(item?.relations?.cache?.status || ''))
              && Number(item?.relations?.suggestion_count ?? item?.relations?.suggestionCount ?? 0) > 0
            ))
            .map((item) => item.file)
            .filter(Boolean);
          if (refineReadyFiles.length) {
            markRefineCached(category, refineReadyFiles);
          }
          if (relationReadyFiles.length) {
            markRelationCached(category, relationReadyFiles);
          }
        } catch (error) {
          console.error('预生成整理和连接建议失败', error);
        } finally {
          completedBeforeCategory += files.length;
          setPrefetchProgress({ done: Math.min(total, completedBeforeCategory), total });
          setRelationPrefetchProgress({ done: Math.min(total, completedBeforeCategory), total });
        }
      }
    } finally {
      setPrefetchingRefine(false);
      setPrefetchingRelations(false);
      void refreshPreprocessQueue();
    }
  }, [markRefineCached, markRelationCached, prefetchingRefine, prefetchingRelations, queueLimits.preprocessLimit, refreshPreprocessQueue, visibleScope.entries]);

  const handleVocabularyEntryChange = (change) => {
    const normalizedCategory = String(change?.category || sharedLaunchRequest?.category || '').trim();
    const savedFilename = normalizeVocabularyLaunchWord(
      change?.file
      || change?.target_file
      || change?.filename
      || change?.fileKey
      || change?.data?.word
      || change?.word,
    );
    if (!normalizedCategory || !savedFilename) return;

    if (change?.relationCached || change?.relation_cached) {
      const relationFile = savedFilename.endsWith('.json') ? savedFilename : `${savedFilename}.json`;
      markRelationCached(normalizedCategory, [relationFile]);
      return;
    }

    const nextUpdate = {
      ...(change || {}),
      category: normalizedCategory,
      file: savedFilename.endsWith('.json') ? savedFilename : `${savedFilename}.json`,
      fileKey: savedFilename,
      token: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
    setReviewEntryUpdate(nextUpdate);

    const sourceCategory = String(change?.source_category || change?.sourceCategory || normalizedCategory).trim();
    const sourceFilename = normalizeVocabularyLaunchWord(
      change?.source_file
      || change?.sourceFile
      || change?.source_filename
      || change?.sourceFilename
      || ''
    );
    if (change?.deleted) {
      replaceQueueItem({
        category: normalizedCategory,
        file: nextUpdate.file,
        word: change?.word || savedFilename,
      }, null);
      if (typeof onSelectionChange === 'function') {
        onSelectionChange({
          category: '',
          word: '',
          fileKey: '',
          filename: '',
          queueSource: '',
        });
      }
      setEditorSurface('');
      return;
    } else if (sourceCategory && sourceFilename) {
      replaceQueueItem({
        category: sourceCategory,
        file: sourceFilename.endsWith('.json') ? sourceFilename : `${sourceFilename}.json`,
        word: change?.source_word || change?.sourceWord || sourceFilename,
      }, {
        category: normalizedCategory,
        file: nextUpdate.file,
        word: change?.data?.word || change?.target_word || change?.targetWord || change?.word || savedFilename,
      });
    }

    if (typeof onSelectionChange === 'function') {
      onSelectionChange({
        category: normalizedCategory,
        word: savedFilename,
        fileKey: savedFilename,
        filename: nextUpdate.file,
      });
    }

    const shouldKeepSelection = Boolean(change?.keepSelection || change?.keep_selection);
    if (change?.closeEditor === true || (change?.closeEditor !== false && !shouldKeepSelection)) {
      setEditorSurface('');
    }
  };

  useEffect(() => {
    const items = preprocessQueueError
      ? [{
          category: 'system',
          file: 'preprocess-error.json',
          word: preprocessQueueError,
          source: 'preprocess',
          status: 'error',
          stageLabel: '读取失败',
        }]
      : (Array.isArray(preprocessQueue.items) ? preprocessQueue.items : []).map((item) => ({
          category: item.category,
          file: item.file,
          word: item.word || String(item.file || '').replace(/\.json$/i, ''),
          source: 'preprocess',
          status: item.locked ? 'locked' : item.status,
          stage: item.stage,
          stageLabel: preprocessStageLabel(item),
          statusLabel: item.status_label,
          locked: item.locked,
          addedAt: item.queued_at,
          updatedAt: item.updated_at,
          meta: {
            refineReady: preprocessCacheStatus(item, 'refine') === 'hit' || preprocessCacheStatus(item, 'refine') === 'stored',
            relationReady: preprocessCacheStatus(item, 'relations') === 'hit' || preprocessCacheStatus(item, 'relations') === 'stored',
          },
        }));
    syncQueue('preprocess', items, 'preprocess');
  }, [preprocessQueue.items, preprocessQueueError, syncQueue]);

  const jumpToQueueEntry = useCallback((item, sourceQueue = activeQueue) => {
    const category = String(item?.category || '').trim();
    const file = String(item?.file || '').trim();
    if (!category || !file) return;
    const normalizedSourceQueue = ['random', 'manual', 'todo', 'preprocess'].includes(sourceQueue)
      ? sourceQueue
      : activeQueue;
    setQueueJumpRequest({
      category,
      file,
      word: item.word || file.replace(/\.json$/i, ''),
      sourceQueue: normalizedSourceQueue,
      token: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    if (typeof onSelectionChange === 'function') {
      onSelectionChange({
        category,
        filename: file,
        fileKey: file,
        word: item.word || file.replace(/\.json$/i, ''),
        queueSource: normalizedSourceQueue,
      });
    }
  }, [activeQueue, onSelectionChange]);

  const handleQueueNextEntry = useCallback(() => {
    const currentSource = String(currentEntryActions?.queueSource || '').trim();
    const currentCategory = String(currentEntryActions?.category || '').trim();
    const rawCurrentFile = String(currentEntryActions?.file || '').trim();
    const currentFile = rawCurrentFile && rawCurrentFile.endsWith('.json')
      ? rawCurrentFile
      : (rawCurrentFile ? `${rawCurrentFile}.json` : '');
    const fallbackCurrentId = currentCategory && currentFile ? `${currentCategory}/${currentFile}` : '';
    const currentId = fallbackCurrentId || String(currentEntryActions?.id || '').trim();
    const shouldSkipCurrent = currentId && currentSource === nextQueue && ['random', 'manual', 'todo'].includes(nextQueue);
    const nextEntry = getNextEntry(nextQueue, shouldSkipCurrent ? {
      afterId: currentId,
      excludeIds: [currentId],
    } : {});
    if (shouldSkipCurrent) {
      skipQueueItem(nextQueue, currentId);
    }
    if (!nextEntry) return;
    jumpToQueueEntry(nextEntry, nextQueue);
  }, [currentEntryActions?.category, currentEntryActions?.file, currentEntryActions?.id, currentEntryActions?.queueSource, getNextEntry, jumpToQueueEntry, nextQueue, skipQueueItem]);

  const visibleEntries = Array.isArray(visibleScope.entries) ? visibleScope.entries : [];
  const selectedVisibleEntry = visibleScope.selectedEntry || null;

  const selectedVisibleEntryKey = selectedVisibleEntry
    ? `${String(selectedVisibleEntry.category || '').trim()}/${String(selectedVisibleEntry.file || '').trim()}`
    : '';

  useEffect(() => {
    if (!editorSurface || !selectedVisibleEntryKey) return;
    if (!autoLlmOnOpen) return;
    if (editorSurface === 'editor' && selectedVisibleEntry?.refineCached) {
      if (overlayReadyAutoLoadRef.current.editor === selectedVisibleEntryKey) return;
      overlayReadyAutoLoadRef.current.editor = selectedVisibleEntryKey;
      setAutoLlmLaunchToken(buildAutoLlmLaunchToken());
      return;
    }
    if (editorSurface === 'connection' && selectedVisibleEntry?.relationCached) {
      if (overlayReadyAutoLoadRef.current.connection === selectedVisibleEntryKey) return;
      overlayReadyAutoLoadRef.current.connection = selectedVisibleEntryKey;
      setAutoLlmLaunchToken(buildAutoLlmLaunchToken());
    }
  }, [autoLlmOnOpen, editorSurface, selectedVisibleEntry?.refineCached, selectedVisibleEntry?.relationCached, selectedVisibleEntryKey]);

  useEffect(() => {
    overlayReadyAutoLoadRef.current = { editor: '', connection: '' };
  }, [selectedVisibleEntryKey]);
  const prefetchTargetCount = visibleEntries.filter((entry) => entry?.needsProcessing && !entry?.refineCached).length;
  const relationPrefetchTargetCount = visibleEntries.filter((entry) => !entry?.relationCached).length;
  const prefetchTargetEntryCount = visibleEntries.filter((entry) => (
    (entry?.needsProcessing && !entry?.refineCached)
    || !entry?.relationCached
  )).length;
  const selectedHasReadySuggestion = Boolean(selectedVisibleEntry?.refineCached);
  const selectedHasReadyRelationSuggestion = Boolean(selectedVisibleEntry?.relationCached);
  const prefetching = prefetchingRefine || prefetchingRelations;
  const preprocessLimit = normalizeQueueLimit(queueLimits.preprocessLimit, QUEUE_LIMIT_DEFAULTS.preprocessLimit);
  const prefetchTargetTotal = prefetchTargetEntryCount;
  const prefetchLabel = prefetchingRefine
    ? `整理 ${prefetchProgress.done}/${prefetchProgress.total}`
    : prefetchingRelations
    ? `连边 ${relationPrefetchProgress.done}/${relationPrefetchProgress.total}`
    : '预生成';
  const prefetchTitleTargets = [
    prefetchTargetCount ? `整理 ${Math.min(prefetchTargetCount, preprocessLimit)}` : '',
    relationPrefetchTargetCount ? `连接 ${Math.min(relationPrefetchTargetCount, preprocessLimit)}` : '',
  ].filter(Boolean);
  const prefetchTitle = `预生成当前范围内的整理和连接建议${prefetchTitleTargets.length ? ` (${prefetchTitleTargets.join('，')})` : ''}`;
  const editorSurfaceTitle = {
    editor: '手动整理',
    connection: '连接',
  }[editorSurface] || '手动整理';
  const editorPanelAriaLabel = {
    editor: '手动整理面板',
    connection: '连接面板',
  }[editorSurface] || '手动整理面板';
  const compactEntryActionLabels = reviewSurfaceMobileSimple && !reviewSurfaceCompactDesktop;
  const entryActionsNode = hasSelection ? (
    <div className="vocab-word-inline-actions" aria-label="当前词条操作">
      <SurfaceLaunchButton
        surface="editor"
        label="编辑"
        icon="edit"
        disabled={!hasSelection}
        onOpen={openWorkspaceSurface}
        active={editorSurface === 'editor'}
        hasReadySuggestion={selectedHasReadySuggestion}
        title={selectedHasReadySuggestion ? '打开手动整理；已有预生成整理建议' : '打开手动整理'}
        compactIconOnly={compactEntryActionLabels}
      />
      <SurfaceLaunchButton
        surface="connection"
        label="连接"
        icon="network"
        disabled={!hasSelection}
        onOpen={openWorkspaceSurface}
        active={editorSurface === 'connection'}
        hasReadySuggestion={selectedHasReadyRelationSuggestion}
        title={selectedHasReadyRelationSuggestion ? '打开连接面板；已有预生成连接建议' : '打开连接面板'}
        compactIconOnly={compactEntryActionLabels}
      />
    </div>
  ) : null;
  const editorOverlayNode = overlayLaunchRequest ? (
    <div className="vocab-editor-layer" role="presentation">
      <button
        type="button"
        className="vocab-editor-backdrop"
        aria-label={`关闭${editorPanelAriaLabel}`}
        onClick={() => setEditorSurface('')}
      />
      <section className={`vocab-editor-panel is-${editorSurface}-surface`} role="dialog" aria-modal="false" aria-label={editorPanelAriaLabel}>
        <div className="vocab-editor-panel-header">
          <div className="vocab-editor-panel-heading">
            <div className="vocab-editor-panel-title">
              {editorSurfaceTitle}
            </div>
            <div className="vocab-editor-panel-caption">
              {sharedLaunchRequest?.word || sharedLaunchRequest?.filename || '当前词条'}
            </div>
          </div>
          <div className="vocab-editor-panel-actions">
            <label className={`vocab-editor-auto-llm-toggle${autoLlmOnOpen ? ' is-active' : ''}`}>
              <input
                type="checkbox"
                checked={autoLlmOnOpen}
                onChange={(event) => handleAutoLlmOnOpenChange(event.target.checked)}
              />
              <span className="vocab-editor-auto-llm-switch" aria-hidden="true">
                <span />
              </span>
              <strong>自动 LLM</strong>
            </label>
            {editorSurface === 'connection' ? (
              <div className="vocab-editor-panel-action-host" ref={handleEditorHeaderActionsHostRef} />
            ) : null}
            <button
              type="button"
              className="vocab-edit-fab vocab-edit-fab-icon vocab-editor-panel-close"
              aria-label={`关闭${editorPanelAriaLabel}`}
              data-tooltip={`关闭${editorPanelAriaLabel}`}
              onClick={() => setEditorSurface('')}
            >
              <UiIcon name="close" size={16} />
            </button>
          </div>
        </div>
        <div className="vocab-editor-panel-body">
          <ReviewWorkspace
            embedded
            overlayMode
            onOpenConfig={onOpenConfig}
            launchRequest={finalOverlayLaunchRequest}
            onSelectionChange={onSelectionChange}
            onVocabularyChange={handleVocabularyEntryChange}
            headerActionsHost={editorSurface === 'connection' ? editorHeaderActionsHost : null}
          />
        </div>
      </section>
    </div>
  ) : null;

  return (
    <div className={`vocab-workspace${compactDesktop ? ' is-compact-desktop' : ''} is-study-mode${overlayLaunchRequest ? ' is-editor-open' : ''}`}>
      <VocabularyQueueDock
        activeQueue={activeQueue}
        nextQueue={nextQueue}
        collapsed={queueDockCollapsed}
        dockPosition={queueDockPosition}
        mobileSheet={queueDockMobileSheet}
        queues={queues}
        cursor={cursor}
        todoIds={todoIds}
        currentEntryActions={currentEntryActions}
        settingsOpen={queueSettingsOpen}
        onActiveQueueChange={setActiveQueue}
        onNextQueueChange={setNextQueue}
        onCollapsedChange={setQueueDockCollapsed}
        onDockPositionChange={setQueueDockPosition}
        onDockPositionReset={resetQueueDockPosition}
        onMobileSheetChange={setQueueDockMobileSheet}
        onSelectEntry={jumpToQueueEntry}
        onNextEntry={handleQueueNextEntry}
        onAddToTodo={addToTodo}
        onRemoveTodo={removeTodo}
        onClearTodo={clearTodo}
        studyMode={studyMode}
        onStudyModeChange={setStudyMode}
        controlsHostRef={handleQueueDockControlsHostRef}
        prefetchLabel={prefetchLabel}
        prefetchTitle={prefetchTitle}
        prefetchDisabled={prefetching || prefetchTargetTotal <= 0}
        onPrefetchVisible={handlePrefetchVisible}
      />

      <div className="vocab-workspace-panels">
        <section className="vocab-workspace-panel is-active">
          <VocabularyReview
            launchRequest={sharedLaunchRequest}
            entryUpdateRequest={reviewEntryUpdate}
            prefetchedRefineRequest={prefetchedRefineUpdate}
            prefetchedRelationRequest={prefetchedRelationUpdate}
            mobileSimple={reviewSurfaceMobileSimple}
            compactDesktop={reviewSurfaceCompactDesktop}
            selectionMode={studyMode}
            onSelectionChange={onSelectionChange}
            onVisibleScopeChange={handleVisibleScopeChange}
            onQueueSnapshotChange={handleQueueSnapshotChange}
            onCurrentEntryActionsChange={handleCurrentEntryActionsChange}
            onQueueSettingsOpenChange={setQueueSettingsOpen}
            queueLimits={queueLimits}
            onQueueLimitsChange={handleQueueLimitsChange}
            queueJumpRequest={queueJumpRequest}
            queueDockControlsActive
            queueDockControlsHost={queueDockControlsHost}
            entryActionsNode={entryActionsNode}
          />
        </section>

        {editorOverlayNode && typeof document !== 'undefined'
          ? createPortal(editorOverlayNode, document.body)
          : editorOverlayNode}
      </div>
    </div>
  );
}
