import React, { useEffect, useRef, useState } from 'react';
import {
  uploadResource,
  getTaskStatus,
  resumeTask,
  getAllTasks,
  deleteTask,
  getImageUrl,
  regenerateTaskPage,
  renameTask,
  updateTaskPageParsedResult,
} from '../api/client';

const dispatchVocabTask = (word, context, taskName, fetchLlm, focusPositions = []) => {
  window.dispatchEvent(new CustomEvent('add-vocab-task', {
    detail: { word, context, source: taskName, fetchLlm, focusPositions }
  }));
};

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

const cloneMark = (mark) => ({
  ...mark,
  bbox: mark?.bbox ? { ...mark.bbox } : null,
});

const stripEdgePunctuation = (token) => String(token || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

const tokenizeContext = (text) => String(text || '')
  .trim()
  .split(/\s+/)
  .map((token) => stripEdgePunctuation(token))
  .filter(Boolean);

const buildWordFromFocusPositions = (tokens, focusPositions) => focusPositions.map((i) => tokens[i]).filter(Boolean).join(' ');

function getExplicitFocusPositions(mark, tokenCount) {
  if (!Number.isInteger(tokenCount) || tokenCount <= 0) return [];

  const focusList = Array.isArray(mark.focusPositions)
    ? mark.focusPositions
    : Array.isArray(mark.fp)
      ? mark.fp
      : Array.isArray(mark.fps)
        ? mark.fps
      : [];
  return [...new Set(focusList
    .map((idx) => parseInt(idx, 10))
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < tokenCount))]
    .sort((a, b) => a - b);
}

function getSerializableFocusPositions(mark) {
  const tokenCount = tokenizeContext(mark.context).length;
  return getExplicitFocusPositions(mark, tokenCount);
}

const sanitizeMarkForContent = (mark) => {
  const focusPositions = getSerializableFocusPositions(mark);
  return {
    word: mark.word || '',
    context: mark.context || '',
    bbox: mark.bbox ? { ...mark.bbox } : null,
    ...(focusPositions.length > 0 ? { focusPositions } : {}),
  };
};

const toShortMark = (mark) => {
  const focusPositions = getSerializableFocusPositions(mark);
  return {
    w: mark.word || '',
    c: mark.context || '',
    b: mark.bbox
      ? {
        l: mark.bbox.left,
        t: mark.bbox.top,
        w: mark.bbox.width,
        h: mark.bbox.height,
      }
      : null,
    ...(focusPositions.length > 0 ? { fp: focusPositions, fps: focusPositions } : {}),
  };
};

