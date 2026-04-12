import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  getVocabularyCategories,
  getVocabularyDetail,
  getVocabularyList,
} from '../api/client';

const dispatchVocabTask = (word, context, taskName, fetchLlm, focusPositions = []) => {
  window.dispatchEvent(new CustomEvent('add-vocab-task', {
    detail: { word, context, source: taskName, fetchLlm, focusPositions }
  }));
};

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));
const TOKEN_REGEX = /[\p{L}\p{N}_]+|[^\s]/gu;
const CATEGORY_LABELS = {
  cet: 'CET',
  daily: 'Daily',
  kaoyan: 'Kaoyan',
  toefl: 'TOEFL',
  ielts: 'IELTS',
};

const formatCategoryLabel = (category) => {
  const normalized = String(category || '').trim();
  if (!normalized) return '根目录';
  return CATEGORY_LABELS[normalized] || normalized;
};

const cloneMark = (mark) => ({
  ...mark,
  bbox: mark?.bbox ? { ...mark.bbox } : null,
});

const tokenizeContext = (text) => String(text || '')
  .match(TOKEN_REGEX) || [];

const isConnectorToken = (token) => /^['’\-–—/]$/.test(token);
const isNoSpaceBeforeToken = (token) => /^[,.;:!?%)\]}>\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u3009\u300b\u300d\u300f\u3011]$/.test(token);
const isNoSpaceAfterToken = (token) => /^[([{<\u3008\u300a\u300c\u300e\u3010]$/.test(token);

const joinFocusTokens = (selectedTokens) => selectedTokens.reduce((result, token, index) => {
  if (!token) return result;
  if (index === 0 || !result) return token;

  const prevToken = selectedTokens[index - 1] || '';
  if (
    isConnectorToken(token) ||
    isConnectorToken(prevToken) ||
    isNoSpaceBeforeToken(token) ||
    isNoSpaceAfterToken(prevToken)
  ) {
    return `${result}${token}`;
  }
  return `${result} ${token}`;
}, '');

const normalizeSimilarityWord = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const buildSimilarityWordKey = (value) => normalizeSimilarityWord(value).replace(/\s+/g, '-');

const tokenizeSimilarityWord = (value) => normalizeSimilarityWord(value)
  .split(/\s+/)
  .filter(Boolean);

const buildSimilarityBigrams = (value) => {
  const compact = normalizeSimilarityWord(value).replace(/\s+/g, '');
  if (!compact) return [];
  if (compact.length === 1) return [compact];

  const bigrams = [];
  for (let i = 0; i < compact.length - 1; i += 1) {
    bigrams.push(compact.slice(i, i + 2));
  }
  return bigrams;
};

const RESULT_VIEW_STORAGE_KEY = 'taskResultViewMode';
const ACTIVE_VOCAB_CATEGORY_KEY = 'activeVocabCategory';
const ACTIVE_VOCAB_CATEGORY_EVENT = 'active-vocab-category-updated';

const normalizeResultViewMode = (value) => (value === 'json' ? 'json' : 'structured');

const readStoredActiveVocabularyCategory = () => {
  if (typeof window === 'undefined') return '';

  const storedCategory = window.localStorage.getItem(ACTIVE_VOCAB_CATEGORY_KEY);
  if (storedCategory !== null) return String(storedCategory || '').trim();
  return String(window.localStorage.getItem('defaultCategory') || '').trim();
};

const computeDiceScore = (leftItems, rightItems) => {
  if (!leftItems.length || !rightItems.length) return 0;

  const leftCounts = new Map();
  leftItems.forEach((item) => {
    leftCounts.set(item, (leftCounts.get(item) || 0) + 1);
  });

  let overlap = 0;
  rightItems.forEach((item) => {
    const count = leftCounts.get(item) || 0;
    if (count > 0) {
      overlap += 1;
      leftCounts.set(item, count - 1);
    }
  });

  return (2 * overlap) / (leftItems.length + rightItems.length);
};

const computePrefixScore = (left, right) => {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.startsWith(right) || right.startsWith(left)) return 0.92;
  if (left.includes(right) || right.includes(left)) return 0.72;
  return 0;
};

const normalizeVocabularyEntries = (payload, fallbackCategory = '') => {
  const normalizedCategory = String(payload?.category ?? fallbackCategory ?? '').trim();
  const rawEntries = Array.isArray(payload?.entries)
    ? payload.entries
    : (Array.isArray(payload?.words)
        ? payload.words.map((item) => ({
            key: item,
            file: `${item}.json`,
            word: item,
          }))
        : []);

  return rawEntries
    .map((entry) => {
      const key = String(entry?.key || '').trim();
      const file = String(entry?.file || '').trim();
      const word = String(entry?.word || key || file.replace(/\.json$/i, '')).trim();
      if (!key && !word) return null;

      return {
        key: key || word.toLowerCase().replace(/\s+/g, '-'),
        file: file || `${key || word}.json`,
        word: word || key,
        category: String(entry?.category ?? normalizedCategory).trim(),
      };
    })
    .filter(Boolean);
};

const dedupeVocabularyEntries = (entries) => {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const dedupeKey = `${String(entry?.category || '').trim()}::${String(entry?.key || '').trim()}`;
    if (!dedupeKey || seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return true;
  });
};

const buildTopSimilarVocabularyWords = (word, vocabularyEntries, limit = 3) => {
  const query = normalizeSimilarityWord(word);
  if (!query) return [];

  const queryKey = buildSimilarityWordKey(word);
  const queryTokens = tokenizeSimilarityWord(word);
  const queryBigrams = buildSimilarityBigrams(word);

  return (Array.isArray(vocabularyEntries) ? vocabularyEntries : [])
    .map((entry) => {
      const candidateWord = String(entry?.word || entry?.key || '').trim();
      const candidateKey = buildSimilarityWordKey(candidateWord);
      if (!candidateKey) return null;

      const candidateTokens = tokenizeSimilarityWord(candidateWord);
      const candidateBigrams = buildSimilarityBigrams(candidateWord);
      const exact = candidateKey === queryKey;
      const tokenScore = computeDiceScore(queryTokens, candidateTokens);
      const bigramScore = computeDiceScore(queryBigrams, candidateBigrams);
      const prefixScore = computePrefixScore(queryKey, candidateKey);
      const score = exact ? 1 : (bigramScore * 0.62) + (tokenScore * 0.26) + (prefixScore * 0.12);

      return {
        id: `${String(entry?.category || '').trim()}::${String(entry?.key || '').trim() || candidateKey}`,
        key: String(entry?.key || '').trim() || candidateKey,
        file: String(entry?.file || '').trim(),
        word: candidateWord,
        category: String(entry?.category || '').trim(),
        score,
        exact,
      };
    })
    .filter((item) => item && (item.exact || item.score >= 0.16))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(left.word).localeCompare(String(right.word));
    })
    .slice(0, limit);
};

