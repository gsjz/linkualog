import { useEffect, useMemo, useRef, useState } from 'react';

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
const MOBILE_QUERY = '(max-width: 760px)';
const DEFAULT_DESKTOP_OFFSET = 18;
const DOCK_MARGIN = 8;
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

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const clampDockPosition = (position, rect) => {
  if (typeof window === 'undefined' || !rect) return position;
  const maxX = Math.max(DOCK_MARGIN, window.innerWidth - rect.width - DOCK_MARGIN);
  const maxY = Math.max(DOCK_MARGIN, window.innerHeight - rect.height - DOCK_MARGIN);
  return {
    x: clamp(Number(position?.x || 0), DOCK_MARGIN, maxX),
    y: clamp(Number(position?.y || 0), DOCK_MARGIN, maxY),
  };
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
  const score = actions?.latestScore;
  if (score === 0 || score) return `最近 ${score}/5`;
  return actions?.hasDetail ? '记录今天熟练度' : '尚未选择词条';
};

const latestReviewEmoji = (actions) => {
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
  dockPosition,
  mobileSheet,
  queues,
  cursor,
  todoIds,
  currentEntryActions,
  onActiveQueueChange,
  onNextQueueChange,
  onCollapsedChange,
  onDockPositionChange,
  onDockPositionReset,
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
  const dragStateRef = useRef(null);
  const [dragPosition, setDragPosition] = useState(null);
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
  const activePosition = dragPosition || dockPosition || null;
  const dockStyle = useMemo(() => {
    if (isMobile || !activePosition) return undefined;
    return {
      left: `${activePosition.x}px`,
      top: `${activePosition.y}px`,
      right: 'auto',
      bottom: 'auto',
    };
  }, [activePosition, isMobile]);

  useEffect(() => {
    if (isMobile || collapsed) return undefined;
    const handleResize = () => {
      const node = dockRef.current;
      if (!node || !dockPosition) return;
      const nextPosition = clampDockPosition(dockPosition, node.getBoundingClientRect());
      if (nextPosition.x !== dockPosition.x || nextPosition.y !== dockPosition.y) {
        onDockPositionChange?.(nextPosition);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [collapsed, dockPosition, isMobile, onDockPositionChange]);

  useEffect(() => {
    if (collapsed || !activeQueueHasCurrentEntry || !currentEntryId) return;
    const node = dockRef.current;
    const itemNode = node?.querySelector?.(`[data-queue-entry-id="${escapeSelectorValue(currentEntryId)}"]`);
    itemNode?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeQueue, activeQueueHasCurrentEntry, collapsed, currentEntryId, currentQueue.length]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SCORE_AUTO_NEXT_STORAGE_KEY, scoreAutoNext ? 'true' : 'false');
  }, [scoreAutoNext]);

  const handlePointerDown = (event) => {
    if (isMobile || event.button !== 0) return;
    const target = event.target;
    const dragHandle = target?.closest?.('.vocab-queue-drag-handle');
    if (!dragHandle && target?.closest?.('button, a, input, select, textarea')) return;
    const node = dockRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const startPosition = activePosition || {
      x: window.innerWidth - rect.width - DEFAULT_DESKTOP_OFFSET,
      y: window.innerHeight - rect.height - DEFAULT_DESKTOP_OFFSET,
    };
    const clamped = clampDockPosition(startPosition, rect);
    dragStateRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - clamped.x,
      offsetY: event.clientY - clamped.y,
      rect,
    };
    setDragPosition(clamped);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    setDragPosition(clampDockPosition({
      x: event.clientX - dragState.offsetX,
      y: event.clientY - dragState.offsetY,
    }, dragState.rect));
  };

  const finishDrag = (event) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const finalPosition = clampDockPosition({
      x: event.clientX - dragState.offsetX,
      y: event.clientY - dragState.offsetY,
    }, dragState.rect);
    dragStateRef.current = null;
    setDragPosition(null);
    onDockPositionChange?.(finalPosition);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const toggleCollapsed = () => {
    onCollapsedChange(!collapsed);
  };

  const toggleMobileSheet = () => {
    if (!isMobile || collapsed) return;
    onMobileSheetChange?.(resolvedMobileSheet === 'expanded' ? 'compact' : 'expanded');
  };

  const handleScoreClick = async (score) => {
    if (!hasCurrentEntry || actions.savingScore) return;
    if (typeof actions.onSubmitScore !== 'function') return;
    const saved = await Promise.resolve(actions.onSubmitScore?.(score, { autoAdvance: false }));
    if (saved === false) return;
    if (scoreAutoNext && canNavigate) {
      onNextEntry?.();
    }
  };

  const dockClassName = [
    'vocab-queue-dock',
    collapsed ? 'is-collapsed' : '',
    isMobile ? 'is-mobile-sheet' : 'is-desktop-float',
    isMobile && !collapsed ? `is-${resolvedMobileSheet}` : '',
    dragPosition ? 'is-dragging' : '',
  ].filter(Boolean).join(' ');

  return (
    <aside ref={dockRef} className={dockClassName} style={dockStyle} aria-label="词条队列">
      <div
        className="vocab-queue-dock-head"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onDoubleClick={() => {
          if (!isMobile) onDockPositionReset?.();
        }}
      >
        <button
          type="button"
          className="vocab-queue-collapse"
          onClick={toggleCollapsed}
          aria-label={collapsed ? '展开队列' : '收起队列'}
          title={collapsed ? '展开队列' : '收起队列'}
        >
          <UiIcon name={collapsed ? 'list' : 'close'} size={15} />
        </button>
        {!collapsed ? (
          <>
            <button
              type="button"
              className="vocab-queue-drag-handle"
              onClick={toggleMobileSheet}
              aria-label={isMobile ? '切换队列高度' : '拖动队列窗口'}
              title={isMobile ? '切换队列高度' : '拖动队列窗口；双击标题重置位置'}
            >
              <UiIcon name="drag" size={14} />
            </button>
            <div
              className="vocab-queue-title"
              onClick={toggleMobileSheet}
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
          </>
        ) : null}
      </div>

      {!collapsed ? (
        <>
          <div className="vocab-queue-current">
            <div className="vocab-queue-current-head">
              <div className="vocab-queue-current-title">
                <strong>{actions.word || actions.file || '当前词条'}</strong>
                <span>{hasCurrentEntry ? `${actions.categoryLabel || actions.category || '目录'} / ${actions.file || ''}` : '选择词条后可在这里处理'}</span>
              </div>
              <div className="vocab-queue-current-meta">
                <div
                  className="vocab-queue-current-status"
                  aria-label={scoreStatusLabel}
                  title={scoreStatusLabel}
                >
                  <span>最近</span>
                  <strong aria-hidden="true">{scoreStatusEmoji}</strong>
                </div>
                <label
                  className="vocab-queue-auto-next-toggle"
                  aria-label="打分后下一个"
                  title="打分保存成功后跳到下一个词条"
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
                  disabled={!hasCurrentEntry || actions.savingScore}
                  aria-label={`${score}: ${SCORE_SHORT_LABELS[score]}`}
                  title={`${score}: ${SCORE_SHORT_LABELS[score]}`}
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
                disabled={!hasCurrentEntry || actions.savingMarked}
                aria-label={actions.marked ? '已标记' : '标记'}
                title={actions.marked ? '已标记' : '标记'}
              >
                <UiIcon name="star" size={14} />
                <span>{actions.savingMarked ? '保存中' : (actions.marked ? '已标记' : '标记')}</span>
              </button>
              <button
                type="button"
                className="vocab-queue-current-action is-danger"
                onClick={() => actions.onDelete?.()}
                disabled={!hasCurrentEntry || actions.savingMarked}
                aria-label="删除"
                title="删除"
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
                title="下一个"
              >
                <UiIcon name="shuffle" size={14} />
                <span>下一个</span>
              </button>
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
                    title={tabTitle}
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
              title={prefetchBlockedByPreprocessQueue ? 'init 队列只展示预处理状态，切回随机/顺序/todo 后再预生成' : prefetchTitle}
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
                    onClick={() => onSelectEntry(item)}
                    title={`${item.category} / ${item.file}`}
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
                      title="移除"
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
                      title={inTodo ? '已在处理队列' : '加入处理队列'}
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
      ) : null}
    </aside>
  );
}
