import { useEffect, useRef, useState } from 'react';

import UiIcon from './UiIcon.jsx';
import { QUEUE_LABELS } from '../hooks/useVocabularyQueues.js';

const SCORE_SHORT_LABELS = {
  0: '忘了',
  1: '吃力',
  2: '想起',
  3: '记住',
  4: '牢固',
  5: '熟练',
};

const SCORE_EMOJIS = {
  0: '😵',
  1: '😣',
  2: '😵‍💫',
  3: '🤔',
  4: '🤓',
  5: '😋',
};

const TABS = [
  { key: 'random', icon: 'shuffle', label: '随机' },
  { key: 'manual', icon: 'list', label: '顺序' },
  { key: 'todo', icon: 'check', label: 'todo' },
  { key: 'preprocess', icon: 'wand', label: 'init' },
];

const NAV_QUEUES = new Set(['random', 'manual', 'todo']);
const MOBILE_QUERY = '(max-width: 1180px)';
const SCORE_AUTO_NEXT_STORAGE_KEY = 'linkualog:vocab-queue-score-auto-next';

const statusLabel = (item) => {
  const explicit = String(item?.stageLabel || item?.statusLabel || '').trim();
  if (explicit) return explicit;
  const status = String(item?.status || '').trim();
  if (status === 'queued') return '等待';
  if (status === 'running') return '进行中';
  if (status === 'locked') return '锁定';
  if (status === 'success' || status === 'done') return '完成';
  if (status === 'error') return '失败';
  return status || '就绪';
};

const useIsMobileQueueDock = () => {
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches
  ));

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const media = window.matchMedia(MOBILE_QUERY);
    const handleChange = () => setIsMobile(media.matches);
    handleChange();
    media.addEventListener?.('change', handleChange);
    return () => media.removeEventListener?.('change', handleChange);
  }, []);

  return isMobile;
};

const latestReviewLabel = (actions) => {
  if (actions?.loadingDetail) return '正在切换词条';
  const score = actions?.latestScore;
  if (score === 0 || score) return `最近 ${score}/5`;
  return actions?.hasDetail ? '记录今天熟练度' : '尚未选择词条';
};

const latestReviewEmoji = (actions) => {
  if (actions?.loadingDetail) return '⏳';
  const score = actions?.latestScore;
  if (score === 0 || score) return SCORE_EMOJIS[score] || '📊';
  return actions?.hasDetail ? '📝' : '▫️';
};

const normalizeFile = (value) => {
  const file = String(value || '').trim();
  if (!file) return '';
  return file.endsWith('.json') ? file : `${file}.json`;
};

const buildQueueEntryId = (category, file) => {
  const normalizedCategory = String(category || '').trim();
  const normalizedFile = normalizeFile(file);
  return normalizedCategory && normalizedFile ? `${normalizedCategory}/${normalizedFile}` : '';
};