const findPhraseStart = (tokens, phraseTokens) => {
  if (!tokens.length || !phraseTokens.length || phraseTokens.length > tokens.length) return -1;
  const loweredTokens = tokens.map((token) => token.toLowerCase());
  const loweredPhrase = phraseTokens.map((token) => token.toLowerCase());
  for (let i = 0; i <= loweredTokens.length - loweredPhrase.length; i += 1) {
    let matches = true;
    for (let j = 0; j < loweredPhrase.length; j += 1) {
      if (loweredTokens[i + j] !== loweredPhrase[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }
  return -1;
};

const normalizeRangeForMark = (mark) => {
  const tokens = tokenizeContext(mark.context);
  if (!tokens.length) return { tokens, start: 0, end: 0 };

  if (Number.isInteger(mark.local_start) && Number.isInteger(mark.local_end)) {
    const start = clampNumber(mark.local_start, 0, tokens.length - 1);
    const end = clampNumber(mark.local_end, start, tokens.length - 1);
    return { tokens, start, end };
  }

  const phraseTokens = tokenizeContext(mark.word);
  const foundStart = findPhraseStart(tokens, phraseTokens);
  const start = foundStart >= 0 ? foundStart : 0;
  const fallbackLength = phraseTokens.length > 0 ? phraseTokens.length : 1;
  const end = clampNumber(start + fallbackLength - 1, start, tokens.length - 1);
  return { tokens, start, end };
};

const toggleFocusTokenSelection = (mark, tokenIndex) => {
  const { tokens } = normalizeRangeForMark(mark);
  if (!tokens.length) return mark;
  const safeIndex = clampNumber(tokenIndex, 0, tokens.length - 1);
  const currentFocus = getExplicitFocusPositions(mark, tokens.length);
  const exists = currentFocus.includes(safeIndex);
  let nextFocus = exists
    ? currentFocus.filter((idx) => idx !== safeIndex)
    : [...currentFocus, safeIndex];
  nextFocus = [...new Set(nextFocus)].sort((a, b) => a - b);

  if (!nextFocus.length) {
    const fallbackWord = mark.source_word || mark.word || '';
    const nextMark = {
      ...mark,
      word: fallbackWord,
    };
    delete nextMark.focusPositions;
    delete nextMark.local_start;
    delete nextMark.local_end;
    return nextMark;
  }

  return {
    ...mark,
    word: buildWordFromFocusPositions(tokens, nextFocus),
    focusPositions: nextFocus,
    local_start: nextFocus[0],
    local_end: nextFocus[nextFocus.length - 1],
  };
};

const buildContentWithEditedMarks = (content, marks) => {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
  if (!Array.isArray(marks) || marks.length === 0) return content;

  const hasLongMarks = Array.isArray(content.marked_text);
  const hasShortMarks = Array.isArray(content.m);
  if (!hasLongMarks && !hasShortMarks) return content;

  const nextContent = { ...content };
  if (hasLongMarks) nextContent.marked_text = marks.map(sanitizeMarkForContent);
  if (hasShortMarks) nextContent.m = marks.map(toShortMark);
  return nextContent;
};

const makeStagedFile = (file) => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  file,
  previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
});

const revokeStagedFile = (item) => {
  if (item?.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
  }
};

const JsonNode = ({ val, nodeKey, foldedKeys, isRoot = false, taskName = '' }) => {
  const isFoldedByDefault = nodeKey && foldedKeys.includes(nodeKey);
  const [isExpanded, setIsExpanded] = useState(!isFoldedByDefault);

  const renderPrimitive = (v) => {
    if (typeof v === 'string') {
      if (v.includes('\n')) {
        return (
          <div style={{ color: '#0550ae', whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '8px 12px', background: '#f3f4f6', borderRadius: '4px', marginTop: '4px', marginBottom: '4px', fontFamily: 'system-ui, sans-serif', borderLeft: '3px solid #d1d5db' }}>
            {v}
          </div>
        );
      }
      return <span style={{ color: '#0550ae', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>&quot;{v}&quot;</span>;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return <span style={{ color: '#cf222e' }}>{String(v)}</span>;
    return <span style={{ color: '#a1a1aa' }}>null</span>;
  };

  const isObjectOrArray = typeof val === 'object' && val !== null;
  const isArray = Array.isArray(val);
  const isEmpty = isObjectOrArray && (isArray ? val.length === 0 : Object.keys(val).length === 0);

  const handleDispatchTask = (word, context, fetchLlm, e) => {
    e.stopPropagation();
    const focusPositions = Array.isArray(val.focusPositions)
      ? val.focusPositions
      : Array.isArray(val.fp)
          ? val.fp
          : (Array.isArray(val.fps) ? val.fps : []);
    dispatchVocabTask(word, context, taskName, fetchLlm, focusPositions);
  };

  const isVocabItem = isObjectOrArray && !isArray && val.word && (val.context || val.example || val.text);

  if (isRoot && isObjectOrArray && !isEmpty) {
    return (
      <div style={{ marginLeft: 0, marginTop: 0 }}>
        {isArray
          ? val.map((item, i) => (
            <div key={i} style={{ display: 'flex', marginTop: '4px' }}>
              <span style={{ marginRight: '8px', color: '#a1a1aa' }}>-</span>
              <div style={{ flex: 1 }}>
                <JsonNode val={item} nodeKey={null} foldedKeys={foldedKeys} isRoot={false} taskName={taskName} />
              </div>
            </div>
          ))
          : Object.entries(val).map(([k, v]) => (
            <JsonNode key={k} val={v} nodeKey={k} foldedKeys={foldedKeys} isRoot={false} taskName={taskName} />
          ))}
      </div>
    );
  }

  if (isObjectOrArray && isEmpty) {
    return (
      <div style={{ marginBottom: '4px' }}>
        {nodeKey && <strong style={{ color: '#24292f' }}>{nodeKey}: </strong>}
        <span style={{ color: '#6e7781' }}>{isArray ? '[]' : '{}'}</span>
      </div>
    );
  }

  const isFoldableString = typeof val === 'string' && (val.includes('\n') || val.length > 30 || isFoldedByDefault);
  const canFold = isObjectOrArray || isFoldableString;

  if (!canFold) {
    return (
      <div style={{ marginBottom: '4px' }}>
        {nodeKey && <strong style={{ color: '#24292f' }}>{nodeKey}: </strong>}
        {renderPrimitive(val)}
      </div>
    );
  }

  let typeLabel = '';
  if (isArray) typeLabel = `Array (${val.length})`;
  else if (isObjectOrArray) typeLabel = 'Object';
  else typeLabel = 'Text';

  return (
    <div style={{ marginLeft: nodeKey ? '16px' : '0', marginTop: '4px', marginBottom: '4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        {nodeKey && <strong style={{ color: '#24292f' }}>{nodeKey}: </strong>}
        <span
          onClick={() => setIsExpanded(!isExpanded)}
          style={{ cursor: 'pointer', userSelect: 'none', color: '#71717a', fontSize: '12px', padding: '2px 6px', background: '#f4f4f5', borderRadius: '4px', border: '1px solid #e4e4e7', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          <span style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', fontSize: '10px' }}>▶</span>
          {typeLabel}
        </span>

        {isVocabItem && (
          <div style={{ display: 'flex', gap: '4px' }}>
            <button onClick={(e) => handleDispatchTask(val.word, val.context || val.example || val.text, false, e)} style={{ padding: '2px 8px', fontSize: '12px', background: '#e4e4e7', color: '#09090b', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>保存</button>
            <button onClick={(e) => handleDispatchTask(val.word, val.context || val.example || val.text, true, e)} style={{ padding: '2px 8px', fontSize: '12px', background: '#10b981', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>解析</button>
          </div>
        )}

        {!isExpanded && <span style={{ color: '#a1a1aa', fontSize: '12px' }}>...</span>}
      </div>

      {isExpanded && (
        <div style={{ marginLeft: '12px', paddingLeft: '12px', borderLeft: '1px dashed #d1d5db', marginTop: '4px' }}>
          {isObjectOrArray
            ? (isArray
                ? val.map((item, i) => (
                  <div key={i} style={{ display: 'flex', marginTop: '4px' }}>
                    <span style={{ marginRight: '8px', color: '#a1a1aa' }}>-</span>
                    <div style={{ flex: 1 }}>
                      <JsonNode val={item} nodeKey={null} foldedKeys={foldedKeys} isRoot={false} taskName={taskName} />
                    </div>
                  </div>
                ))
                : Object.entries(val).map(([k, v]) => (
                  <JsonNode key={k} val={v} nodeKey={k} foldedKeys={foldedKeys} isRoot={false} taskName={taskName} />
                )))
            : <div style={{ marginTop: '4px' }}>{renderPrimitive(val)}</div>}
        </div>
      )}
    </div>
  );
};

const parseLegacyTaskResult = (result) => {
  if (!result) return null;
  if (typeof result === 'object') return result;
  try {
    const jsonMatch = result.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) return JSON.parse(jsonMatch[1]);
    return JSON.parse(result);
  } catch {
    return null;
  }
};

const getOverlayMarks = (content) => {
  if (!content || typeof content !== 'object') return [];

  const normalizeBbox = (rawBbox) => {
    if (!rawBbox || typeof rawBbox !== 'object') return null;
    if (Number.isFinite(rawBbox.left) && Number.isFinite(rawBbox.top) && Number.isFinite(rawBbox.width) && Number.isFinite(rawBbox.height)) {
      return rawBbox;
    }
    if (Number.isFinite(rawBbox.l) && Number.isFinite(rawBbox.t) && Number.isFinite(rawBbox.w) && Number.isFinite(rawBbox.h)) {
      return { left: rawBbox.l, top: rawBbox.t, width: rawBbox.w, height: rawBbox.h };
    }
    return null;
  };

  const sourceMarks = Array.isArray(content.marked_text)
    ? content.marked_text
    : Array.isArray(content.m)
      ? content.m
      : [];

  return sourceMarks
    .map((item, index) => ({
      id: `${item.word || item.w || 'mark'}-${index}`,
      word: item.word || item.w || `标记 ${index + 1}`,
      source_word: item.word || item.w || `标记 ${index + 1}`,
      context: item.context || item.c || '',
      bbox: normalizeBbox(item.bbox || item.b),
      focusPositions: Array.isArray(item.focusPositions)
        ? item.focusPositions
        : Array.isArray(item.fp)
            ? item.fp
            : (Array.isArray(item.fps) ? item.fps : []),
      local_start: Number.isInteger(item.local_start) ? item.local_start : undefined,
      local_end: Number.isInteger(item.local_end) ? item.local_end : undefined,
    }))
    .filter((item) => item.bbox && Number.isFinite(item.bbox.left) && Number.isFinite(item.bbox.top) && Number.isFinite(item.bbox.width) && Number.isFinite(item.bbox.height));
};

const ImageOverlayPreview = ({ src, alt, overlayMarks, showOverlay, selectedMarkId = '', onSelectMark, onMoveMark, onHeightChange }) => {
  const [hasImageError, setHasImageError] = useState(false);
  const previewRootRef = useRef(null);
  const imageWrapRef = useRef(null);
  const dragRef = useRef(null);
  const onHeightChangeRef = useRef(onHeightChange);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!dragRef.current || !imageWrapRef.current || !onMoveMark) return;
      const rect = imageWrapRef.current.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const nextLeftRaw = (e.clientX - rect.left) / rect.width - dragRef.current.offsetX;
      const nextTopRaw = (e.clientY - rect.top) / rect.height - dragRef.current.offsetY;
      const nextLeft = clampNumber(nextLeftRaw, 0, 1 - dragRef.current.width);
      const nextTop = clampNumber(nextTopRaw, 0, 1 - dragRef.current.height);

      onMoveMark(dragRef.current.id, {
        left: Number(nextLeft.toFixed(4)),
        top: Number(nextTop.toFixed(4)),
      });
    };

    const handleMouseUp = () => {
      dragRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [onMoveMark]);

  useEffect(() => {
    if (!previewRootRef.current) return undefined;
    const target = previewRootRef.current;

    const reportHeight = () => {
      const nextHeight = Math.ceil(target.getBoundingClientRect().height);
      if (nextHeight > 0 && onHeightChangeRef.current) onHeightChangeRef.current(nextHeight);
    };

    reportHeight();

    let observer;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => reportHeight());
      observer.observe(target);
    } else {
      window.addEventListener('resize', reportHeight);
    }

    return () => {
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', reportHeight);
    };
  }, [src, overlayMarks.length]);

  if (hasImageError) return <span style={{ color: '#a1a1aa', fontSize: '12px' }}>图片不可用</span>;

  const hasSelected = Boolean(selectedMarkId);

  return (
    <div ref={previewRootRef} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ width: '100%' }}>
        <div
          ref={imageWrapRef}
          style={{
            position: 'relative',
            width: '100%',
            margin: '0 auto',
          }}
        >
          <img
            src={src}
            alt={alt}
            style={{
              display: 'block',
              width: '100%',
              height: 'auto',
            }}
            onError={() => setHasImageError(true)}
          />

          {showOverlay && overlayMarks.length > 0 && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {overlayMarks.map((mark) => {
                const isSelected = selectedMarkId === mark.id;
                return (
                  <div
                    key={mark.id}
                    title={mark.context || mark.word}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onSelectMark) onSelectMark(mark.id, true);
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      if (!onMoveMark || !mark.bbox) return;
                      if (onSelectMark) onSelectMark(mark.id, true);
                      const rect = imageWrapRef.current?.getBoundingClientRect();
                      if (!rect?.width || !rect?.height) return;
                      dragRef.current = {
                        id: mark.id,
                        width: mark.bbox.width,
                        height: mark.bbox.height,
                        offsetX: (e.clientX - rect.left) / rect.width - mark.bbox.left,
                        offsetY: (e.clientY - rect.top) / rect.height - mark.bbox.top,
                      };
                    }}
                    style={{
                      pointerEvents: 'auto',
                      cursor: onMoveMark ? 'move' : 'pointer',
                      position: 'absolute',
                      left: `${mark.bbox.left * 100}%`,
                      top: `${mark.bbox.top * 100}%`,
                      width: `${mark.bbox.width * 100}%`,
                      height: `${mark.bbox.height * 100}%`,
                      border: isSelected ? '2px solid rgba(127, 29, 29, 0.95)' : '2px solid rgba(239, 68, 68, 0.35)',
                      background: isSelected ? 'rgba(239, 68, 68, 0.26)' : 'rgba(239, 68, 68, 0.08)',
                      borderRadius: '4px',
                      boxSizing: 'border-box',
                      opacity: hasSelected ? (isSelected ? 1 : 0.25) : 0.72,
                      transition: 'opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease',
                      zIndex: isSelected ? 3 : 1,
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {overlayMarks.length > 0 && (
        <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '8px', paddingBottom: '8px', maxHeight: '120px', boxSizing: 'border-box', overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: '8px', paddingRight: '6px' }}>
          {overlayMarks.map((mark) => {
            const isSelected = selectedMarkId === mark.id;
            return (
              <button
                key={`${mark.id}-chip`}
                onClick={() => onSelectMark && onSelectMark(mark.id, true)}
                style={{ maxWidth: '100%', border: '1px solid', borderColor: isSelected ? '#7f1d1d' : '#fecaca', background: isSelected ? '#fee2e2' : '#fff1f2', color: isSelected ? '#7f1d1d' : '#9f1239', borderRadius: '999px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}
                title={mark.context || mark.word}
              >
                {mark.word}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const ExperimentalMarkView = ({ marks, selectedMarkId = '', selectionSignal = 0, onSelectMark, taskName = '', onUpdateMark, onToggleFocusToken }) => {
  const itemRefs = useRef({});
  const lastFocusKeyRef = useRef('');

  useEffect(() => {
    if (!selectedMarkId) return undefined;
    const focusKey = `${selectedMarkId}:${selectionSignal}`;
    if (focusKey === lastFocusKeyRef.current) return undefined;
    lastFocusKeyRef.current = focusKey;

    const target = itemRefs.current[selectedMarkId];
    if (!(target instanceof HTMLElement)) return undefined;

    const alignTargetInViewport = (behavior = 'smooth') => {
      const scrollBox = target.closest('.result-json-box');
      if (!(scrollBox instanceof HTMLElement)) return;

      const targetRect = target.getBoundingClientRect();
      const scrollBoxRect = scrollBox.getBoundingClientRect();
      const targetTop = scrollBox.scrollTop + (targetRect.top - scrollBoxRect.top);
      const targetAnchor = targetTop + Math.min(72, Math.max(24, Math.round(targetRect.height * 0.35)));
      const viewTop = scrollBox.scrollTop;
      const viewHeight = scrollBox.clientHeight;
      const focusBandTop = viewTop + Math.round(viewHeight * 0.18);
      const focusBandBottom = viewTop + Math.round(viewHeight * 0.62);

      if (targetAnchor >= focusBandTop && targetAnchor <= focusBandBottom) return;

      const idealAnchorInView = Math.round(viewHeight * 0.34);
      const maxScrollTop = Math.max(0, scrollBox.scrollHeight - viewHeight);
      const nextTop = Math.max(0, Math.min(maxScrollTop, targetAnchor - idealAnchorInView));
      if (Math.abs(nextTop - viewTop) < 1) return;
      scrollBox.scrollTo({ top: nextTop, behavior });
    };

    const rafId = requestAnimationFrame(() => {
      alignTargetInViewport('smooth');
    });
    const timerId = window.setTimeout(() => {
      alignTargetInViewport('auto');
    }, 220);

    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
    };
  }, [selectedMarkId, selectionSignal]);

  if (!marks || marks.length === 0) return <div style={{ color: '#a1a1aa' }}>当前页面没有可联动词块。</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {marks.map((mark, index) => {
        const isSelected = selectedMarkId === mark.id;
        const { tokens } = normalizeRangeForMark(mark);
        const focusPositions = getExplicitFocusPositions(mark, tokens.length);
        const selectedSet = new Set(focusPositions);
        const focusSummary = focusPositions.map((pos) => pos + 1).join(', ');

        return (
          <div
            key={`exp-${mark.id}`}
            ref={(el) => {
              if (el) itemRefs.current[mark.id] = el;
              else delete itemRefs.current[mark.id];
            }}
            onClick={() => onSelectMark && onSelectMark(mark.id, true)}
            style={{ padding: '12px', border: '1px solid', borderColor: isSelected ? '#7f1d1d' : '#e4e4e7', borderRadius: '8px', background: isSelected ? '#fff1f2' : '#ffffff', cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '6px', alignItems: 'center' }}>
              <strong style={{ color: isSelected ? '#7f1d1d' : '#09090b', fontSize: '14px' }}>{index + 1}. {mark.word}</strong>
              <span style={{ fontSize: '11px', color: '#71717a', whiteSpace: 'nowrap' }}>({mark.bbox.left.toFixed(3)}, {mark.bbox.top.toFixed(3)})</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '10px' }}>
              <label style={{ fontSize: '12px', color: '#374151', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                词条文本
                <input value={mark.word || ''} onClick={(e) => e.stopPropagation()} onChange={(e) => onUpdateMark && onUpdateMark(mark.id, { word: e.target.value })} style={{ width: '100%', padding: '6px 8px', border: '1px solid #e4e4e7', borderRadius: '4px', fontSize: '12px', outline: 'none' }} />
              </label>

              <label style={{ fontSize: '12px', color: '#374151', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                语义完整上下文
                <textarea value={mark.context || ''} onClick={(e) => e.stopPropagation()} onChange={(e) => onUpdateMark && onUpdateMark(mark.id, { context: e.target.value })} style={{ width: '100%', padding: '6px 8px', border: '1px solid #e4e4e7', borderRadius: '4px', fontSize: '12px', lineHeight: '1.5', minHeight: '72px', resize: 'vertical', outline: 'none' }} />
              </label>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
              <span style={{ fontSize: '12px', color: '#6b7280' }}>点选焦点词（可跳选多个）</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {tokens.map((token, tokenIndex) => {
                  const isFocused = selectedSet.has(tokenIndex);
                  return (
                    <button
                      key={`${mark.id}-token-${tokenIndex}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onToggleFocusToken) onToggleFocusToken(mark.id, tokenIndex);
                      }}
                      style={{ padding: '2px 6px', fontSize: '12px', border: '1px solid', borderColor: isFocused ? '#7f1d1d' : '#e5e7eb', background: isFocused ? '#fee2e2' : '#fff', color: isFocused ? '#7f1d1d' : '#374151', borderRadius: '999px', cursor: 'pointer' }}
                    >
                      {token}
                    </button>
                  );
                })}
              </div>
              <span style={{ fontSize: '11px', color: '#9ca3af' }}>
                {focusPositions.length ? `focusPositions: [${focusSummary}]（共 ${focusPositions.length} 个）` : 'focusPositions: 未设置（默认按返回词条 word）'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={(e) => { e.stopPropagation(); dispatchVocabTask(mark.word, mark.context, taskName, false, getSerializableFocusPositions(mark)); }} style={{ padding: '3px 10px', fontSize: '12px', background: '#e4e4e7', color: '#09090b', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>保存</button>
              <button onClick={(e) => { e.stopPropagation(); dispatchVocabTask(mark.word, mark.context, taskName, true, getSerializableFocusPositions(mark)); }} style={{ padding: '3px 10px', fontSize: '12px', background: '#10b981', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>解析</button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default function TaskVisualizer() {
  const [pageMode, setPageMode] = useState('browse');

  const [historyTasks, setHistoryTasks] = useState([]);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [taskData, setTaskData] = useState(null);

  const [createTaskName, setCreateTaskName] = useState('');
  const [createStartPage, setCreateStartPage] = useState(1);
  const [stagedFiles, setStagedFiles] = useState([]);
  const [selectedUploadIds, setSelectedUploadIds] = useState([]);
  const fileInputRef = useRef(null);
  const prevStagedRef = useRef([]);

  const [resultViewMode, setResultViewMode] = useState('json');
  const [showCoordinateOverlay, setShowCoordinateOverlay] = useState(true);
  const [selectedMarkByPage, setSelectedMarkByPage] = useState({});
  const [selectedMarkSignalByPage, setSelectedMarkSignalByPage] = useState({});
  const [editedMarksByPage, setEditedMarksByPage] = useState({});
  const [layoutHeightByPage, setLayoutHeightByPage] = useState({});

  const [isUploading, setIsUploading] = useState(false);
  const [regeneratingPages, setRegeneratingPages] = useState({});
  const [editingTaskName, setEditingTaskName] = useState('');
  const [isSavingTaskName, setIsSavingTaskName] = useState(false);
  const [savingPages, setSavingPages] = useState({});
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(() => localStorage.getItem('taskRightPanelCollapsed') === '1');
  const saveTimersRef = useRef({});
  const selectedTaskIdRef = useRef(selectedTaskId);

  const foldedKeysConfig = (localStorage.getItem('defaultFoldedKeys') !== null
    ? localStorage.getItem('defaultFoldedKeys')
    : 'extracted_text,bbox')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s);
  if (!foldedKeysConfig.includes('bbox')) foldedKeysConfig.push('bbox');

  const fetchTasksList = async () => {
    try {
      const data = await getAllTasks();
      if (data.tasks) setHistoryTasks(data.tasks);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchTasksList();
    const listInterval = setInterval(fetchTasksList, 10000);
    return () => clearInterval(listInterval);
  }, []);

  useEffect(() => {
    let detailInterval;
    if (selectedTaskId && taskData?.status !== 'finished' && taskData?.status !== 'paused') {
      detailInterval = setInterval(async () => {
        try {
          const data = await getTaskStatus(selectedTaskId);
          setTaskData(data);
          fetchTasksList();
        } catch {
          // ignore
        }
      }, 5000);
    }
    return () => clearInterval(detailInterval);
  }, [selectedTaskId, taskData?.status]);

  useEffect(() => {
    const prev = prevStagedRef.current;
    const currentIds = new Set(stagedFiles.map((item) => item.id));
    prev.forEach((item) => {
      if (!currentIds.has(item.id)) revokeStagedFile(item);
    });
    prevStagedRef.current = stagedFiles;
  }, [stagedFiles]);

  useEffect(() => () => {
    prevStagedRef.current.forEach((item) => revokeStagedFile(item));
  }, []);


  useEffect(() => {
    localStorage.setItem('taskRightPanelCollapsed', isRightPanelCollapsed ? '1' : '0');
  }, [isRightPanelCollapsed]);

  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);

  const clearSaveTimerForPage = (pageIndex) => {
    const timerId = saveTimersRef.current[pageIndex];
    if (timerId) {
      clearTimeout(timerId);
      delete saveTimersRef.current[pageIndex];
    }
  };

  const clearAllSaveTimers = () => {
    Object.keys(saveTimersRef.current).forEach((key) => {
      const timerId = saveTimersRef.current[key];
      if (timerId) clearTimeout(timerId);
    });
    saveTimersRef.current = {};
  };

  useEffect(() => () => {
    clearAllSaveTimers();
  }, []);

  const schedulePersistPageMarks = (taskId, pageIndex, pageContent, marks) => {
    if (!taskId) return;
    if (!pageContent || typeof pageContent !== 'object' || Array.isArray(pageContent)) return;
    if (!Array.isArray(marks) || marks.length === 0) return;

    const nextParsedResult = buildContentWithEditedMarks(pageContent, marks);
    if (!nextParsedResult || typeof nextParsedResult !== 'object' || Array.isArray(nextParsedResult)) return;

    clearSaveTimerForPage(pageIndex);
    saveTimersRef.current[pageIndex] = setTimeout(async () => {
      if (selectedTaskIdRef.current !== taskId) return;
      setSavingPages((prev) => ({ ...prev, [pageIndex]: true }));
      try {
        const result = await updateTaskPageParsedResult(taskId, pageIndex, nextParsedResult);
        if (selectedTaskIdRef.current !== taskId) return;
        const savedParsedResult = (result && typeof result.parsed_result === 'object')
          ? result.parsed_result
          : nextParsedResult;
        setTaskData((prev) => {
          if (!prev || !Array.isArray(prev.sub_tasks)) return prev;
          const sub = prev.sub_tasks[pageIndex];
          if (!sub) return prev;
          const nextSubTasks = [...prev.sub_tasks];
          nextSubTasks[pageIndex] = { ...sub, parsed_result: savedParsedResult };
          return { ...prev, sub_tasks: nextSubTasks };
        });
      } catch (error) {
        console.error(`页面 ${pageIndex + 1} 的编辑结果保存失败:`, error);
      } finally {
        if (selectedTaskIdRef.current === taskId) {
          setSavingPages((prev) => ({ ...prev, [pageIndex]: false }));
        }
      }
    }, 420);
  };

  const handleSelectTask = async (taskId) => {
    clearAllSaveTimers();
    setPageMode('browse');
    setSelectedTaskId(taskId);
    setTaskData(null);
    setSelectedMarkByPage({});
    setSelectedMarkSignalByPage({});
    setEditedMarksByPage({});
    setLayoutHeightByPage({});
    setSavingPages({});

    const data = await getTaskStatus(taskId);
    setTaskData(data);
    setEditingTaskName(data?.name || '');
  };

  const handleDeleteTask = async () => {
    if (!selectedTaskId) return;
    if (window.confirm('确定要永久删除该任务及记录吗？')) {
      clearAllSaveTimers();
      await deleteTask(selectedTaskId);
      setSelectedTaskId(null);
      setTaskData(null);
      setEditingTaskName('');
      setSelectedMarkByPage({});
      setSelectedMarkSignalByPage({});
      setEditedMarksByPage({});
      setLayoutHeightByPage({});
      setSavingPages({});
      fetchTasksList();
    }
  };

  const handleRenameTask = async () => {
    if (!selectedTaskId || !taskData) return;
    setIsSavingTaskName(true);
    try {
      const result = await renameTask(selectedTaskId, editingTaskName);
      const updatedName = result.name || (editingTaskName || '').trim() || '资源解析任务';
      setTaskData((prev) => (prev ? { ...prev, name: updatedName } : prev));
      setEditingTaskName(updatedName);
      fetchTasksList();
    } catch (error) {
      alert(`任务名更新失败: ${error.message}`);
    } finally {
      setIsSavingTaskName(false);
    }
  };

  const handleResume = async () => {
    if (!selectedTaskId) return;
    await resumeTask(selectedTaskId);
    setTaskData({ ...taskData, status: 'processing' });
    fetchTasksList();
  };

  const handleRegenerate = async (index) => {
    if (!selectedTaskId) return;
    clearSaveTimerForPage(index);
    setRegeneratingPages((prev) => ({ ...prev, [index]: true }));
    try {
      await regenerateTaskPage(selectedTaskId, index);
      const data = await getTaskStatus(selectedTaskId);
      setTaskData(data);
      setEditedMarksByPage((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      setSelectedMarkByPage((prev) => ({ ...prev, [index]: '' }));
      setSelectedMarkSignalByPage((prev) => ({ ...prev, [index]: (prev[index] || 0) + 1 }));
      setLayoutHeightByPage((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      setSavingPages((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
    } catch (error) {
      alert(`重新生成请求失败: ${error.message}`);
    } finally {
      setRegeneratingPages((prev) => ({ ...prev, [index]: false }));
    }
  };

  const handleSelectMark = (pageIndex, markId, force = false) => {
    if (markId && resultViewMode !== 'structured') {
      setResultViewMode('structured');
    }
    setSelectedMarkByPage((prev) => {
      const nextMarkId = force ? markId : (prev[pageIndex] === markId ? '' : markId);
      if (!nextMarkId) return {};
      return { [pageIndex]: nextMarkId };
    });
    setSelectedMarkSignalByPage((prev) => ({ [pageIndex]: (prev[pageIndex] || 0) + 1 }));
  };

  const updatePageMark = (pageIndex, fallbackMarks, pageContent, markId, updater) => {
    setEditedMarksByPage((prev) => {
      const baseMarks = (prev[pageIndex] || fallbackMarks).map(cloneMark);
      const nextMarks = baseMarks.map((mark) => (mark.id === markId ? updater(mark) : mark));
      if (selectedTaskId) {
        schedulePersistPageMarks(selectedTaskId, pageIndex, pageContent, nextMarks.map(cloneMark));
      }
      return { ...prev, [pageIndex]: nextMarks };
    });
  };

  const handleMoveMark = (pageIndex, fallbackMarks, pageContent, markId, nextPosition) => {
    updatePageMark(pageIndex, fallbackMarks, pageContent, markId, (mark) => ({
      ...mark,
      bbox: { ...mark.bbox, ...nextPosition },
    }));
  };

  const handleUpdateMark = (pageIndex, fallbackMarks, pageContent, markId, patch) => {
    updatePageMark(pageIndex, fallbackMarks, pageContent, markId, (mark) => {
      const nextMark = { ...mark, ...patch };
      const { tokens } = normalizeRangeForMark(nextMark);
      if (tokens.length) {
        const focusPositions = getExplicitFocusPositions(nextMark, tokens.length);
        if (focusPositions.length) {
          nextMark.focusPositions = focusPositions;
          nextMark.local_start = focusPositions[0];
          nextMark.local_end = focusPositions[focusPositions.length - 1];
          if (Object.prototype.hasOwnProperty.call(patch, 'context') && !Object.prototype.hasOwnProperty.call(patch, 'word')) {
            nextMark.word = buildWordFromFocusPositions(tokens, focusPositions);
          }
        } else {
          delete nextMark.focusPositions;
          delete nextMark.local_start;
          delete nextMark.local_end;
        }
      }
      return nextMark;
    });
  };

  const handleToggleFocusToken = (pageIndex, fallbackMarks, pageContent, markId, tokenIndex) => {
    updatePageMark(pageIndex, fallbackMarks, pageContent, markId, (mark) => toggleFocusTokenSelection(mark, tokenIndex));
  };

  const handleChooseFiles = (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setStagedFiles((prev) => [...prev, ...files.map((file) => makeStagedFile(file))]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const moveStagedFile = (index, delta) => {
    const nextIndex = index + delta;
    setStagedFiles((prev) => {
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const arr = [...prev];
      const [picked] = arr.splice(index, 1);
      arr.splice(nextIndex, 0, picked);
      return arr;
    });
  };

  const removeOneStagedFile = (id) => {
    setStagedFiles((prev) => prev.filter((item) => item.id !== id));
    setSelectedUploadIds((prev) => prev.filter((x) => x !== id));
  };

  const clearAllStagedFiles = () => {
    setStagedFiles([]);
    setSelectedUploadIds([]);
  };

  const toggleSelectUpload = (id) => {
    setSelectedUploadIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleSelectAllUploads = () => {
    if (selectedUploadIds.length === stagedFiles.length) {
      setSelectedUploadIds([]);
    } else {
      setSelectedUploadIds(stagedFiles.map((item) => item.id));
    }
  };

  const removeSelectedUploads = () => {
    if (!selectedUploadIds.length) return;
    const selected = new Set(selectedUploadIds);
    setStagedFiles((prev) => prev.filter((item) => !selected.has(item.id)));
    setSelectedUploadIds([]);
  };

  const handleCreateTask = async () => {
    if (!stagedFiles.length) return alert('请先选择文件。');

    setIsUploading(true);
    try {
      const formData = new FormData();
      stagedFiles.forEach((item) => formData.append('files', item.file));
      formData.append('taskName', createTaskName);
      formData.append('startPage', createStartPage);

      const result = await uploadResource(formData);
      await fetchTasksList();
      await handleSelectTask(result.task_id);

      setCreateTaskName('');
      setCreateStartPage(1);
      clearAllStagedFiles();
      setPageMode('browse');
    } catch (error) {
      alert(`创建任务失败: ${error.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  const getFormattedResults = () => {
    if (!taskData || !taskData.sub_tasks) return [];

    const finalTaskName = taskData.name || '';
    const basePage = taskData.start_page !== undefined ? parseInt(taskData.start_page, 10) : 1;

    return taskData.sub_tasks.map((sub, index) => {
      const parsedContent = sub.parsed_result || parseLegacyTaskResult(sub.result);
      const extractedContent = parsedContent || sub.result;
      const overlayMarks = getOverlayMarks(parsedContent);

      return {
        task_name: finalTaskName,
        page_number: basePage + index,
        content: extractedContent,
        status: sub.status,
        image_path: sub.path,
        error: sub.error,
        overlay_marks: overlayMarks,
        experimental_coordinates: Boolean(sub.result_meta?.experimental_coordinates),
      };
    });
  };

  const getStatusText = (status) => {
    if (status === 'finished') return <span style={{ color: '#10b981' }}>完成</span>;
    if (status === 'processing') return <span style={{ color: '#3b82f6' }}>处理中</span>;
    if (status === 'paused') return <span style={{ color: '#ef4444' }}>失败/暂停</span>;
    return <span style={{ color: '#71717a' }}>等待中</span>;
  };

  const formattedResults = getFormattedResults();
  const taskHasOverlayMarks = formattedResults.some((item) => item.overlay_marks.length > 0);
  const taskUsesExperimentalCoordinates = formattedResults.some((item) => item.experimental_coordinates);
  const showOverlayToggle = taskUsesExperimentalCoordinates || taskHasOverlayMarks;
  const normalizedCurrentTaskName = (taskData?.name || '').trim() || '资源解析任务';
  const normalizedEditingTaskName = (editingTaskName || '').trim() || '资源解析任务';
  const isTaskNameDirty = normalizedCurrentTaskName !== normalizedEditingTaskName;
  const progressPct = taskData?.total ? ((taskData.completed / taskData.total) * 100) : 0;
  const canTuneBrowseView = pageMode === 'browse' && Boolean(taskData);

  return (
    <div className="task-layout" style={{ position: 'relative', height: '100%', width: '100%', minHeight: 0, overflow: 'hidden', background: '#fff' }}>
      <div className="task-main" style={{ height: '100%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#fff', overflow: 'hidden', paddingRight: '52px' }}>
        {pageMode === 'create' ? (
          <div className="task-page-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px' }}>
            <div style={{ maxWidth: '980px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: '18px', color: '#09090b', fontWeight: 600 }}>新建任务</div>
                  <div style={{ fontSize: '12px', color: '#71717a', marginTop: '2px' }}>上传后可预览、调整顺序、删除部分文件再确认创建</div>
                </div>
                <button onClick={handleCreateTask} disabled={isUploading || !stagedFiles.length} style={{ padding: '8px 16px', border: '1px solid transparent', borderRadius: '6px', fontSize: '13px', cursor: (isUploading || !stagedFiles.length) ? 'not-allowed' : 'pointer', background: (isUploading || !stagedFiles.length) ? '#e4e4e7' : '#18181b', color: (isUploading || !stagedFiles.length) ? '#71717a' : '#fff' }}>{isUploading ? '处理中...' : '确认并创建任务'}</button>
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', padding: '12px', border: '1px solid #e4e4e7', borderRadius: '8px', background: '#fafafa' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#09090b' }}>任务名</span>
                <input value={createTaskName} onChange={(e) => setCreateTaskName(e.target.value)} placeholder="任务名称（选填）" style={{ padding: '6px 10px', border: '1px solid #e4e4e7', borderRadius: '4px', fontSize: '13px', width: '220px', outline: 'none', background: '#fff' }} />
                <span style={{ fontSize: '13px', color: '#71717a' }}>起始页</span>
                <input type="number" min="1" value={createStartPage} onChange={(e) => setCreateStartPage(Math.max(1, parseInt(e.target.value, 10) || 1))} style={{ padding: '6px 10px', border: '1px solid #e4e4e7', borderRadius: '4px', fontSize: '13px', width: '90px', outline: 'none', background: '#fff' }} />
                <input ref={fileInputRef} type="file" multiple accept="image/*,application/pdf" onChange={handleChooseFiles} style={{ fontSize: '13px' }} />
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px', border: '1px solid #e4e4e7', borderRadius: '6px', background: '#fafafa' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#374151' }}>
                  <input type="checkbox" checked={stagedFiles.length > 0 && selectedUploadIds.length === stagedFiles.length} onChange={toggleSelectAllUploads} />
                  全选
                </label>
                <button onClick={removeSelectedUploads} disabled={!selectedUploadIds.length} style={{ padding: '4px 10px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: selectedUploadIds.length ? 'pointer' : 'not-allowed', color: selectedUploadIds.length ? '#09090b' : '#a1a1aa' }}>删除选中</button>
                <button onClick={clearAllStagedFiles} disabled={!stagedFiles.length} style={{ padding: '4px 10px', border: '1px solid #fca5a5', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: stagedFiles.length ? 'pointer' : 'not-allowed', color: stagedFiles.length ? '#ef4444' : '#fca5a5' }}>全部删除</button>
                <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#71717a' }}>已上传 {stagedFiles.length} 个文件</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {stagedFiles.length === 0 && <div style={{ color: '#a1a1aa', textAlign: 'center', padding: '28px 0' }}>请先上传图片/PDF，再确认创建任务。</div>}
                {stagedFiles.map((item, index) => {
                  const selected = selectedUploadIds.includes(item.id);
                  return (
                    <div key={item.id} style={{ border: '1px solid #e4e4e7', borderRadius: '8px', padding: '10px', display: 'flex', gap: '12px', alignItems: 'center', background: selected ? '#faf5ff' : '#fff' }}>
                      <input type="checkbox" checked={selected} onChange={() => toggleSelectUpload(item.id)} />
                      <div style={{ width: '84px', height: '64px', border: '1px solid #e4e4e7', borderRadius: '6px', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fafafa', flexShrink: 0 }}>
                        {item.previewUrl
                          ? <img src={item.previewUrl} alt={item.file.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          : <span style={{ fontSize: '11px', color: '#71717a' }}>PDF</span>}
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: '13px', color: '#09090b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{index + 1}. {item.file.name}</div>
                        <div style={{ fontSize: '11px', color: '#71717a' }}>{Math.round(item.file.size / 1024)} KB</div>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={() => moveStagedFile(index, -1)} disabled={index === 0} style={{ padding: '4px 8px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: index === 0 ? 'not-allowed' : 'pointer', color: index === 0 ? '#a1a1aa' : '#09090b' }}>上移</button>
                        <button onClick={() => moveStagedFile(index, 1)} disabled={index === stagedFiles.length - 1} style={{ padding: '4px 8px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: index === stagedFiles.length - 1 ? 'not-allowed' : 'pointer', color: index === stagedFiles.length - 1 ? '#a1a1aa' : '#09090b' }}>下移</button>
                        <button onClick={() => removeOneStagedFile(item.id)} style={{ padding: '4px 8px', border: '1px solid #fca5a5', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: 'pointer', color: '#ef4444' }}>删除</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : taskData ? (
          <div className="task-detail-wrapper" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="task-toolbar" style={{ padding: '10px 16px', borderBottom: '1px solid #e4e4e7', background: '#fafafa', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <div className="task-status-bar" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px', color: '#71717a' }}>
                <span>任务名</span>
                <input value={editingTaskName} onChange={(e) => setEditingTaskName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && isTaskNameDirty && !isSavingTaskName) handleRenameTask(); }} style={{ padding: '4px 8px', border: '1px solid #e4e4e7', borderRadius: '4px', fontSize: '12px', width: '220px', outline: 'none' }} />
                <button onClick={handleRenameTask} disabled={!isTaskNameDirty || isSavingTaskName} style={{ padding: '4px 8px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: (!isTaskNameDirty || isSavingTaskName) ? 'not-allowed' : 'pointer', color: (!isTaskNameDirty || isSavingTaskName) ? '#a1a1aa' : '#09090b' }}>{isSavingTaskName ? '保存中...' : '保存'}</button>
                <span>进度 {taskData.completed} / {taskData.total}</span>
                <span>状态 {getStatusText(taskData.status)}</span>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                {taskData.status === 'paused' && <button onClick={handleResume} style={{ padding: '4px 10px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: 'pointer' }}>继续</button>}
                <button onClick={handleDeleteTask} style={{ padding: '4px 10px', border: '1px solid #fca5a5', borderRadius: '4px', background: '#fff', color: '#ef4444', fontSize: '12px', cursor: 'pointer' }}>删除任务</button>
              </div>
            </div>

            <div style={{ height: '2px', background: '#e4e4e7', flexShrink: 0 }}>
              <div style={{ height: '100%', width: `${progressPct}%`, background: taskData.status === 'paused' ? '#ef4444' : '#18181b', transition: 'width 0.3s' }} />
            </div>

            <div className="task-page-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px' }}>
              {formattedResults.map((item, idx) => {
                const isRegenerating = regeneratingPages[idx];
                const pageMarks = (editedMarksByPage[idx] || item.overlay_marks).map(cloneMark);
                const selectedMarkId = selectedMarkByPage[idx] || '';
                const selectedMarkSignal = selectedMarkSignalByPage[idx] || 0;
                const displayContent = buildContentWithEditedMarks(item.content, pageMarks);
                const measuredRowHeight = layoutHeightByPage[idx];

                return (
                  <div key={idx} className="result-item-container" style={{ marginBottom: '24px', border: '1px solid #e4e4e7', borderRadius: '6px', overflow: 'hidden' }}>
                    <div style={{ padding: '8px 12px', background: '#fafafa', borderBottom: '1px solid #e4e4e7', fontSize: '12px', color: '#71717a', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ color: '#09090b', fontWeight: 500 }}>页码: {item.page_number}</span>
                        <span>状态: {item.status === 'completed' ? '解析成功' : item.status === 'failed' ? '解析失败' : '处理中...'}</span>
                        {item.experimental_coordinates && <span style={{ color: '#991b1b', background: '#fee2e2', padding: '2px 8px', borderRadius: '999px' }}>坐标实验</span>}
                        {pageMarks.length > 0 && <span style={{ color: '#065f46', background: '#d1fae5', padding: '2px 8px', borderRadius: '999px' }}>坐标 {pageMarks.length} 个</span>}
                        {savingPages[idx] && <span style={{ color: '#1d4ed8', background: '#dbeafe', padding: '2px 8px', borderRadius: '999px' }}>保存中…</span>}
                        {item.error && <span style={{ color: '#ef4444', background: '#fee2e2', padding: '2px 8px', borderRadius: '4px', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.error}>原因: {item.error}</span>}
                      </div>
                      <button onClick={() => handleRegenerate(idx)} disabled={isRegenerating || item.status === 'processing'} style={{ padding: '4px 10px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: (isRegenerating || item.status === 'processing') ? 'not-allowed' : 'pointer', color: (isRegenerating || item.status === 'processing') ? '#a1a1aa' : '#09090b' }}>{isRegenerating ? '请求中...' : '重新生成'}</button>
                    </div>

                    <div className="result-layout" style={{ display: 'flex', alignItems: 'flex-start', height: measuredRowHeight ? `${measuredRowHeight}px` : 'auto' }}>
                      <div
                        className="result-image-box"
                        style={{ width: '620px', minWidth: '320px', maxWidth: '72%', borderRight: '1px solid #e4e4e7', padding: '12px', background: '#fff', overflow: 'hidden', display: 'flex', alignItems: 'stretch', alignSelf: 'flex-start' }}
                      >
                        <ImageOverlayPreview
                          src={getImageUrl(item.image_path)}
                          alt={`第 ${item.page_number} 页预览`}
                          overlayMarks={pageMarks}
                          showOverlay={showCoordinateOverlay}
                          selectedMarkId={selectedMarkId}
                          onSelectMark={(markId, force) => handleSelectMark(idx, markId, force)}
                          onMoveMark={(markId, nextPosition) => handleMoveMark(idx, pageMarks, item.content, markId, nextPosition)}
                          onHeightChange={(height) => {
                            const normalized = Math.max(260, Math.ceil(height));
                            setLayoutHeightByPage((prev) => (prev[idx] === normalized ? prev : { ...prev, [idx]: normalized }));
                          }}
                        />
                      </div>

                      <div className="result-json-box" style={{ flex: 1, minWidth: 0, background: '#fafafa', padding: '12px', height: measuredRowHeight ? '100%' : 'auto', overflowY: 'auto', overflowX: 'auto', fontSize: '13px', lineHeight: 1.6, fontFamily: resultViewMode === 'json' ? 'ui-monospace, Consolas, monospace' : 'system-ui, sans-serif' }}>
                        {item.status === 'failed' ? (
                          <div style={{ color: '#ef4444', padding: '10px', background: '#fee2e2', borderRadius: '4px' }}><strong>错误详情:</strong> {item.error}</div>
                        ) : displayContent ? (
                          resultViewMode === 'json'
                            ? (typeof displayContent === 'object'
                                ? <JsonNode val={displayContent} nodeKey={null} foldedKeys={foldedKeysConfig} isRoot taskName={item.task_name} />
                                : <pre style={{ whiteSpace: 'pre-wrap', color: '#24292f', margin: 0, fontFamily: 'inherit' }}>{displayContent}</pre>)
                            : <ExperimentalMarkView
                                marks={pageMarks}
                                selectedMarkId={selectedMarkId}
                                selectionSignal={selectedMarkSignal}
                                onSelectMark={(markId, force) => handleSelectMark(idx, markId, force)}
                                taskName={item.task_name}
                                onUpdateMark={(markId, patch) => handleUpdateMark(idx, pageMarks, item.content, markId, patch)}
                                onToggleFocusToken={(markId, tokenIndex) => handleToggleFocusToken(idx, pageMarks, item.content, markId, tokenIndex)}
                              />
                        ) : (
                          <div style={{ color: '#a1a1aa' }}>等待处理...</div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a1a1aa', fontSize: '14px' }}>请在右侧选择一个历史任务，或切到“新建任务”。</div>
        )}
      </div>

      <aside className={`task-right-panel${isRightPanelCollapsed ? ' is-collapsed' : ''}`} style={{ position: 'absolute', top: '12px', right: '12px', bottom: '12px', width: isRightPanelCollapsed ? '40px' : '320px', minWidth: '40px', border: '1px solid #e4e4e7', borderRadius: '10px', background: '#fafafa', display: 'flex', flexDirection: 'row', minHeight: 0, overflow: 'hidden', transition: 'width 0.2s ease', boxShadow: '0 12px 24px rgba(15, 23, 42, 0.08)', zIndex: 30 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, opacity: isRightPanelCollapsed ? 0 : 1, visibility: isRightPanelCollapsed ? 'hidden' : 'visible', pointerEvents: isRightPanelCollapsed ? 'none' : 'auto', transition: 'opacity 0.15s ease' }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid #e4e4e7', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#71717a' }}>工作区</div>
              <div style={{ display: 'inline-flex', border: '1px solid #e4e4e7', borderRadius: '6px', overflow: 'hidden', background: '#fff' }}>
                <button onClick={() => setPageMode('browse')} style={{ padding: '6px 12px', border: 'none', borderRight: '1px solid #e4e4e7', fontSize: '12px', background: pageMode === 'browse' ? '#e4e4e7' : '#fff', color: '#09090b', cursor: 'pointer' }}>浏览任务</button>
                <button onClick={() => setPageMode('create')} style={{ padding: '6px 12px', border: 'none', fontSize: '12px', background: pageMode === 'create' ? '#e4e4e7' : '#fff', color: '#09090b', cursor: 'pointer' }}>新建任务</button>
              </div>
              {pageMode === 'browse' && taskData && (
                <div style={{ fontSize: '12px', color: '#71717a' }}>当前任务：<strong style={{ color: '#09090b' }}>{taskData.name || '未命名'}</strong></div>
              )}
            </div>

            <div style={{ padding: '10px 12px', borderBottom: '1px solid #e4e4e7', display: 'flex', flexDirection: 'column', gap: '8px', opacity: canTuneBrowseView ? 1 : 0.55 }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#71717a' }}>查看设置</div>
              <div style={{ display: 'inline-flex', border: '1px solid #e4e4e7', borderRadius: '6px', overflow: 'hidden', background: '#fff' }}>
                <button onClick={() => setResultViewMode('json')} disabled={!canTuneBrowseView} style={{ padding: '4px 10px', border: 'none', borderRight: '1px solid #e4e4e7', fontSize: '12px', background: resultViewMode === 'json' ? '#e4e4e7' : '#fff', color: '#09090b', cursor: canTuneBrowseView ? 'pointer' : 'not-allowed' }}>JSON</button>
                <button onClick={() => setResultViewMode('structured')} disabled={!canTuneBrowseView} style={{ padding: '4px 10px', border: 'none', fontSize: '12px', background: resultViewMode === 'structured' ? '#fee2e2' : '#fff', color: resultViewMode === 'structured' ? '#991b1b' : '#09090b', cursor: canTuneBrowseView ? 'pointer' : 'not-allowed' }}>实验可读视图</button>
              </div>
              {showOverlayToggle && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: taskHasOverlayMarks ? '#09090b' : '#71717a', padding: '4px 10px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff' }}>
                  <input type="checkbox" checked={showCoordinateOverlay} onChange={(e) => setShowCoordinateOverlay(e.target.checked)} disabled={!taskHasOverlayMarks || !canTuneBrowseView} />
                  显示坐标图层
                </label>
              )}
            </div>

            <div style={{ padding: '10px 12px', borderBottom: '1px solid #e4e4e7', fontSize: '12px', fontWeight: 600, color: '#71717a' }}>历史任务</div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {historyTasks.map((task) => {
                const isSelected = selectedTaskId === task.id;
                return (
                  <div key={task.id} onClick={() => handleSelectTask(task.id)} style={{ padding: '10px 12px', borderBottom: '1px solid #e4e4e7', cursor: 'pointer', background: isSelected ? '#e4e4e7' : 'transparent' }}>
                    <div style={{ fontSize: '13px', fontWeight: isSelected ? 600 : 400, color: '#09090b', marginBottom: '4px', wordBreak: 'break-all', overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.name || '未命名'}</div>
                    <div style={{ fontSize: '12px', color: '#71717a', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{task.completed} / {task.total}</span>
                      {getStatusText(task.status)}
                    </div>
                  </div>
                );
              })}
              {historyTasks.length === 0 && <div style={{ padding: '16px', color: '#a1a1aa', fontSize: '12px' }}>暂无历史任务</div>}
            </div>
          </div>
        <button
          type="button"
          onClick={() => setIsRightPanelCollapsed((prev) => !prev)}
          title={isRightPanelCollapsed ? '展开侧栏' : '收起侧栏'}
          aria-label={isRightPanelCollapsed ? '展开侧栏' : '收起侧栏'}
          style={{ width: '30px', minWidth: '30px', flexShrink: 0, border: 'none', borderLeft: '1px solid #e4e4e7', background: '#f8fafc', cursor: 'pointer', color: '#52525b', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '10px 4px' }}
        >
          <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
            <span aria-hidden style={{ display: 'inline-block', fontSize: '12px', lineHeight: 1, transform: isRightPanelCollapsed ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}>
              ❮
            </span>
            <span style={{ writingMode: 'vertical-rl', fontSize: '11px', letterSpacing: '1px', fontWeight: 600, lineHeight: 1.1 }}>
              侧栏
            </span>
          </span>
        </button>
      </aside>
    </div>
  );
}