const buildWordFromFocusPositions = (tokens, focusPositions) => joinFocusTokens(
  focusPositions.map((i) => tokens[i]).filter(Boolean),
);

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
          <div style={{ color: 'var(--ms-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '8px 12px', background: 'var(--ms-surface-muted)', borderRadius: '4px', marginTop: '4px', marginBottom: '4px', fontFamily: 'inherit', borderLeft: '1px solid var(--ms-border)' }}>
            {v}
          </div>
        );
      }
      return <span style={{ color: 'var(--ms-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>&quot;{v}&quot;</span>;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return <span style={{ color: 'var(--ms-text-muted)' }}>{String(v)}</span>;
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
        {nodeKey && <strong style={{ color: 'var(--ms-text)' }}>{nodeKey}: </strong>}
        <span style={{ color: 'var(--ms-text-muted)' }}>{isArray ? '[]' : '{}'}</span>
      </div>
    );
  }

  const isFoldableString = typeof val === 'string' && (val.includes('\n') || val.length > 30 || isFoldedByDefault);
  const canFold = isObjectOrArray || isFoldableString;

  if (!canFold) {
    return (
      <div style={{ marginBottom: '4px' }}>
        {nodeKey && <strong style={{ color: 'var(--ms-text)' }}>{nodeKey}: </strong>}
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
        {nodeKey && <strong style={{ color: 'var(--ms-text)' }}>{nodeKey}: </strong>}
        <span
          onClick={() => setIsExpanded(!isExpanded)}
          style={{ cursor: 'pointer', userSelect: 'none', color: 'var(--ms-text-muted)', fontSize: '12px', padding: '2px 6px', background: 'var(--ms-surface-muted)', borderRadius: '4px', border: '1px solid var(--ms-border)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          <span style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', fontSize: '10px' }}>▶</span>
          {typeLabel}
        </span>

        {isVocabItem && (
          <div style={{ display: 'flex', gap: '4px' }}>
            <button onClick={(e) => handleDispatchTask(val.word, val.context || val.example || val.text, false, e)} style={{ padding: '2px 8px', fontSize: '12px', background: 'var(--ms-surface-muted)', color: 'var(--ms-text)', border: '1px solid var(--ms-border)', borderRadius: '4px', cursor: 'pointer' }}>保存</button>
            <button onClick={(e) => handleDispatchTask(val.word, val.context || val.example || val.text, true, e)} style={{ padding: '2px 8px', fontSize: '12px', background: 'var(--ms-text)', color: '#fff', border: '1px solid var(--ms-text)', borderRadius: '4px', cursor: 'pointer' }}>解析</button>
          </div>
        )}

        {!isExpanded && <span style={{ color: 'var(--ms-text-faint)', fontSize: '12px' }}>...</span>}
      </div>

      {isExpanded && (
        <div style={{ marginLeft: '12px', paddingLeft: '12px', borderLeft: '1px solid var(--ms-border)', marginTop: '4px' }}>
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

  if (hasImageError) return <span style={{ color: 'var(--ms-text-faint)', fontSize: '12px' }}>图片不可用</span>;

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
        <div style={{ borderTop: '1px solid var(--ms-border)', paddingTop: '8px', paddingBottom: '8px', maxHeight: '120px', boxSizing: 'border-box', overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: '8px', paddingRight: '6px' }}>
          {overlayMarks.map((mark) => {
            const isSelected = selectedMarkId === mark.id;
            return (
              <button
                key={`${mark.id}-chip`}
                onClick={() => onSelectMark && onSelectMark(mark.id, true)}
                style={{ maxWidth: '100%', border: '1px solid', borderColor: isSelected ? 'var(--ms-text)' : 'var(--ms-border)', background: isSelected ? 'var(--ms-surface-muted)' : 'var(--ms-surface-muted)', color: isSelected ? 'var(--ms-text)' : 'var(--ms-text)', borderRadius: '4px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}
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

const SimilarVocabularyMatches = ({
  word,
  category,
  scopeLabel,
  vocabularyEntries,
  loading,
  onApplyWord,
  onOpenVocabularyEntry,
}) => {
  const rootRef = useRef(null);
  const popoverRef = useRef(null);
  const anchorRefs = useRef({});
  const [popoverState, setPopoverState] = useState(null);
  const [detailCache, setDetailCache] = useState({});
  const [detailErrorCache, setDetailErrorCache] = useState({});
  const matches = useMemo(
    () => buildTopSimilarVocabularyWords(word, vocabularyEntries, 3),
    [word, vocabularyEntries],
  );
  const openPopoverKey = popoverState?.key || '';
  const activePopoverItem = matches.find((item) => item.id === openPopoverKey) || null;
  const activePopoverDetail = activePopoverItem ? (detailCache[activePopoverItem.id] || null) : null;
  const activePopoverError = activePopoverItem ? (detailErrorCache[activePopoverItem.id] || '') : '';
  const isActivePopoverLoading = Boolean(
    activePopoverItem
    && !activePopoverDetail
    && !activePopoverError,
  );
  const activeExampleItems = Array.isArray(activePopoverDetail?.examples) ? activePopoverDetail.examples : [];

  const measurePopoverAnchor = (key) => {
    const anchorNode = anchorRefs.current[key];
    if (!anchorNode) return null;

    const rect = anchorNode.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  };

  useEffect(() => {
    if (!openPopoverKey) return undefined;

    const handlePointerDown = (event) => {
      const target = event.target;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setPopoverState(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [openPopoverKey]);

  useEffect(() => {
    if (!openPopoverKey) return undefined;

    const refreshPopoverAnchor = () => {
      const nextAnchor = measurePopoverAnchor(openPopoverKey);
      if (!nextAnchor) {
        setPopoverState(null);
        return;
      }

      setPopoverState((prev) => {
        if (!prev || prev.key !== openPopoverKey) return prev;
        return { ...prev, anchor: nextAnchor };
      });
    };

    refreshPopoverAnchor();
    window.addEventListener('resize', refreshPopoverAnchor);
    window.addEventListener('scroll', refreshPopoverAnchor, true);
    return () => {
      window.removeEventListener('resize', refreshPopoverAnchor);
      window.removeEventListener('scroll', refreshPopoverAnchor, true);
    };
  }, [openPopoverKey]);

  useEffect(() => {
    if (!openPopoverKey) return undefined;

    const activeItem = matches.find((item) => item.id === openPopoverKey);
    if (!activeItem) return undefined;
    if (detailCache[openPopoverKey] || detailErrorCache[openPopoverKey]) return undefined;

    let cancelled = false;

    getVocabularyDetail(
      activeItem.key || activeItem.file || activeItem.word,
      activeItem.category || category,
    )
      .then((res) => {
        if (cancelled) return;
        setDetailCache((prev) => ({ ...prev, [openPopoverKey]: res?.data || null }));
      })
      .catch((error) => {
        if (cancelled) return;
        setDetailErrorCache((prev) => ({
          ...prev,
          [openPopoverKey]: error instanceof Error ? error.message : '加载失败',
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [category, detailCache, detailErrorCache, matches, openPopoverKey]);

  const formatExampleFocus = (example) => {
    const positions = Array.isArray(example?.focusPositions)
      ? example.focusPositions.filter((item) => Number.isInteger(item))
      : [];
    if (positions.length > 0) {
      return {
        label: 'focusPositions',
        value: `[${positions.join(', ')}]`,
      };
    }

    const words = Array.isArray(example?.focusWords)
      ? example.focusWords.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    if (words.length > 0) {
      return {
        label: 'focusWords',
        value: words.join(' / '),
      };
    }

    return null;
  };

  const popoverStyle = (() => {
    if (!popoverState?.anchor) return null;
    const width = Math.min(360, Math.max(260, window.innerWidth - 32));
    const estimatedHeight = activeExampleItems.length > 0 ? 320 : (activePopoverError ? 180 : 220);
    const centeredLeft = popoverState.anchor.left + (popoverState.anchor.width / 2) - (width / 2);
    const left = Math.max(16, Math.min(window.innerWidth - width - 16, centeredLeft));
    const belowTop = popoverState.anchor.bottom + 8;
    const aboveTop = popoverState.anchor.top - estimatedHeight - 8;
    const canPlaceBelow = belowTop + Math.min(estimatedHeight, window.innerHeight - 32) <= window.innerHeight - 16;
    const top = canPlaceBelow
      ? Math.max(16, belowTop)
      : Math.max(16, aboveTop);
    return {
      position: 'fixed',
      top: `${top}px`,
      left: `${left}px`,
      width: `${width}px`,
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'min(420px, calc(100vh - 32px))',
      padding: '14px',
      borderRadius: '6px',
      border: '1px solid var(--ms-border)',
      background: '#ffffff',
      boxShadow: 'none',
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      overflow: 'auto',
    };
  })();

  const popoverContent = activePopoverItem && popoverStyle ? (
    <div
      ref={popoverRef}
      onClick={(event) => event.stopPropagation()}
      style={popoverStyle}
    >
      <div style={{ fontSize: '11px', color: 'var(--ms-text-muted)', lineHeight: 1.5 }}>
        当前范围：{scopeLabel || formatCategoryLabel(category)}
      </div>

      <div style={{ fontSize: '11px', color: 'var(--ms-text-muted)', lineHeight: 1.5 }}>
        词条目录：{formatCategoryLabel(activePopoverItem.category || category)}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--ms-text-muted)' }}>word</div>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--ms-text)', wordBreak: 'break-word' }}>
          {activePopoverDetail?.word || activePopoverItem.word}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--ms-text-muted)' }}>examples</div>
        {isActivePopoverLoading ? (
          <div style={{ fontSize: '12px', color: 'var(--ms-text-faint)' }}>词条详情加载中…</div>
        ) : null}
        {!isActivePopoverLoading && activePopoverError ? (
          <div style={{ fontSize: '12px', color: 'var(--ms-text)', background: 'var(--ms-surface-muted)', border: '1px solid var(--ms-border)', borderRadius: '6px', padding: '8px 10px' }}>
            {activePopoverError}
          </div>
        ) : null}
        {!isActivePopoverLoading && !activePopoverError && activeExampleItems.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--ms-text-faint)' }}>暂无例句</div>
        ) : null}
        {!isActivePopoverLoading && !activePopoverError && activeExampleItems.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto', paddingRight: '4px' }}>
            {activeExampleItems.map((example, exampleIndex) => {
              const focusMeta = formatExampleFocus(example);

              return (
                <div
                  key={`${activePopoverItem.key}-example-${exampleIndex}`}
                  style={{
                    padding: '8px 10px',
                    borderRadius: '6px',
                    background: 'var(--ms-surface-muted)',
                    border: '1px solid var(--ms-border)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div style={{ fontSize: '12px', color: 'var(--ms-text)', lineHeight: 1.5 }}>
                    {String(example?.text || '').trim() || '空例句'}
                  </div>
                  {focusMeta ? (
                    <div style={{ fontSize: '11px', color: 'var(--ms-text-muted)', lineHeight: 1.4 }}>
                      <strong style={{ color: 'var(--ms-text-muted)' }}>{focusMeta.label}:</strong> {focusMeta.value}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setPopoverState(null);
          if (onOpenVocabularyEntry) {
            onOpenVocabularyEntry({
              category: activePopoverItem.category || category,
              word: activePopoverItem.word,
              fileKey: activePopoverItem.key || activePopoverItem.file,
            });
          }
        }}
        style={{
          height: '34px',
          borderRadius: '4px',
          border: '1px solid var(--ms-text)',
          background: '#18181b',
          color: '#fff',
          fontSize: '12px',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        跳转到生词本
      </button>
    </div>
  ) : null;

  return (
    <>
    <div ref={rootRef} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 }}>
      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ms-text-muted)', whiteSpace: 'nowrap' }}>
        相似词:
      </span>
      {loading ? (
        <span style={{ fontSize: '12px', color: 'var(--ms-text-faint)' }}>扫描 {scopeLabel || formatCategoryLabel(category)} 中…</span>
      ) : null}

      {!loading && matches.length === 0 ? (
        <span style={{ fontSize: '12px', color: 'var(--ms-text-faint)' }}>{scopeLabel || formatCategoryLabel(category)}里没有足够相近的词条</span>
      ) : null}

      {!loading && matches.length > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 }}>
          {matches.map((item, index) => (
            <div
              key={`${item.word}-${index}`}
              title={item.exact ? `${item.word}（完全匹配）` : `${item.word}（相似度 ${Math.round(item.score * 100)}%）`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                maxWidth: '100%',
              }}
            >
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setPopoverState(null);
                  if (onApplyWord) onApplyWord(item.word);
                }}
                disabled={!onApplyWord}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px 10px',
                  maxWidth: '100%',
                  borderRadius: '4px',
                  background: item.exact ? 'var(--ms-surface-muted)' : 'var(--ms-surface-muted)',
                  border: '1px solid',
                  borderColor: item.exact ? 'var(--ms-border)' : 'var(--ms-border)',
                  color: item.exact ? 'var(--ms-text)' : 'var(--ms-text)',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: onApplyWord ? 'pointer' : 'not-allowed',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.word}
                </span>
                {item.category ? (
                  <span style={{ fontSize: '11px', color: 'var(--ms-text-muted)', whiteSpace: 'nowrap' }}>
                    {formatCategoryLabel(item.category)}
                  </span>
                ) : null}
                <span style={{ fontSize: '11px', opacity: 0.78, whiteSpace: 'nowrap' }}>
                  {item.exact ? '完全匹配' : `${Math.round(item.score * 100)}%`}
                </span>
              </button>

              <button
                type="button"
                ref={(node) => {
                  if (node) {
                    anchorRefs.current[item.id] = node;
                  } else {
                    delete anchorRefs.current[item.id];
                  }
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  const anchor = measurePopoverAnchor(item.id);
                  setPopoverState((prev) => (
                    prev?.key === item.id
                      ? null
                      : {
                          key: item.id,
                          anchor,
                        }
                  ));
                }}
                disabled={!onOpenVocabularyEntry}
                title={`查看 ${item.word} 的操作卡片`}
                aria-label={`查看 ${item.word} 的操作卡片`}
                style={{
                  width: '28px',
                  height: '28px',
                  minWidth: '28px',
                  padding: 0,
                  borderRadius: '4px',
                  border: '1px solid var(--ms-border)',
                  background: '#ffffff',
                  color: 'var(--ms-text-muted)',
                  cursor: onOpenVocabularyEntry ? 'pointer' : 'not-allowed',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '14px',
                  lineHeight: 1,
                }}
              >
                ↗
              </button>
            </div>
          ))}
        </div>
      ) : null}

    </div>
    {popoverContent && typeof document !== 'undefined' ? createPortal(popoverContent, document.body) : null}
    </>
  );
};

const ExperimentalMarkView = ({
  marks,
  selectedMarkId = '',
  selectionSignal = 0,
  onSelectMark,
  taskName = '',
  onUpdateMark,
  onToggleFocusToken,
  vocabularyCategory = '',
  vocabularyEntries = [],
  vocabularyScopeLabel = '',
  vocabularyWordsLoading = false,
  onOpenVocabularyEntry = null,
}) => {
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

  if (!marks || marks.length === 0) return <div style={{ color: 'var(--ms-text-faint)' }}>当前页面没有可联动词块。</div>;

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
            style={{ padding: '12px', border: '1px solid', borderColor: isSelected ? 'var(--ms-text)' : 'var(--ms-border)', borderRadius: '6px', background: isSelected ? 'var(--ms-surface-muted)' : '#ffffff', cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '6px', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 }}>
                <strong style={{ color: 'var(--ms-text)', fontSize: '14px' }}>{index + 1}. {mark.word}</strong>
                {isSelected ? (
                  <SimilarVocabularyMatches
                    word={mark.word}
                    category={vocabularyCategory}
                    vocabularyEntries={vocabularyEntries}
                    scopeLabel={vocabularyScopeLabel}
                    loading={vocabularyWordsLoading}
                    onApplyWord={(nextWord) => onUpdateMark && onUpdateMark(mark.id, { word: nextWord })}
                    onOpenVocabularyEntry={onOpenVocabularyEntry}
                  />
                ) : null}
              </div>
              <span style={{ fontSize: '11px', color: 'var(--ms-text-muted)', whiteSpace: 'nowrap' }}>({mark.bbox.left.toFixed(3)}, {mark.bbox.top.toFixed(3)})</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '10px' }}>
              <label style={{ fontSize: '12px', color: 'var(--ms-text)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                词条文本
                <input value={mark.word || ''} onClick={(e) => e.stopPropagation()} onChange={(e) => onUpdateMark && onUpdateMark(mark.id, { word: e.target.value })} style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--ms-border)', borderRadius: '4px', fontSize: '12px', outline: 'none', background: '#fff' }} />
              </label>

              <label style={{ fontSize: '12px', color: 'var(--ms-text)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                语义完整上下文
                <textarea value={mark.context || ''} onClick={(e) => e.stopPropagation()} onChange={(e) => onUpdateMark && onUpdateMark(mark.id, { context: e.target.value })} style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--ms-border)', borderRadius: '4px', fontSize: '12px', lineHeight: '1.5', minHeight: '72px', resize: 'vertical', outline: 'none', background: '#fff' }} />
              </label>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
              <span style={{ fontSize: '12px', color: 'var(--ms-text-muted)' }}>点选焦点词（可跳选多个）</span>
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
                      style={{ padding: '2px 6px', fontSize: '12px', border: '1px solid', borderColor: isFocused ? 'var(--ms-text)' : 'var(--ms-border)', background: isFocused ? 'var(--ms-surface-muted)' : '#fff', color: isFocused ? 'var(--ms-text)' : 'var(--ms-text)', borderRadius: '4px', cursor: 'pointer' }}
                    >
                      {token}
                    </button>
                  );
                })}
              </div>
              <span style={{ fontSize: '11px', color: 'var(--ms-text-faint)' }}>
                {focusPositions.length ? `focusPositions: [${focusSummary}]（共 ${focusPositions.length} 个）` : 'focusPositions: 未设置（默认按返回词条 word）'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={(e) => { e.stopPropagation(); dispatchVocabTask(mark.word, mark.context, taskName, false, getSerializableFocusPositions(mark)); }} style={{ padding: '3px 10px', fontSize: '12px', background: 'var(--ms-surface-muted)', color: 'var(--ms-text)', border: '1px solid var(--ms-border)', borderRadius: '4px', cursor: 'pointer' }}>保存</button>
              <button onClick={(e) => { e.stopPropagation(); dispatchVocabTask(mark.word, mark.context, taskName, true, getSerializableFocusPositions(mark)); }} style={{ padding: '3px 10px', fontSize: '12px', background: 'var(--ms-text)', color: '#fff', border: '1px solid var(--ms-text)', borderRadius: '4px', cursor: 'pointer' }}>解析</button>
            </div>

          </div>
        );
      })}
    </div>
  );
};

export default function TaskVisualizer({ onOpenVocabularyEntry = null }) {
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

  const [resultViewMode, setResultViewMode] = useState(() => normalizeResultViewMode(localStorage.getItem(RESULT_VIEW_STORAGE_KEY)));
  const [showCoordinateOverlay, setShowCoordinateOverlay] = useState(true);
  const [selectedMarkByPage, setSelectedMarkByPage] = useState({});
  const [selectedMarkSignalByPage, setSelectedMarkSignalByPage] = useState({});
  const [editedMarksByPage, setEditedMarksByPage] = useState({});
  const [layoutHeightByPage, setLayoutHeightByPage] = useState({});
  const [currentVocabCategory, setCurrentVocabCategory] = useState(readStoredActiveVocabularyCategory);
  const [currentVocabEntries, setCurrentVocabEntries] = useState([]);
  const [currentVocabScopeLabel, setCurrentVocabScopeLabel] = useState(() => {
    const storedCategory = readStoredActiveVocabularyCategory();
    return storedCategory ? formatCategoryLabel(storedCategory) : '全部词库';
  });
  const [loadingCurrentVocabWords, setLoadingCurrentVocabWords] = useState(false);

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
    localStorage.setItem(RESULT_VIEW_STORAGE_KEY, normalizeResultViewMode(resultViewMode));
  }, [resultViewMode]);

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

  useEffect(() => {
    const handleConfigUpdate = (event) => {
      const nextCategory = typeof event?.detail?.category === 'string'
        ? String(event.detail.category || '').trim()
        : readStoredActiveVocabularyCategory();
      setCurrentVocabCategory(nextCategory);
    };

    window.addEventListener('config-updated', handleConfigUpdate);
    window.addEventListener('default-category-updated', handleConfigUpdate);
    window.addEventListener(ACTIVE_VOCAB_CATEGORY_EVENT, handleConfigUpdate);
    return () => {
      window.removeEventListener('config-updated', handleConfigUpdate);
      window.removeEventListener('default-category-updated', handleConfigUpdate);
      window.removeEventListener(ACTIVE_VOCAB_CATEGORY_EVENT, handleConfigUpdate);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    setLoadingCurrentVocabWords(true);
    const loadSimilarityEntries = async () => {
      const normalizedCategory = String(currentVocabCategory || '').trim();

      try {
        if (normalizedCategory) {
          const data = await getVocabularyList(normalizedCategory);
          if (cancelled) return;
          setCurrentVocabEntries(dedupeVocabularyEntries(normalizeVocabularyEntries(data, normalizedCategory)));
          setCurrentVocabScopeLabel(formatCategoryLabel(normalizedCategory));
          return;
        }

        const [categoriesResult, rootResult] = await Promise.allSettled([
          getVocabularyCategories(),
          getVocabularyList(''),
        ]);
        const categories = categoriesResult.status === 'fulfilled' && Array.isArray(categoriesResult.value?.categories)
          ? categoriesResult.value.categories
          : [];

        const scopedResults = await Promise.allSettled(categories.map((categoryName) => getVocabularyList(categoryName)));
        if (cancelled) return;

        const aggregatedEntries = [];
        if (rootResult.status === 'fulfilled') {
          aggregatedEntries.push(...normalizeVocabularyEntries(rootResult.value, ''));
        }
        scopedResults.forEach((result, index) => {
          if (result.status !== 'fulfilled') return;
          aggregatedEntries.push(...normalizeVocabularyEntries(result.value, categories[index]));
        });

        setCurrentVocabEntries(dedupeVocabularyEntries(aggregatedEntries));
        setCurrentVocabScopeLabel('全部词库');
      } catch (error) {
        if (!cancelled) {
          console.error('加载相似词词库失败:', error);
          setCurrentVocabEntries([]);
          setCurrentVocabScopeLabel(normalizedCategory ? formatCategoryLabel(normalizedCategory) : '全部词库');
        }
      } finally {
        if (!cancelled) setLoadingCurrentVocabWords(false);
      }
    };

    void loadSimilarityEntries();

    return () => {
      cancelled = true;
    };
  }, [currentVocabCategory]);

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

  const getTaskStatusTone = (status) => {
    if (status === 'finished' || status === 'completed') {
      return { label: '完成', color: 'var(--ms-success)', background: 'var(--ms-success-soft)' };
    }
    if (status === 'processing') {
      return { label: '处理中', color: 'var(--ms-text)', background: 'var(--ms-surface-muted)' };
    }
    if (status === 'paused' || status === 'failed') {
      return { label: status === 'paused' ? '失败/暂停' : '解析失败', color: 'var(--ms-danger)', background: 'var(--ms-danger-soft)' };
    }
    return { label: '等待中', color: 'var(--ms-text-muted)', background: 'rgba(255, 255, 255, 0.9)' };
  };

  const getStatusText = (status) => {
    const tone = getTaskStatusTone(status);
    return <span style={{ color: tone.color }}>{tone.label}</span>;
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
  const taskProgressColor = taskData?.status === 'paused'
    ? 'var(--ms-danger)'
    : taskData?.status === 'finished'
      ? 'var(--ms-success)'
      : 'var(--ms-text)';

  return (
    <div className="task-layout" style={{ position: 'relative', height: '100%', width: '100%', minHeight: 0, overflow: 'hidden', background: '#fff' }}>
      <div className="task-main" style={{ height: '100%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#fff', overflow: 'hidden', paddingRight: isRightPanelCollapsed ? '52px' : '344px' }}>
        {pageMode === 'create' ? (
          <div className="task-page-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px' }}>
            <div className="task-create-shell" style={{ maxWidth: '980px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div className="task-create-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                  <div className="task-create-title" style={{ fontSize: '18px', color: 'var(--ms-text)', fontWeight: 600 }}>新建任务</div>
                  <div className="task-create-subtitle" style={{ fontSize: '12px', color: 'var(--ms-text-muted)', marginTop: '2px' }}>上传后可预览、调整顺序、删除部分文件再确认创建</div>
                </div>
                <button className="task-primary-button" onClick={handleCreateTask} disabled={isUploading || !stagedFiles.length} style={{ padding: '8px 16px', border: '1px solid transparent', borderRadius: '6px', fontSize: '13px', cursor: (isUploading || !stagedFiles.length) ? 'not-allowed' : 'pointer', background: (isUploading || !stagedFiles.length) ? 'var(--ms-surface-inset)' : '#111111', color: (isUploading || !stagedFiles.length) ? 'var(--ms-text-faint)' : '#fff' }}>{isUploading ? '处理中...' : '确认并创建任务'}</button>
              </div>

              <div className="task-create-controls" style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', padding: '12px', border: '1px solid var(--ms-border)', borderRadius: '6px', background: 'rgba(255, 255, 255, 0.9)' }}>
                <span className="task-inline-label" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ms-text)' }}>任务名</span>
                <input className="task-inline-input" value={createTaskName} onChange={(e) => setCreateTaskName(e.target.value)} placeholder="任务名称（选填）" style={{ padding: '6px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', fontSize: '13px', width: '220px', outline: 'none', background: '#fff' }} />
                <span className="task-inline-label is-muted" style={{ fontSize: '13px', color: 'var(--ms-text-muted)' }}>起始页</span>
                <input className="task-inline-input task-inline-input-small" type="number" min="1" value={createStartPage} onChange={(e) => setCreateStartPage(Math.max(1, parseInt(e.target.value, 10) || 1))} style={{ padding: '6px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', fontSize: '13px', width: '90px', outline: 'none', background: '#fff' }} />
                <input className="task-file-input" ref={fileInputRef} type="file" multiple accept="image/*,application/pdf" onChange={handleChooseFiles} style={{ fontSize: '13px' }} />
              </div>

              <div className="task-upload-toolbar" style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px', border: '1px solid #e4e4e7', borderRadius: '6px', background: '#fafafa' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--ms-text)' }}>
                  <input type="checkbox" checked={stagedFiles.length > 0 && selectedUploadIds.length === stagedFiles.length} onChange={toggleSelectAllUploads} />
                  全选
                </label>
                <button className="task-secondary-button" onClick={removeSelectedUploads} disabled={!selectedUploadIds.length} style={{ padding: '4px 10px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: selectedUploadIds.length ? 'pointer' : 'not-allowed', color: selectedUploadIds.length ? '#09090b' : '#a1a1aa' }}>删除选中</button>
                <button className="task-secondary-button" onClick={clearAllStagedFiles} disabled={!stagedFiles.length} style={{ padding: '4px 10px', border: '1px solid var(--ms-border)', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: stagedFiles.length ? 'pointer' : 'not-allowed', color: stagedFiles.length ? 'var(--ms-text)' : 'var(--ms-border)' }}>全部删除</button>
                <span className="task-upload-count" style={{ marginLeft: 'auto', fontSize: '12px', color: '#71717a' }}>已上传 {stagedFiles.length} 个文件</span>
              </div>

              <div className="task-upload-list" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {stagedFiles.length === 0 && <div className="task-empty-state" style={{ color: '#a1a1aa', textAlign: 'center', padding: '28px 0' }}>请先上传图片/PDF，再确认创建任务。</div>}
                {stagedFiles.map((item, index) => {
                  const selected = selectedUploadIds.includes(item.id);
                  return (
                    <div key={item.id} className={`task-upload-item${selected ? ' is-selected' : ''}`} style={{ border: '1px solid #e4e4e7', borderRadius: '6px', padding: '10px', display: 'flex', gap: '12px', alignItems: 'center', background: selected ? 'var(--ms-surface-muted)' : '#fff' }}>
                      <input type="checkbox" checked={selected} onChange={() => toggleSelectUpload(item.id)} />
                      <div className="task-upload-preview" style={{ width: '84px', height: '64px', border: '1px solid #e4e4e7', borderRadius: '6px', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fafafa', flexShrink: 0 }}>
                        {item.previewUrl
                          ? <img src={item.previewUrl} alt={item.file.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          : <span className="task-upload-preview-label" style={{ fontSize: '11px', color: '#71717a' }}>PDF</span>}
                      </div>
                      <div className="task-upload-meta" style={{ minWidth: 0, flex: 1 }}>
                        <div className="task-upload-name" style={{ fontSize: '13px', color: '#09090b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{index + 1}. {item.file.name}</div>
                        <div className="task-upload-size" style={{ fontSize: '11px', color: '#71717a' }}>{Math.round(item.file.size / 1024)} KB</div>
                      </div>
                      <div className="task-upload-actions" style={{ display: 'flex', gap: '6px' }}>
                        <button className="task-secondary-button" onClick={() => moveStagedFile(index, -1)} disabled={index === 0} style={{ padding: '4px 8px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: index === 0 ? 'not-allowed' : 'pointer', color: index === 0 ? '#a1a1aa' : '#09090b' }}>上移</button>
                        <button className="task-secondary-button" onClick={() => moveStagedFile(index, 1)} disabled={index === stagedFiles.length - 1} style={{ padding: '4px 8px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: index === stagedFiles.length - 1 ? 'not-allowed' : 'pointer', color: index === stagedFiles.length - 1 ? '#a1a1aa' : '#09090b' }}>下移</button>
                        <button className="task-secondary-button task-danger-button" onClick={() => removeOneStagedFile(item.id)} style={{ padding: '4px 8px', border: '1px solid var(--ms-border)', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: 'pointer', color: 'var(--ms-text)' }}>删除</button>
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
                <input className="task-inline-input" value={editingTaskName} onChange={(e) => setEditingTaskName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && isTaskNameDirty && !isSavingTaskName) handleRenameTask(); }} style={{ padding: '4px 8px', border: '1px solid #e4e4e7', borderRadius: '4px', fontSize: '12px', width: '220px', outline: 'none' }} />
                <button className="task-secondary-button" onClick={handleRenameTask} disabled={!isTaskNameDirty || isSavingTaskName} style={{ padding: '4px 8px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: (!isTaskNameDirty || isSavingTaskName) ? 'not-allowed' : 'pointer', color: (!isTaskNameDirty || isSavingTaskName) ? '#a1a1aa' : '#09090b' }}>{isSavingTaskName ? '保存中...' : '保存'}</button>
                <span>进度 {taskData.completed} / {taskData.total}</span>
                <span>状态 {getStatusText(taskData.status)}</span>
              </div>

              <div className="task-toolbar-actions" style={{ display: 'flex', gap: '8px' }}>
                {taskData.status === 'paused' && <button className="task-secondary-button" onClick={handleResume} style={{ padding: '4px 10px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: 'pointer' }}>继续</button>}
                <button className="task-secondary-button task-danger-button" onClick={handleDeleteTask} style={{ padding: '4px 10px', border: '1px solid var(--ms-border)', borderRadius: '4px', background: '#fff', color: 'var(--ms-text)', fontSize: '12px', cursor: 'pointer' }}>删除任务</button>
              </div>
            </div>

            <div className="task-progress-track" style={{ height: '2px', background: 'var(--ms-border)', flexShrink: 0 }}>
              <div className="task-progress-bar" style={{ height: '100%', width: `${progressPct}%`, background: taskProgressColor, transition: 'width 0.3s' }} />
            </div>

            <div className="task-page-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px' }}>
              {formattedResults.map((item, idx) => {
                const isRegenerating = regeneratingPages[idx];
                const pageMarks = (editedMarksByPage[idx] || item.overlay_marks).map(cloneMark);
                const selectedMarkId = selectedMarkByPage[idx] || '';
                const selectedMarkSignal = selectedMarkSignalByPage[idx] || 0;
                const displayContent = buildContentWithEditedMarks(item.content, pageMarks);
                const measuredRowHeight = layoutHeightByPage[idx];
                const pageTone = getTaskStatusTone(item.status);

                return (
                  <div key={idx} className="result-item-container" style={{ marginBottom: '24px', border: '1px solid #e4e4e7', borderRadius: '6px', overflow: 'hidden' }}>
                    <div className="result-item-header" style={{ padding: '8px 12px', background: '#fafafa', borderBottom: '1px solid #e4e4e7', fontSize: '12px', color: '#71717a', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                      <div className="result-meta-list" style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className="task-status-chip task-status-chip-page" style={{ color: '#09090b', fontWeight: 500 }}>页码: {item.page_number}</span>
                        <span className="task-status-chip task-status-chip-state" style={{ color: pageTone.color, fontWeight: 600 }}>状态: {item.status === 'completed' ? '解析成功' : item.status === 'failed' ? '解析失败' : '处理中...'}</span>
                        {item.experimental_coordinates && <span className="task-status-chip" style={{ color: 'var(--ms-text)', background: 'var(--ms-surface-muted)', padding: '2px 8px', borderRadius: '4px' }}>坐标实验</span>}
                        {pageMarks.length > 0 && <span className="task-status-chip" style={{ color: 'var(--ms-text)', background: 'var(--ms-surface-muted)', padding: '2px 8px', borderRadius: '4px' }}>坐标 {pageMarks.length} 个</span>}
                        {savingPages[idx] && <span className="task-status-chip task-status-chip-success" style={{ color: 'var(--ms-success)', background: 'var(--ms-success-soft)', padding: '2px 8px', borderRadius: '4px' }}>保存中…</span>}
                        {item.error && <span className="task-status-chip task-status-chip-error" style={{ color: 'var(--ms-danger)', background: 'var(--ms-danger-soft)', padding: '2px 8px', borderRadius: '4px', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.error}>原因: {item.error}</span>}
                      </div>
                      <button className="task-secondary-button" onClick={() => handleRegenerate(idx)} disabled={isRegenerating || item.status === 'processing'} style={{ padding: '4px 10px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff', fontSize: '12px', cursor: (isRegenerating || item.status === 'processing') ? 'not-allowed' : 'pointer', color: (isRegenerating || item.status === 'processing') ? '#a1a1aa' : '#09090b' }}>{isRegenerating ? '请求中...' : '重新生成'}</button>
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
                          <div className="task-error-box" style={{ color: 'var(--ms-text)', padding: '10px', background: 'var(--ms-surface-muted)', borderRadius: '4px' }}><strong>错误详情:</strong> {item.error}</div>
                        ) : displayContent ? (
                          resultViewMode === 'json'
                            ? (typeof displayContent === 'object'
                                ? <JsonNode val={displayContent} nodeKey={null} foldedKeys={foldedKeysConfig} isRoot taskName={item.task_name} />
                                : <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--ms-text)', margin: 0, fontFamily: 'inherit' }}>{displayContent}</pre>)
                            : <ExperimentalMarkView
                                marks={pageMarks}
                                selectedMarkId={selectedMarkId}
                                selectionSignal={selectedMarkSignal}
                                onSelectMark={(markId, force) => handleSelectMark(idx, markId, force)}
                                taskName={item.task_name}
                                onUpdateMark={(markId, patch) => handleUpdateMark(idx, pageMarks, item.content, markId, patch)}
                                onToggleFocusToken={(markId, tokenIndex) => handleToggleFocusToken(idx, pageMarks, item.content, markId, tokenIndex)}
                                vocabularyCategory={currentVocabCategory}
                                vocabularyEntries={currentVocabEntries}
                                vocabularyScopeLabel={currentVocabScopeLabel}
                                vocabularyWordsLoading={loadingCurrentVocabWords}
                                onOpenVocabularyEntry={onOpenVocabularyEntry}
                              />
                        ) : (
                          <div className="task-empty-state" style={{ color: '#a1a1aa' }}>等待处理...</div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="task-empty-state" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a1a1aa', fontSize: '14px' }}>请在右侧选择一个历史任务，或切到“新建任务”。</div>
        )}
      </div>

      <aside className={`task-right-panel${isRightPanelCollapsed ? ' is-collapsed' : ''}`} style={{ position: 'absolute', top: '12px', right: '12px', bottom: '12px', width: isRightPanelCollapsed ? '40px' : '320px', minWidth: '40px', border: '1px solid #e4e4e7', borderRadius: '6px', background: '#fafafa', display: 'flex', flexDirection: 'row', minHeight: 0, overflow: 'hidden', transition: 'width 0.2s ease', boxShadow: 'none', zIndex: 30 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, opacity: isRightPanelCollapsed ? 0 : 1, visibility: isRightPanelCollapsed ? 'hidden' : 'visible', pointerEvents: isRightPanelCollapsed ? 'none' : 'auto', transition: 'opacity 0.15s ease' }}>
            <div className="task-sidebar-section" style={{ padding: '10px 12px', borderBottom: '1px solid #e4e4e7', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="task-sidebar-title" style={{ fontSize: '12px', fontWeight: 600, color: '#71717a' }}>工作区</div>
              <div className="task-segment" style={{ display: 'inline-flex', border: '1px solid #e4e4e7', borderRadius: '6px', overflow: 'hidden', background: '#fff' }}>
                <button className={`task-segment-button${pageMode === 'browse' ? ' is-active' : ''}`} onClick={() => setPageMode('browse')} style={{ padding: '6px 12px', border: 'none', borderRight: '1px solid #e4e4e7', fontSize: '12px', background: pageMode === 'browse' ? '#e4e4e7' : '#fff', color: '#09090b', cursor: 'pointer' }}>浏览任务</button>
                <button className={`task-segment-button${pageMode === 'create' ? ' is-active' : ''}`} onClick={() => setPageMode('create')} style={{ padding: '6px 12px', border: 'none', fontSize: '12px', background: pageMode === 'create' ? '#e4e4e7' : '#fff', color: '#09090b', cursor: 'pointer' }}>新建任务</button>
              </div>
              {pageMode === 'browse' && taskData && (
                <div className="task-sidebar-current" style={{ fontSize: '12px', color: '#71717a' }}>当前任务：<strong style={{ color: '#09090b' }}>{taskData.name || '未命名'}</strong></div>
              )}
            </div>

            <div className="task-sidebar-section" style={{ padding: '10px 12px', borderBottom: '1px solid #e4e4e7', display: 'flex', flexDirection: 'column', gap: '8px', opacity: canTuneBrowseView ? 1 : 0.55 }}>
              <div className="task-sidebar-title" style={{ fontSize: '12px', fontWeight: 600, color: '#71717a' }}>查看设置</div>
              <div className="task-segment" style={{ display: 'inline-flex', border: '1px solid #e4e4e7', borderRadius: '6px', overflow: 'hidden', background: '#fff' }}>
                <button className={`task-segment-button${resultViewMode === 'structured' ? ' is-active' : ''}`} onClick={() => setResultViewMode('structured')} disabled={!canTuneBrowseView} style={{ padding: '4px 10px', border: 'none', borderRight: '1px solid #e4e4e7', fontSize: '12px', background: resultViewMode === 'structured' ? 'var(--ms-surface-muted)' : '#fff', color: resultViewMode === 'structured' ? 'var(--ms-text)' : '#09090b', cursor: canTuneBrowseView ? 'pointer' : 'not-allowed' }}>可读视图</button>
                <button className={`task-segment-button${resultViewMode === 'json' ? ' is-active' : ''}`} onClick={() => setResultViewMode('json')} disabled={!canTuneBrowseView} style={{ padding: '4px 10px', border: 'none', fontSize: '12px', background: resultViewMode === 'json' ? '#e4e4e7' : '#fff', color: '#09090b', cursor: canTuneBrowseView ? 'pointer' : 'not-allowed' }}>JSON</button>
              </div>
              {showOverlayToggle && (
                <label className="task-inline-toggle" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: taskHasOverlayMarks ? '#09090b' : '#71717a', padding: '4px 10px', border: '1px solid #e4e4e7', borderRadius: '4px', background: '#fff' }}>
                  <input type="checkbox" checked={showCoordinateOverlay} onChange={(e) => setShowCoordinateOverlay(e.target.checked)} disabled={!taskHasOverlayMarks || !canTuneBrowseView} />
                  显示坐标图层
                </label>
              )}
            </div>

            <div className="task-sidebar-section task-sidebar-title" style={{ padding: '10px 12px', borderBottom: '1px solid #e4e4e7', fontSize: '12px', fontWeight: 600, color: '#71717a' }}>历史任务</div>
            <div className="task-history-list" style={{ flex: 1, overflowY: 'auto' }}>
              {historyTasks.map((task) => {
                const isSelected = selectedTaskId === task.id;
                return (
                  <div key={task.id} className={`task-history-item${isSelected ? ' is-selected' : ''}`} onClick={() => handleSelectTask(task.id)} style={{ padding: '10px 12px', borderBottom: '1px solid #e4e4e7', cursor: 'pointer', background: isSelected ? '#e4e4e7' : 'transparent' }}>
                    <div className="task-history-name" style={{ fontSize: '13px', fontWeight: isSelected ? 600 : 400, color: '#09090b', marginBottom: '4px', wordBreak: 'break-all', overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.name || '未命名'}</div>
                    <div className="task-history-meta" style={{ fontSize: '12px', color: '#71717a', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{task.completed} / {task.total}</span>
                      {getStatusText(task.status)}
                    </div>
                  </div>
                );
              })}
              {historyTasks.length === 0 && <div className="task-history-empty" style={{ padding: '16px', color: '#a1a1aa', fontSize: '12px' }}>暂无历史任务</div>}
            </div>
          </div>
        <button
          className="task-sidebar-toggle"
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