const escapeSelectorValue = (value) => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value || '').replace(/["\\]/g, '\\$&');
};

export default function VocabularyQueueDock({
  activeQueue,
  nextQueue,
  collapsed,
  mobileSheet,
  queues,
  cursor,
  todoIds,
  currentEntryActions,
  settingsOpen = false,
  onActiveQueueChange,
  onNextQueueChange,
  onCollapsedChange,
  onMobileSheetChange,
  onSelectEntry,
  onNextEntry,
  onAddToTodo,
  onRemoveTodo,
  onClearTodo,
  studyMode = 'random',
  onStudyModeChange,
  controlsHostRef,
  prefetchLabel = '预生成',
  prefetchTitle = '预生成当前范围内的整理和连接建议',
  prefetchDisabled = false,
  onPrefetchVisible,
}) {
  const dockRef = useRef(null);
  const [scoreAutoNext, setScoreAutoNext] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(SCORE_AUTO_NEXT_STORAGE_KEY) !== 'false';
  });
  const isMobile = useIsMobileQueueDock();
  const currentQueue = Array.isArray(queues?.[activeQueue]) ? queues[activeQueue] : [];
  const canNavigate = NAV_QUEUES.has(nextQueue) && Array.isArray(queues?.[nextQueue]) && queues[nextQueue].length > 0;
  const canAddVisible = activeQueue !== 'todo' && currentQueue.length > 0;
  const prefetchBlockedByPreprocessQueue = activeQueue === 'preprocess';
  const currentCursor = Number(cursor?.[activeQueue] || 0);
  const actions = currentEntryActions || {};
  const hasCurrentEntry = Boolean(actions?.hasDetail);
  const entryBusy = Boolean(actions?.loadingDetail);
  const currentEntryId = buildQueueEntryId(actions.category, actions.file);
  const currentEntrySource = NAV_QUEUES.has(actions.queueSource) || actions.queueSource === 'preprocess'
    ? actions.queueSource
    : '';
  const activeQueueHasCurrentEntry = Boolean(
    currentEntryId
    && currentEntrySource === activeQueue
    && currentQueue.some((item) => item.id === currentEntryId),
  );
  const latestScore = actions?.latestScore;
  const scoreStatusLabel = actions.savingScore ? '保存中' : latestReviewLabel(actions);
  const scoreStatusEmoji = actions.savingScore ? '⏳' : latestReviewEmoji(actions);
  const resolvedMobileSheet = mobileSheet === 'expanded' ? 'expanded' : 'compact';
  const mobileExpanded = isMobile && resolvedMobileSheet === 'expanded';

  useEffect(() => {
    if (collapsed) onCollapsedChange?.(false);
  }, [collapsed, onCollapsedChange]);

  useEffect(() => {
    if ((isMobile && !mobileExpanded) || !activeQueueHasCurrentEntry || !currentEntryId) return;
    const node = dockRef.current;
    const itemNode = node?.querySelector?.(`[data-queue-entry-id="${escapeSelectorValue(currentEntryId)}"]`);
    itemNode?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeQueue, activeQueueHasCurrentEntry, currentEntryId, currentQueue.length, isMobile, mobileExpanded]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SCORE_AUTO_NEXT_STORAGE_KEY, scoreAutoNext ? 'true' : 'false');
  }, [scoreAutoNext]);

  const toggleMobileSheet = () => {
    if (!isMobile) return;
    onMobileSheetChange?.(resolvedMobileSheet === 'expanded' ? 'compact' : 'expanded');
  };

  const closeMobileSheet = () => {
    if (!isMobile) return;
    onMobileSheetChange?.('compact');
  };

  const handleSelectQueueEntry = (item) => {
    onSelectEntry?.(item);
    closeMobileSheet();
  };

  const handleScoreClick = async (score) => {
    if (!hasCurrentEntry || entryBusy || actions.savingScore) return;
    if (typeof actions.onSubmitScore !== 'function') return;
    const saved = await Promise.resolve(actions.onSubmitScore?.(score, { autoAdvance: false }));
    if (saved === false) return;
    if (scoreAutoNext && canNavigate) {
      onNextEntry?.();
    }
  };

  const dockClassName = [
    'vocab-queue-dock',
    isMobile ? 'is-mobile-sheet' : 'is-desktop-fixed',
    isMobile ? `is-${resolvedMobileSheet}` : '',
    settingsOpen ? 'has-expanded-settings' : '',
  ].filter(Boolean).join(' ');

  return (
    <>
      {mobileExpanded ? (
        <button
          type="button"
          className="vocab-queue-sheet-backdrop"
          aria-label="关闭队列详情"
          onClick={closeMobileSheet}
        />
      ) : null}
      <aside
        ref={dockRef}
        className={dockClassName}
        aria-label="词条队列"
        aria-expanded={isMobile ? mobileExpanded : undefined}
      >
        <div className="vocab-queue-dock-head">
          {isMobile ? (
            <button
              type="button"
              className="vocab-queue-sheet-toggle"
              onClick={toggleMobileSheet}
              aria-label={mobileExpanded ? '收起队列详情' : '展开队列详情'}
              data-tooltip={mobileExpanded ? '收起队列详情' : '展开队列详情'}
            >
              <UiIcon name={mobileExpanded ? 'chevron-down' : 'list'} size={15} />
            </button>
          ) : null}
          <div
            className="vocab-queue-title"
            onClick={isMobile ? toggleMobileSheet : undefined}
            onKeyDown={(event) => {
              if (!isMobile || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              toggleMobileSheet();
            }}
            role={isMobile ? 'button' : undefined}
            tabIndex={isMobile ? 0 : undefined}
          >
            <strong>队列</strong>
            <span>来源: {QUEUE_LABELS[nextQueue] || '未设置'}</span>
          </div>
        </div>

        <>
          <div className="vocab-queue-current">
            <div className="vocab-queue-current-head">
              <div className="vocab-queue-current-title">
                <strong>{actions.word || actions.file || '当前词条'}</strong>
                <span>{hasCurrentEntry || entryBusy ? `${actions.categoryLabel || actions.category || '目录'} / ${actions.file || ''}` : '选择词条后可在这里处理'}</span>
              </div>
              <div className="vocab-queue-current-meta">
                <div
                  className="vocab-queue-current-status"
                  aria-label={scoreStatusLabel}
                  data-tooltip={scoreStatusLabel}
                >
                  <span>最近</span>
                  <strong aria-hidden="true">{scoreStatusEmoji}</strong>
                </div>
                <label
                  className="vocab-queue-auto-next-toggle"
                  aria-label="打分后下一个"
                  data-tooltip="打分保存成功后跳到下一个词条"
                >
                  <input
                    type="checkbox"
                    checked={scoreAutoNext}
                    onChange={(event) => setScoreAutoNext(event.target.checked)}
                  />
                  <span className="vocab-queue-auto-next-switch" aria-hidden="true">
                    <span />
                  </span>
                  <span>打分后下一个</span>
                </label>
              </div>
            </div>
            <div className="vocab-queue-score-grid" role="group" aria-label="本次打分">
              {[0, 1, 2, 3, 4, 5].map((score) => (
                <button
                  key={score}
                  type="button"
                  className={`vocab-queue-score-button${latestScore === score ? ' is-latest' : ''}`}
                  onClick={() => { void handleScoreClick(score); }}
                  disabled={!hasCurrentEntry || entryBusy || actions.savingScore}
                  aria-label={`${score}: ${SCORE_SHORT_LABELS[score]}`}
                  data-tooltip={`${score}: ${SCORE_SHORT_LABELS[score]}`}
                >
                  <strong className="vocab-queue-score-emoji" aria-hidden="true">{SCORE_EMOJIS[score]}</strong>
                </button>
              ))}
            </div>
            <div className="vocab-queue-current-actions">
              <button
                type="button"
                className={`vocab-queue-current-action${actions.marked ? ' is-active' : ''}`}
                onClick={() => actions.onToggleMarked?.()}
                disabled={!hasCurrentEntry || entryBusy || actions.savingMarked}
                aria-label={actions.marked ? '已标记' : '标记'}
                data-tooltip={actions.marked ? '已标记' : '标记'}
              >
                <UiIcon name="star" size={14} />
                <span>{actions.savingMarked ? '保存中' : (actions.marked ? '已标记' : '标记')}</span>
              </button>
              <button
                type="button"
                className="vocab-queue-current-action is-danger"
                onClick={() => actions.onDelete?.()}
                disabled={!hasCurrentEntry || entryBusy || actions.savingMarked}
                aria-label="删除"
                data-tooltip="删除"
              >
                <UiIcon name="trash" size={14} />
                <span>删除</span>
              </button>
              <button
                type="button"
                className="vocab-queue-current-action is-primary"
                onClick={onNextEntry}
                disabled={!canNavigate}
                aria-label="下一个"
                data-tooltip="下一个"
              >
                <UiIcon name="shuffle" size={14} />
                <span>下一个</span>
              </button>
              {isMobile && !mobileExpanded ? (
                <button
                  type="button"
                  className="vocab-queue-current-action vocab-queue-mobile-sheet-toggle"
                  onClick={toggleMobileSheet}
                  aria-label="展开队列详情"
                  data-tooltip="展开队列详情"
                >
                  <UiIcon name="list" size={14} />
                </button>
              ) : null}
            </div>
          </div>

          <div className="vocab-queue-control-panel" aria-label="词池筛选和队列操作">
            <div className="vocab-queue-controls-host" ref={controlsHostRef} />
          </div>

          <div className="vocab-queue-tab-action-row">
            <div className="vocab-queue-tabs" role="tablist" aria-label="队列类型">
              {TABS.map((tab) => {
                const count = Array.isArray(queues?.[tab.key]) ? queues[tab.key].length : 0;
                const active = activeQueue === tab.key;
                const currentSource = currentEntrySource === tab.key;
                const tabTitle = `${tab.label}队列 · ${count}`;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    className={`vocab-queue-tab${active ? ' is-active' : ''}${studyMode === tab.key ? ' is-study-mode' : ''}${currentSource ? ' is-current-source' : ''}`}
                    onClick={() => {
                      onActiveQueueChange(tab.key);
                    }}
                    role="tab"
                    aria-selected={active}
                    aria-label={tabTitle}
                    data-tooltip={tabTitle}
                  >
                    <UiIcon name={tab.icon} size={14} />
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="vocab-queue-control-button vocab-queue-prefetch-button"
              aria-label={prefetchBlockedByPreprocessQueue ? 'init 队列只展示预处理状态' : '预生成当前范围内的整理和连接建议'}
              data-tooltip={prefetchBlockedByPreprocessQueue ? 'init 队列只展示预处理状态，切回随机/顺序/todo 后再预生成' : prefetchTitle}
              onClick={() => {
                if (prefetchBlockedByPreprocessQueue) return;
                onPrefetchVisible?.();
              }}
              disabled={prefetchDisabled || prefetchBlockedByPreprocessQueue}
            >
              <UiIcon name="wand" size={14} />
              <span>{prefetchLabel}</span>
            </button>
          </div>

          <div className="vocab-queue-actions">
            {NAV_QUEUES.has(activeQueue) ? (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  onNextQueueChange(activeQueue);
                  if (activeQueue === 'random' || activeQueue === 'manual') {
                    onStudyModeChange?.(activeQueue);
                  }
                }}
                disabled={nextQueue === activeQueue}
              >
                设为下一个来源
              </button>
            ) : (
              <span className="vocab-queue-hint">预处理队列只展示状态</span>
            )}
            {canAddVisible ? (
              <button type="button" className="ghost" onClick={() => onAddToTodo(currentQueue)}>
                加入处理队列
              </button>
            ) : null}
            {activeQueue === 'todo' && currentQueue.length ? (
              <button type="button" className="ghost" onClick={onClearTodo}>
                清空
              </button>
            ) : null}
          </div>

          <div className="vocab-queue-list" role="list">
            {currentQueue.length ? currentQueue.map((item, index) => {
              const activeCursor = activeQueue !== 'preprocess' && index === currentCursor;
              const currentEntry = activeQueueHasCurrentEntry && item.id === currentEntryId;
              const inTodo = todoIds?.has?.(item.id);
              return (
                <div
                  key={`${activeQueue}-${item.id}-${item.addedAt || ''}`}
                  className={`vocab-queue-item is-${item.status || 'ready'}${activeCursor ? ' is-cursor' : ''}${currentEntry ? ' is-current-entry' : ''}`}
                  role="listitem"
                  data-queue-entry-id={item.id}
                >
                  <button
                    type="button"
                    className="vocab-queue-item-main"
                    onClick={() => handleSelectQueueEntry(item)}
                    data-tooltip={`${item.category} / ${item.file}`}
                  >
                    <span className="vocab-queue-word">{item.word || item.file}</span>
                    <span className="vocab-queue-meta">
                      {item.category} / {item.file}
                    </span>
                    <span className="vocab-queue-status">{statusLabel(item)}</span>
                  </button>
                  {activeQueue === 'todo' ? (
                    <button
                      type="button"
                      className="vocab-queue-icon-button"
                      onClick={() => onRemoveTodo(item.id)}
                      aria-label="从处理队列移除"
                      data-tooltip="移除"
                    >
                      <UiIcon name="trash" size={14} />
                    </button>
                  ) : activeQueue !== 'todo' ? (
                    <button
                      type="button"
                      className="vocab-queue-icon-button"
                      onClick={() => onAddToTodo([item])}
                      disabled={inTodo}
                      aria-label={inTodo ? '已在处理队列' : '加入处理队列'}
                      data-tooltip={inTodo ? '已在处理队列' : '加入处理队列'}
                    >
                      <UiIcon name={inTodo ? 'check' : 'plus'} size={14} />
                    </button>
                  ) : null}
                </div>
              );
            }) : (
              <div className="vocab-queue-empty">当前队列为空</div>
            )}
          </div>
        </>
      </aside>
    </>
  );
}
