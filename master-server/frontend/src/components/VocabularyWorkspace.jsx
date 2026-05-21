import { useMemo } from 'react';

import VocabularyReview from './VocabularyReview.jsx';
import ReviewWorkspace from '../review/App.jsx';

const normalizeVocabularyLaunchWord = (value) => String(value || '')
  .trim()
  .replace(/\.json$/i, '');

const buildReviewLaunchRequest = ({ category = '', word = '', focus = 'clean' } = {}) => {
  const normalizedWord = normalizeVocabularyLaunchWord(word);
  if (!normalizedWord) return null;

  return {
    category: String(category || '').trim(),
    filename: normalizedWord.endsWith('.json') ? normalizedWord : `${normalizedWord}.json`,
    word: normalizedWord,
    fileKey: normalizedWord,
    focus: focus === 'review' ? 'review' : 'clean',
  };
};

function EditModeSwitch({ enabled, onChange }) {
  return (
    <button
      type="button"
      className="vocab-mode-switch"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? '关闭编辑模式' : '开启编辑模式'}
      onClick={() => onChange(!enabled)}
    >
      <span className="vocab-mode-switch-copy">
        <span className="vocab-mode-switch-label">编辑模式</span>
        <span className="vocab-mode-switch-state">{enabled ? '开' : '关'}</span>
      </span>
      <span className={`vocab-mode-switch-track${enabled ? ' is-on' : ''}`}>
        <span className="vocab-mode-switch-thumb" />
      </span>
    </button>
  );
}

export default function VocabularyWorkspace({
  editMode = false,
  currentSelection = null,
  launchRequest = null,
  mobileSimple = false,
  compactDesktop = false,
  onOpenConfig = null,
  onEditModeChange = null,
  onSelectionChange = null,
}) {
  const handleOpenEditor = (request) => {
    const nextLaunchRequest = buildReviewLaunchRequest(request);
    if (nextLaunchRequest && typeof onSelectionChange === 'function') {
      onSelectionChange({
        category: nextLaunchRequest.category,
        word: nextLaunchRequest.filename,
      });
    }
    if (typeof onEditModeChange === 'function') {
      onEditModeChange(true);
    }
  };

  const handleModeChange = (nextEnabled) => {
    if (typeof onEditModeChange === 'function') {
      onEditModeChange(nextEnabled);
    }
  };

  const sharedLaunchRequest = useMemo(() => (
    buildReviewLaunchRequest({
      category: currentSelection?.category || launchRequest?.category,
      word: currentSelection?.word || currentSelection?.filename || launchRequest?.fileKey || launchRequest?.word,
      focus: launchRequest?.focus || 'clean',
    })
  ), [currentSelection?.category, currentSelection?.filename, currentSelection?.word, launchRequest?.category, launchRequest?.fileKey, launchRequest?.focus, launchRequest?.word]);

  return (
    <div className={`vocab-workspace${compactDesktop ? ' is-compact-desktop' : ''}${editMode ? ' is-edit-mode' : ' is-study-mode'}`}>
      <div className="vocab-workspace-toolbar">
        <div className="vocab-workspace-heading">
          <div className="vocab-workspace-title">生词本</div>
          <div className="vocab-workspace-caption">{editMode ? '精修与复习' : '刷题'}</div>
        </div>
        <EditModeSwitch enabled={editMode} onChange={handleModeChange} />
      </div>

      <div className="vocab-workspace-panels">
        <section className={`vocab-workspace-panel${editMode ? '' : ' is-active'}`} aria-hidden={editMode}>
          <VocabularyReview
            onOpenReviewEntry={handleOpenEditor}
            launchRequest={sharedLaunchRequest}
            mobileSimple={mobileSimple}
            compactDesktop={compactDesktop}
            onSelectionChange={onSelectionChange}
          />
        </section>

        <section className={`vocab-workspace-panel${editMode ? ' is-active' : ''}`} aria-hidden={!editMode}>
          <ReviewWorkspace
            embedded
            onOpenConfig={onOpenConfig}
            launchRequest={sharedLaunchRequest}
            onSelectionChange={onSelectionChange}
          />
        </section>
      </div>
    </div>
  );
}
