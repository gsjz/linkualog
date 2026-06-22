import { useCallback, useEffect, useMemo, useState } from 'react';

import VocabularyReview from './VocabularyReview.jsx';
import ReviewWorkspace from '../review/App.jsx';
import UiIcon from './UiIcon.jsx';
import {
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

const STUDY_MODE_OPTIONS = [
  { key: 'random', label: '随机', icon: 'shuffle' },
  { key: 'manual', label: '手动', icon: 'list' },
];

const AUTO_LLM_STORAGE_KEY = 'vocabWorkspaceAutoLlmOnOpen';

const getStoredAutoLlmOnOpen = () => (
  localStorage.getItem(AUTO_LLM_STORAGE_KEY) !== '0'
);

const buildAutoLlmLaunchToken = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const sleep = (ms) => new Promise((resolve) => {
  window.setTimeout(resolve, ms);
});

const isTerminalAnalysisJob = (job) => ['success', 'error'].includes(String(job?.status || '').trim());

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

function StudyModeSwitch({ mode, onChange }) {
  return (
    <div className="vocab-study-switch" role="tablist" aria-label="选词模式">
      {STUDY_MODE_OPTIONS.map((option) => (
        <button
          key={option.key}
          type="button"
          className={`vocab-study-chip ${mode === option.key ? 'active' : ''}`}
          onClick={() => onChange(option.key)}
          aria-label={`${option.label}模式`}
        >
          <UiIcon name={option.icon} size={15} />
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function SurfaceLaunchButton({
  surface,
  label,
  icon,
  disabled,
  onOpen,
  active = false,
  hasReadySuggestion = false,
  title = '',
}) {
  return (
    <button
      type="button"
      className={`vocab-mode-switch${active ? ' is-on' : ''}${hasReadySuggestion ? ' has-ready-suggestion' : ''}`}
      aria-label={`打开${label}面板`}
      title={title || `打开${label}面板`}
      onClick={() => onOpen(surface)}
      disabled={disabled}
    >
      {hasReadySuggestion ? <span className="vocab-mode-switch-dot" aria-hidden="true" /> : null}
      <span className="vocab-mode-switch-icon">
        <UiIcon name={icon} size={17} />
      </span>
      <span className="vocab-mode-switch-copy">{label}</span>
    </button>
  );
}

export default function VocabularyWorkspace({
  currentSelection = null,
  launchRequest = null,
  mobileSimple = false,
  compactDesktop = false,
  compactViewport = false,
  onOpenConfig = null,
  onSelectionChange = null,
}) {
  const [studyMode, setStudyMode] = useState('random');
  const [editorSurface, setEditorSurface] = useState('');
  const [autoLlmLaunchToken, setAutoLlmLaunchToken] = useState('');
  const [autoLlmOnOpen, setAutoLlmOnOpen] = useState(getStoredAutoLlmOnOpen);
  const [reviewEntryUpdate, setReviewEntryUpdate] = useState(null);
  const [prefetchedRefineUpdate, setPrefetchedRefineUpdate] = useState(null);
  const [reviewToolbarControlsHost, setReviewToolbarControlsHost] = useState(null);
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
  const reviewSurfaceMobileSimple = mobileSimple;

  const sharedLaunchRequest = useMemo(() => (
    buildReviewLaunchRequest({
      category: currentSelection?.category || launchRequest?.category,
      word: currentSelection?.word || currentSelection?.filename || launchRequest?.fileKey || launchRequest?.word,
      focus: launchRequest?.focus || 'editor',
    })
  ), [currentSelection?.category, currentSelection?.filename, currentSelection?.word, launchRequest?.category, launchRequest?.fileKey, launchRequest?.focus, launchRequest?.word]);

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

  const openWorkspaceSurface = (surface = 'editor') => {
    if (!hasSelection) return;
    setAutoLlmLaunchToken(autoLlmOnOpen ? buildAutoLlmLaunchToken() : '');
    setEditorSurface(surface);
  };
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
  }, []);

  const handleVisibleScopeChange = useCallback((scope) => {
    setVisibleScope(scope || {});
  }, []);

  const handleReviewToolbarControlsHostRef = useCallback((node) => {
    setReviewToolbarControlsHost(node);
  }, []);

  const handlePrefetchVisible = useCallback(async () => {
    if (prefetchingRefine || prefetchingRelations) return;

    const rawEntries = Array.isArray(visibleScope.entries) ? visibleScope.entries : [];
    const targetsByCategory = new Map();
    rawEntries
      .filter((entry) => (
        (entry?.needsProcessing && !entry?.refineCached)
        || !entry?.relationCached
      ))
      .slice(0, 50)
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
          const finalJob = await waitForAnalysisJob(job, (currentJob) => {
            const progress = currentJob?.progress || {};
            const done = Math.min(total, completedBeforeCategory + Number(progress.done || 0));
            setPrefetchProgress({ done, total });
            setRelationPrefetchProgress({
              done,
              total,
            });
          });
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
    }
  }, [markRefineCached, markRelationCached, prefetchingRefine, prefetchingRelations, visibleScope.entries]);

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

    if (typeof onSelectionChange === 'function') {
      onSelectionChange({
        category: normalizedCategory,
        word: savedFilename,
        fileKey: savedFilename,
        filename: nextUpdate.file,
      });
    }

    if (change?.closeEditor !== false) {
      setEditorSurface('');
    }
  };
  const visibleEntries = Array.isArray(visibleScope.entries) ? visibleScope.entries : [];
  const selectedVisibleEntry = visibleScope.selectedEntry || null;
  const prefetchTargetCount = visibleEntries.filter((entry) => entry?.needsProcessing && !entry?.refineCached).length;
  const relationPrefetchTargetCount = visibleEntries.filter((entry) => !entry?.relationCached).length;
  const selectedHasReadySuggestion = Boolean(selectedVisibleEntry?.refineCached);
  const selectedHasReadyRelationSuggestion = Boolean(selectedVisibleEntry?.relationCached);
  const prefetching = prefetchingRefine || prefetchingRelations;
  const prefetchTargetTotal = prefetchTargetCount + relationPrefetchTargetCount;
  const prefetchLabel = prefetchingRefine
    ? `整理 ${prefetchProgress.done}/${prefetchProgress.total}`
    : prefetchingRelations
    ? `连边 ${relationPrefetchProgress.done}/${relationPrefetchProgress.total}`
    : '预生成';
  const prefetchTitleTargets = [
    prefetchTargetCount ? `整理 ${Math.min(prefetchTargetCount, 50)}` : '',
    relationPrefetchTargetCount ? `连接 ${Math.min(relationPrefetchTargetCount, 50)}` : '',
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

  return (
    <div className={`vocab-workspace${compactDesktop ? ' is-compact-desktop' : ''} is-study-mode${overlayLaunchRequest ? ' is-editor-open' : ''}`}>
      <div className="vocab-workspace-toolbar">
        <div className="vocab-workspace-review-tools-host" ref={handleReviewToolbarControlsHostRef} />
        <div className="vocab-workspace-actions">
          <StudyModeSwitch mode={studyMode} onChange={setStudyMode} />
          <button
            type="button"
            className="vocab-mode-switch vocab-prefetch-switch"
            aria-label="预生成当前范围内的整理和连接建议"
            title={prefetchTitle}
            onClick={() => void handlePrefetchVisible()}
            disabled={prefetching || prefetchTargetTotal <= 0}
          >
            <span className="vocab-mode-switch-icon">
              <UiIcon name="wand" size={17} />
            </span>
            <span className="vocab-mode-switch-copy">{prefetchLabel}</span>
          </button>
          <SurfaceLaunchButton
            surface="editor"
            label="编辑"
            icon="edit"
            disabled={!hasSelection}
            onOpen={openWorkspaceSurface}
            active={editorSurface === 'editor'}
            hasReadySuggestion={selectedHasReadySuggestion}
            title={selectedHasReadySuggestion ? '打开手动整理；已有预生成整理建议' : '打开手动整理'}
          />
          <SurfaceLaunchButton
            surface="connection"
            label="连接"
            icon="external-link"
            disabled={!hasSelection}
            onOpen={openWorkspaceSurface}
            active={editorSurface === 'connection'}
            hasReadySuggestion={selectedHasReadyRelationSuggestion}
            title={selectedHasReadyRelationSuggestion ? '打开连接面板；已有预生成连接建议' : '打开连接面板'}
          />
        </div>
      </div>

      <div className="vocab-workspace-panels">
        <section className="vocab-workspace-panel is-active">
          <VocabularyReview
            launchRequest={sharedLaunchRequest}
            entryUpdateRequest={reviewEntryUpdate}
            prefetchedRefineRequest={prefetchedRefineUpdate}
            mobileSimple={reviewSurfaceMobileSimple}
            compactDesktop={reviewSurfaceCompactDesktop}
            compactViewport={compactViewport}
            selectionMode={studyMode}
            onSelectionChange={onSelectionChange}
            onVisibleScopeChange={handleVisibleScopeChange}
            workspaceToolbarControlsHost={reviewToolbarControlsHost}
          />
        </section>

        {overlayLaunchRequest ? (
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
                  <button
                    type="button"
                    className="vocab-edit-fab vocab-edit-fab-icon"
                    aria-label={`关闭${editorPanelAriaLabel}`}
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
                />
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
