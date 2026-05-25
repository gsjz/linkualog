import { useMemo, useState } from 'react';

import VocabularyReview from './VocabularyReview.jsx';
import ReviewWorkspace from '../review/App.jsx';
import UiIcon from './UiIcon.jsx';

const normalizeVocabularyLaunchWord = (value) => String(value || '')
  .trim()
  .replace(/\.json$/i, '');

const REVIEW_WORKSPACE_FOCUS_VALUES = new Set(['clean', 'editor', 'organize']);

const normalizeWorkspaceFocus = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'review') return 'organize';
  return REVIEW_WORKSPACE_FOCUS_VALUES.has(normalized) ? normalized : 'clean';
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

const EDITOR_SURFACE_OPTIONS = [
  { key: 'organize', label: '整理', icon: 'wand' },
  { key: 'editor', label: '编辑', icon: 'edit' },
];

const STUDY_MODE_OPTIONS = [
  { key: 'random', label: '随机', icon: 'shuffle' },
  { key: 'manual', label: '手动', icon: 'list' },
];

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

function EditLaunchButton({ disabled, onOpen }) {
  return (
    <button
      type="button"
      className="vocab-mode-switch"
      aria-label="打开编辑面板"
      title="打开编辑面板"
      onClick={onOpen}
      disabled={disabled}
    >
      <span className="vocab-mode-switch-icon">
        <UiIcon name="edit" size={17} />
      </span>
      <span className="vocab-mode-switch-copy">编辑</span>
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
  const [editorLaunchToken, setEditorLaunchToken] = useState(0);
  const [reviewEntryUpdate, setReviewEntryUpdate] = useState(null);
  const reviewSurfaceMobileSimple = mobileSimple;

  const sharedLaunchRequest = useMemo(() => (
    buildReviewLaunchRequest({
      category: currentSelection?.category || launchRequest?.category,
      word: currentSelection?.word || currentSelection?.filename || launchRequest?.fileKey || launchRequest?.word,
      focus: launchRequest?.focus || 'clean',
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
          autoRefineToken: editorLaunchToken,
        }
      : null
  ), [editorLaunchToken, overlayLaunchRequest]);
  const openEditorPanel = () => {
    if (!hasSelection) return;
    setEditorLaunchToken((token) => token + 1);
    setEditorSurface('organize');
  };

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

  return (
    <div className={`vocab-workspace${compactDesktop ? ' is-compact-desktop' : ''} is-study-mode${overlayLaunchRequest ? ' is-editor-open' : ''}`}>
      <div className="vocab-workspace-toolbar">
        <div className="vocab-workspace-heading">
          <div className="vocab-workspace-title">生词本</div>
          <div className="vocab-workspace-caption">
            {studyMode === 'random' ? '随机跳词' : '手动选词'}
          </div>
        </div>
        <div className="vocab-workspace-actions">
          <StudyModeSwitch mode={studyMode} onChange={setStudyMode} />
          <EditLaunchButton disabled={!hasSelection} onOpen={openEditorPanel} />
        </div>
      </div>

      <div className="vocab-workspace-panels">
        <section className="vocab-workspace-panel is-active">
          <VocabularyReview
            launchRequest={sharedLaunchRequest}
            entryUpdateRequest={reviewEntryUpdate}
            mobileSimple={reviewSurfaceMobileSimple}
            compactDesktop={reviewSurfaceCompactDesktop}
            selectionMode={studyMode}
            onSelectionChange={onSelectionChange}
          />
        </section>

        {overlayLaunchRequest ? (
          <div className="vocab-editor-layer" role="presentation">
            <button
              type="button"
              className="vocab-editor-backdrop"
              aria-label="关闭编辑面板"
              onClick={() => setEditorSurface('')}
            />
            <section className={`vocab-editor-panel is-${editorSurface}-surface`} role="dialog" aria-modal="false" aria-label="编辑面板">
              <div className="vocab-editor-panel-header">
                <div className="vocab-editor-panel-heading">
                  <div className="vocab-editor-panel-title">
                    {editorSurface === 'organize' ? '整理建议' : '词条编辑'}
                  </div>
                  <div className="vocab-editor-panel-caption">
                    {sharedLaunchRequest?.word || sharedLaunchRequest?.filename || '当前词条'}
                  </div>
                </div>
                <div className="vocab-editor-panel-actions">
                  <div className="vocab-editor-panel-switch" role="tablist" aria-label="编辑面板视图">
                    {EDITOR_SURFACE_OPTIONS.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        className={`vocab-editor-panel-switch-button${editorSurface === option.key ? ' active' : ''}`}
                        onClick={() => setEditorSurface(option.key)}
                        aria-pressed={editorSurface === option.key}
                        title={option.label}
                      >
                        <UiIcon name={option.icon} size={15} />
                        <span>{option.label}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="vocab-edit-fab vocab-edit-fab-icon"
                    aria-label="关闭编辑面板"
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
