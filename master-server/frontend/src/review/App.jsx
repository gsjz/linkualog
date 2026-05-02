import { useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';

import ConfigDrawer from './components/ConfigDrawer';
import './index.css';
import {
  applyMergeSuggestion,
  applySplitSuggestion,
  fetchCategories,
  fetchConfig,
  fetchFiles,
  fetchRecommendedWord,
  fetchVocabDetail,
  getReviewAdvice,
  renameVocabDetail,
  runFileRefine,
  runFolderRefine,
  saveConfig,
  saveVocabDetail,
  submitReviewScore,
} from './api/client';

const TOKEN_REGEX = /\s+|[\w]+|[^\w\s]/gu;
const TODAY = new Date().toISOString().slice(0, 10);
const ALL_SCOPE = '__all__';

const scoreLabels = {
  0: '完全忘记',
  1: '非常吃力',
  2: '勉强想起',
  3: '基本记住',
  4: '比较牢固',
  5: '非常熟练',
};

const ENTRY_FILTER_OPTIONS = [
  { value: 'marked', label: '标记词条' },
  { value: 'all', label: '全部词条' },
  { value: 'unmarked', label: '未标记' },
];

const RECOMMENDATION_WEIGHT_OPTIONS = [
  { key: 'due_weight', label: '到期', description: '逾期、今天到期、新词条' },
  { key: 'created_weight', label: '创建', description: '按创建时间方向排序' },
  { key: 'score_weight', label: '评分', description: '按最近一次评分排序' },
];

const DEFAULT_RECOMMENDATION_PREFERENCES = {
  due_weight: 2.2,
  created_weight: 0.35,
  score_weight: 0.75,
  created_order: 'recent',
  score_order: 'low',
};

function normalizeCategoryValue(value) {
  return String(value || '').trim();
}

function toApiCategory(value) {
  return normalizeCategoryValue(value);
}

function formatCategoryLabel(value) {
  const normalized = toApiCategory(value);
  return normalized || '根目录';
}

function normalizeFilename(value) {
  const filename = String(value || '').trim();
  if (!filename) return '';
  return filename.endsWith('.json') ? filename : `${filename}.json`;
}

function normalizeWordFilename(word) {
  const normalized = collapseWhitespace(word)
    .toLowerCase()
    .replace(/\.json$/i, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized ? `${normalized}.json` : '';
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeManualEntry(entryLike) {
  const file = normalizeFilename(entryLike?.file || entryLike?.filename || entryLike?.key || entryLike?.word);
  const fallbackWord = file.replace(/\.json$/i, '');
  return {
    file,
    word: collapseWhitespace(entryLike?.word || fallbackWord) || fallbackWord,
    marked: Boolean(entryLike?.marked),
  };
}

function normalizeDefinitionKey(value) {
  return collapseWhitespace(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function sanitizeDefinitionList(values) {
  const dedupKeys = new Set();
  return (Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim())
    .filter((item) => {
      const key = normalizeDefinitionKey(item);
      if (!key || dedupKeys.has(key)) return false;
      dedupKeys.add(key);
      return true;
    });
}

function extractDefinitionSuggestionValues(item) {
  const rawList = Array.isArray(item?.suggested_definitions)
    ? item.suggested_definitions
    : Array.isArray(item?.definitions)
      ? item.definitions
      : Array.isArray(item?.suggested)
        ? item.suggested
        : null;
  if (rawList) {
    return sanitizeDefinitionList(rawList);
  }

  return sanitizeDefinitionList([
    item?.suggested,
    item?.suggested_definition,
    item?.definition,
    item?.replacement,
    item?.value,
    item?.text,
    item?.new_definition,
  ]);
}

function parseDefinitionSuggestionLines(value) {
  return sanitizeDefinitionList(
    String(value || '')
      .split('\n')
      .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim()),
  );
}

function tokenizeNonSpace(text) {
  return (String(text || '').match(TOKEN_REGEX) || []).filter((chunk) => !/^\s+$/.test(chunk));
}

function normalizeFocusTokenKey(token) {
  return collapseWhitespace(token).toLowerCase();
}

function uniqueInts(values) {
  return [...new Set(values
    .map((item) => parseInt(item, 10))
    .filter((item) => Number.isInteger(item) && item >= 0))]
    .sort((a, b) => a - b);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeExampleFocusPositions(rawFocus, tokenCount = null) {
  const base = Array.isArray(rawFocus) ? rawFocus : [];
  const normalized = uniqueInts(base);
  if (tokenCount === null) return normalized;
  return normalized.filter((item) => item < tokenCount);
}

function deriveFocusPositionsFromWords(text, focusWords) {
  const tokens = tokenizeNonSpace(text);
  if (!tokens.length) return [];

  const normalizedTokens = tokens.map((token) => normalizeFocusTokenKey(token));
  const matched = new Set();

  (Array.isArray(focusWords) ? focusWords : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .forEach((focusWord) => {
      const wordTokens = tokenizeNonSpace(focusWord)
        .map((token) => normalizeFocusTokenKey(token))
        .filter(Boolean);

      if (!wordTokens.length || wordTokens.length > normalizedTokens.length) return;

      for (let start = 0; start <= normalizedTokens.length - wordTokens.length; start += 1) {
        let matchedAll = true;
        for (let offset = 0; offset < wordTokens.length; offset += 1) {
          if (normalizedTokens[start + offset] !== wordTokens[offset]) {
            matchedAll = false;
            break;
          }
        }
        if (!matchedAll) continue;
        for (let offset = 0; offset < wordTokens.length; offset += 1) {
          matched.add(start + offset);
        }
      }
    });

  return [...matched].sort((a, b) => a - b);
}

function renderPreviewWithFocusPositions(text, rawFocus) {
  const chunks = String(text || '').match(TOKEN_REGEX) || [];
  const focusPositions = normalizeExampleFocusPositions(rawFocus, tokenizeNonSpace(text).length);
  if (!focusPositions.length) return '';

  const focusedSet = new Set(focusPositions);
  let tokenIndex = 0;

  return chunks.map((chunk) => {
    if (/^\s+$/.test(chunk)) return chunk;
    const safe = escapeHtml(chunk);
    const html = focusedSet.has(tokenIndex) ? `<strong>${safe}</strong>` : safe;
    tokenIndex += 1;
    return html;
  }).join('');
}

function renderPreviewWithFocusWords(text, focusWords) {
  let rendered = escapeHtml(text);

  (Array.isArray(focusWords) ? focusWords : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .forEach((focusWord) => {
      const pattern = new RegExp(`(${escapeRegExp(focusWord)})`, 'gi');
      rendered = rendered.replace(pattern, '<strong>$1</strong>');
    });

  return rendered;
}

function getExampleRawFocus(example) {
  return example?.focusPositions ?? example?.focusPosition ?? example?.fp ?? example?.fps ?? [];
}

function normalizeExampleSource(example) {
  const source = example?.source;
  if (source && typeof source === 'object') {
    return {
      text: collapseWhitespace(source.text || ''),
      url: String(source.url || '').trim(),
    };
  }
  return {
    text: collapseWhitespace(source || ''),
    url: '',
  };
}

function normalizeExampleYoutube(example) {
  const youtube = example?.youtube;
  if (!youtube || typeof youtube !== 'object') {
    return { url: '', timestamp: '' };
  }
  const rawTimestamp = youtube.timestamp;
  const parsedTimestamp = parseInt(rawTimestamp, 10);
  return {
    url: String(youtube.url || '').trim(),
    timestamp: Number.isInteger(parsedTimestamp) && parsedTimestamp >= 0 ? parsedTimestamp : '',
  };
}

function formatYouTubeLabel(timestamp) {
  const totalSeconds = Math.max(0, parseInt(timestamp, 10) || 0);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function buildYouTubeLink(url, timestamp) {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) return '';
  const finalTimestamp = Math.max(0, parseInt(timestamp, 10) || 0);
  return `${normalizedUrl}${normalizedUrl.includes('?') ? '&' : '?'}t=${finalTimestamp}s`;
}

function buildExampleFocusPreviewHtml(example) {
  const text = String(example?.text || '');
  if (!text.trim()) return '';

  return renderPreviewWithFocusPositions(text, getExampleRawFocus(example))
    || renderPreviewWithFocusWords(text, example?.focusWords)
    || escapeHtml(text);
}

function buildExampleFocusSummary(example) {
  const focusPositions = normalizeExampleFocusPositions(
    Array.isArray(example?.focusPositions) ? example.focusPositions : [],
    tokenizeNonSpace(example?.text || '').length,
  );
  const focusWords = Array.isArray(example?.focusWords)
    ? example.focusWords.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  if (focusPositions.length) {
    return `focusPositions ${focusPositions.join(', ')}`;
  }
  if (focusWords.length) {
    return `focusWords ${focusWords.join(', ')}`;
  }
  return '未设置 focus';
}

function ExampleFocusPicker({
  example,
  index,
  onToggleFocusPosition,
  onClearFocusPositions,
  onApplyFocusPositions,
}) {
  const [expanded, setExpanded] = useState(false);
  const tokens = tokenizeNonSpace(example?.text || '');
  const focusPositions = normalizeExampleFocusPositions(
    Array.isArray(example?.focusPositions) ? example.focusPositions : [],
    tokens.length,
  );
  const derivedPositions = !focusPositions.length
    ? deriveFocusPositionsFromWords(example?.text || '', example?.focusWords)
    : [];
  const focusSummary = focusPositions.length ? `[${focusPositions.join(', ')}]` : '未设置';
  const previewHtml = renderPreviewWithFocusPositions(example?.text || '', focusPositions)
    || renderPreviewWithFocusWords(example?.text || '', example?.focusWords)
    || escapeHtml(example?.text || '');
  const focusWords = Array.isArray(example?.focusWords) ? example.focusWords.filter(Boolean) : [];

  const handleToggleExpanded = () => {
    if (!expanded && !focusPositions.length && derivedPositions.length) {
      onApplyFocusPositions(index, derivedPositions);
    }
    setExpanded((prev) => !prev);
  };

  return (
    <div className={`focus-picker${expanded ? ' expanded' : ''}`}>
      <div className="focus-picker-header">
        <div className="focus-picker-title">
          <strong>focusPositions 快速选择</strong>
          <div className="focus-picker-summary">
            <span>focusPositions: {focusSummary}</span>
            {!focusPositions.length && focusWords.length ? (
              derivedPositions.length ? (
                <span>展开后将按 focusWords 预填 {derivedPositions.join(', ')}</span>
              ) : (
                <span>当前将回退到 focusWords: {focusWords.join(', ')}</span>
              )
            ) : null}
          </div>
        </div>
        <div className="focus-picker-actions">
          <span className="muted">优先级: positions &gt; words</span>
          <button
            type="button"
            className="ghost"
            onClick={handleToggleExpanded}
          >
            {expanded ? '收起' : '展开'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => onClearFocusPositions(index)}
            disabled={!focusPositions.length}
          >
            清空
          </button>
        </div>
      </div>

      {expanded ? (
        <>
          {!tokens.length ? (
            <div className="empty">先输入例句 text，再点选 token。</div>
          ) : (
            <div className="focus-token-grid">
              {tokens.map((token, tokenIndex) => {
                const active = focusPositions.includes(tokenIndex);
                return (
                  <button
                    key={`focus-token-${index}-${tokenIndex}`}
                    type="button"
                    className={`focus-token${active ? ' active' : ''}`}
                    onClick={() => onToggleFocusPosition(index, tokenIndex)}
                    title={`token #${tokenIndex}`}
                  >
                    <span>{token}</span>
                    <span className="focus-token-index">{tokenIndex}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="focus-picker-preview">
            <div className="row-sub">预览</div>
            <div className="focus-preview-text" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>
        </>
      ) : null}
    </div>
  );
}

function clampScore(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 5) return 5;
  return n;
}

function formatScoreSummary(score) {
  const normalized = clampScore(score);
  return `${normalized}/5 · ${scoreLabels[normalized]}`;
}

function normalizeRecommendationPreferences(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const clampWeight = (item, fallback) => {
    const number = Number(item);
    if (!Number.isFinite(number)) return fallback;
    if (number < 0) return 0;
    if (number > 5) return 5;
    return Math.round(number * 100) / 100;
  };

  return {
    due_weight: clampWeight(raw.due_weight, DEFAULT_RECOMMENDATION_PREFERENCES.due_weight),
    created_weight: clampWeight(raw.created_weight, DEFAULT_RECOMMENDATION_PREFERENCES.created_weight),
    score_weight: clampWeight(raw.score_weight, DEFAULT_RECOMMENDATION_PREFERENCES.score_weight),
    created_order: raw.created_order === 'oldest' ? 'oldest' : 'recent',
    score_order: raw.score_order === 'high' ? 'high' : 'low',
  };
}

function recommendationPreferencesFromConfig(config) {
  return normalizeRecommendationPreferences({
    due_weight: config?.review_recommend_due_weight,
    created_weight: config?.review_recommend_created_weight,
    score_weight: config?.review_recommend_score_weight,
    created_order: config?.review_recommend_created_order,
    score_order: config?.review_recommend_score_order,
  });
}

function recommendationPreferencesToConfig(preferences) {
  const p = normalizeRecommendationPreferences(preferences);
  return {
    review_recommend_due_weight: p.due_weight,
    review_recommend_created_weight: p.created_weight,
    review_recommend_score_weight: p.score_weight,
    review_recommend_created_order: p.created_order,
    review_recommend_score_order: p.score_order,
  };
}

function recommendationPreferencesKey(preferences) {
  const p = normalizeRecommendationPreferences(preferences);
  return [
    p.due_weight.toFixed(2),
    p.created_weight.toFixed(2),
    p.score_weight.toFixed(2),
    p.created_order,
    p.score_order,
  ].join('|');
}

function formatRecommendationPreferenceSummary(preferences) {
  const p = normalizeRecommendationPreferences(preferences);
  const created = p.created_order === 'oldest' ? '最早加入优先' : '最近加入优先';
  const score = p.score_order === 'high' ? '高分优先' : '低分/未记录优先';
  return `${created} · ${score}`;
}

function buildYoudaoUrl(word) {
  const normalized = String(word || '').trim();
  if (!normalized) return '';
  return `https://www.youdao.com/result?word=${encodeURIComponent(normalized)}&lang=en`;
}

function pickPreferredVoice(voices, lang) {
  const normalizedLang = String(lang || '').toLowerCase();
  if (!Array.isArray(voices) || !normalizedLang) return null;

  const exact = voices.find((voice) => String(voice?.lang || '').toLowerCase() === normalizedLang);
  if (exact) return exact;

  const baseLang = normalizedLang.split('-')[0];
  const sameBase = voices.find((voice) => String(voice?.lang || '').toLowerCase().startsWith(`${baseLang}-`));
  if (sameBase) return sameBase;

  return voices.find((voice) => String(voice?.lang || '').toLowerCase().startsWith('en')) || null;
}

function sanitizeDraftForSave(draft, fallbackWord) {
  const next = deepClone(draft) || {};

  next.word = String(next.word || fallbackWord || '').trim() || fallbackWord || '';
  next.createdAt = String(next.createdAt || '').trim() || TODAY;

  const rawDefinitions = Array.isArray(next.definitions) ? next.definitions : [];
  next.definitions = sanitizeDefinitionList(rawDefinitions);

  const rawReviews = Array.isArray(next.reviews) ? next.reviews : [];
  next.reviews = rawReviews
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      date: String(item.date || '').trim(),
      score: clampScore(item.score),
    }))
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date));

  const rawExamples = Array.isArray(next.examples) ? next.examples : [];
  next.examples = rawExamples
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const example = { ...item };
      example.text = String(example.text || '');
      example.explanation = String(example.explanation || '');

      const focusWords = Array.isArray(example.focusWords)
        ? example.focusWords
        : String(example.focusWords || '').split(',');
      example.focusWords = [...new Set(focusWords
        .map((word) => String(word).trim())
        .filter((word) => Boolean(word)))];

      const tokenCount = tokenizeNonSpace(example.text).length;
      const focusPositions = uniqueInts(Array.isArray(example.focusPositions) ? example.focusPositions : [])
        .filter((index) => index < tokenCount);
      if (focusPositions.length) {
        example.focusPositions = focusPositions;
      } else {
        delete example.focusPositions;
      }

      const source = normalizeExampleSource(example);
      if (source.text || source.url) {
        example.source = source;
      } else {
        delete example.source;
      }

      const youtube = normalizeExampleYoutube(example);
      if (youtube.url) {
        example.youtube = {
          url: youtube.url,
          timestamp: youtube.timestamp === '' ? 0 : youtube.timestamp,
        };
      } else {
        delete example.youtube;
      }

      return example;
    });

  return next;
}

function normalizeLlmAction(value) {
  return String(value || '').trim().toLowerCase();
}

function parseIndex(value) {
  const index = parseInt(value, 10);
  if (!Number.isInteger(index) || index < 0) return null;
  return index;
}

function getDefinitionSuggestionList(item) {
  return extractDefinitionSuggestionValues(item);
}

function getDefinitionSuggestionEditorValue(item) {
  const action = normalizeLlmAction(item?.action);
  const values = getDefinitionSuggestionList(item);
  if (action === 'replace_all') {
    return values.join('\n');
  }
  return values[0] || '';
}

function patchDefinitionSuggestionFromEditor(item, rawValue) {
  const action = normalizeLlmAction(item?.action);
  if (action === 'replace_all') {
    const suggestedDefinitions = parseDefinitionSuggestionLines(rawValue);
    return {
      ...item,
      suggested_definitions: suggestedDefinitions,
      suggested: suggestedDefinitions[0] || '',
    };
  }
  return {
    ...item,
    suggested: String(rawValue || '').trim(),
  };
}

function isActionableDefinitionSuggestion(item) {
  if (!item || typeof item !== 'object') {
    return false;
  }

  const action = normalizeLlmAction(item.action);
  const index = parseIndex(item.index);
  const suggestedList = getDefinitionSuggestionList(item);

  if (action === 'drop') {
    return index !== null;
  }
  if (action === 'replace') {
    return index !== null && Boolean(suggestedList[0]);
  }
  if (action === 'append') {
    return Boolean(suggestedList[0]);
  }
  if (action === 'replace_all') {
    return suggestedList.length > 0;
  }
  return false;
}

function isActionableExampleSuggestion(item) {
  if (!item || typeof item !== 'object') {
    return false;
  }

  const action = normalizeLlmAction(item.action);
  const index = parseIndex(item.index);

  if (!action || action === 'keep' || index === null) {
    return false;
  }
  if (action === 'drop' || action === 'trim') {
    return true;
  }

  const suggestedText = String(item.suggested_text || '').trim();
  const suggestedExplanation = String(item.suggested_explanation || '').trim();
  return Boolean(suggestedText || suggestedExplanation);
}

function isActionableEntrySuggestion(item) {
  if (!item || typeof item !== 'object') {
    return false;
  }

  const action = normalizeLlmAction(item.action);
  if (action === 'rename') {
    return Boolean(String(item.suggested_word || '').trim());
  }
  if (action === 'split') {
    return Array.isArray(item.suggested_entries) && item.suggested_entries.length > 0;
  }
  return false;
}

function applyEntryRenameToDraft(baseDraft, suggestedWord) {
  const next = deepClone(baseDraft);
  const oldWord = String(next.word || '').trim();
  const finalWord = collapseWhitespace(suggestedWord);
  if (!finalWord) return next;

  next.word = finalWord;
  next.definitions = Array.isArray(next.definitions) ? next.definitions : [];
  next.examples = Array.isArray(next.examples) ? next.examples.map((example) => {
    if (!example || typeof example !== 'object') return example;
    const currentFocus = Array.isArray(example.focusWords) ? example.focusWords : [];
    const rewrittenFocus = currentFocus.map((focus) => (
      collapseWhitespace(focus).toLowerCase() === oldWord.toLowerCase() ? finalWord : focus
    ));
    if (!rewrittenFocus.some((focus) => collapseWhitespace(focus).toLowerCase() === finalWord.toLowerCase())) {
      rewrittenFocus.push(finalWord);
    }
    return {
      ...example,
      focusWords: [...new Set(rewrittenFocus.map((focus) => String(focus || '').trim()).filter(Boolean))],
    };
  }) : [];
  return next;
}

function applyLlmDefinitionSuggestions(definitions, items) {
  const baseDefinitions = Array.isArray(definitions)
    ? definitions.map((item) => String(item ?? ''))
    : [];

  let replaceAll = null;
  const replaceByIndex = new Map();
  const removeIndices = new Set();
  const appendItems = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (!isActionableDefinitionSuggestion(item)) continue;

    const action = normalizeLlmAction(item.action);
    const index = parseIndex(item.index);
    const suggestedList = getDefinitionSuggestionList(item);

    if (action === 'replace_all') {
      replaceAll = suggestedList;
      continue;
    }

    if (replaceAll) {
      continue;
    }

    if (action === 'append') {
      if (suggestedList[0]) {
        appendItems.push(suggestedList[0]);
      }
      continue;
    }

    if (index === null || index >= baseDefinitions.length) {
      continue;
    }

    if (action === 'drop') {
      removeIndices.add(index);
      continue;
    }

    if (action === 'replace' && suggestedList[0]) {
      replaceByIndex.set(index, suggestedList[0]);
    }
  }

  if (replaceAll) {
    return sanitizeDefinitionList(replaceAll);
  }

  return sanitizeDefinitionList([
    ...baseDefinitions
      .map((item, index) => {
        if (removeIndices.has(index)) return '';
        if (replaceByIndex.has(index)) return replaceByIndex.get(index);
        return item;
      }),
    ...appendItems,
  ]);
}

function suggestionItemKey(prefix, item, index) {
  const type = String(item?.type || item?.action || 'item');
  const singleIndex = Number.isInteger(item?.index) ? item.index : 'na';
  const indices = Array.isArray(item?.indices) ? item.indices.join('-') : '';
  return `${prefix}:${type}:${singleIndex}:${indices}:${index}`;
}

function countActionableLlmItems(llmData) {
  const entry = Array.isArray(llmData?.entry) ? llmData.entry : [];
  const defs = Array.isArray(llmData?.definitions) ? llmData.definitions : [];
  const exs = Array.isArray(llmData?.examples) ? llmData.examples : [];
  let total = 0;

  for (const item of entry) {
    if (normalizeLlmAction(item?.action) === 'rename' && isActionableEntrySuggestion(item)) total += 1;
  }
  for (const item of defs) {
    if (isActionableDefinitionSuggestion(item)) total += 1;
  }
  for (const item of exs) {
    if (isActionableExampleSuggestion(item)) total += 1;
  }
  return total;
}

function buildFullyAutoAppliedDraft(baseDraft, cleanData) {
  const next = deepClone(baseDraft);
  next.definitions = Array.isArray(next.definitions) ? [...next.definitions] : [];
  next.examples = Array.isArray(next.examples) ? [...next.examples] : [];

  const entrySuggestions = Array.isArray(cleanData?.llm?.entry) ? cleanData.llm.entry : [];
  const renameSuggestion = entrySuggestions.find((item) => (
    normalizeLlmAction(item?.action) === 'rename'
    && isActionableEntrySuggestion(item)
  ));
  if (renameSuggestion) {
    const renamed = applyEntryRenameToDraft(next, renameSuggestion.suggested_word);
    next.word = renamed.word;
    next.examples = renamed.examples;
  }

  const exampleRemove = new Set();
  const exampleMutators = new Map();

  const addMutator = (store, index, mutator) => {
    if (index === null || index < 0) return;
    const list = store.get(index) || [];
    list.push(mutator);
    store.set(index, list);
  };

  const llmDefinitions = Array.isArray(cleanData?.llm?.definitions) ? cleanData.llm.definitions : [];
  const llmExamples = Array.isArray(cleanData?.llm?.examples) ? cleanData.llm.examples : [];
  for (const item of llmExamples) {
    if (!isActionableExampleSuggestion(item)) continue;

    const action = normalizeLlmAction(item.action);
    const index = parseIndex(item.index);
    if (index === null || index >= next.examples.length) continue;

    if (action === 'drop') {
      exampleRemove.add(index);
      continue;
    }

    const suggestedText = String(item.suggested_text || '').trim();
    const suggestedExplanation = String(item.suggested_explanation || '').trim();

    addMutator(exampleMutators, index, (example) => {
      const updated = { ...example };
      if (suggestedText) {
        updated.text = suggestedText;
      } else if (action === 'trim') {
        updated.text = collapseWhitespace(updated.text);
      }

      if (suggestedExplanation) {
        updated.explanation = suggestedExplanation;
      }
      return updated;
    });
  }

  for (const [index, mutators] of exampleMutators.entries()) {
    if (index < 0 || index >= next.examples.length || exampleRemove.has(index)) continue;
    let example = { ...(next.examples[index] || {}) };
    for (const mutator of mutators) {
      example = mutator(example);
    }
    next.examples[index] = example;
  }

  if (exampleRemove.size) {
    next.examples = next.examples.filter((_, idx) => !exampleRemove.has(idx));
  }

  next.definitions = applyLlmDefinitionSuggestions(
    next.definitions,
    llmDefinitions,
  );

  return next;
}

function EditorPanel({
  draft,
  dirty,
  saving,
  onWordChange,
  onDefinitionChange,
  onDefinitionAdd,
  onDefinitionRemove,
  onExampleChange,
  onExampleAdd,
  onExampleRemove,
  onExampleToggleFocusPosition,
  onExampleClearFocusPositions,
  onExampleApplyFocusPositions,
  onReplaceDraft,
  onReset,
  onSave,
}) {
  const [rawText, setRawText] = useState('');
  const [rawDirty, setRawDirty] = useState(false);
  const [rawError, setRawError] = useState('');

  if (!draft) {
    return <div className="empty">请选择词条后可编辑内容并保存到 data。</div>;
  }

  const definitions = Array.isArray(draft.definitions) ? draft.definitions : [];
  const examples = Array.isArray(draft.examples) ? draft.examples : [];
  const rawSource = rawDirty ? rawText : JSON.stringify(draft, null, 2);

  return (
    <div className="panel-body list-body editor-panel">
      <section className="editor-section">
        <div className="editor-title-row">
          <h4>词条主信息</h4>
          {dirty ? <span className="dirty-dot">未保存</span> : <span className="saved-dot">已同步</span>}
        </div>

        <div className="editor-grid">
          <label>
            Word
            <input
              className="field"
              value={draft.word || ''}
              onChange={(event) => onWordChange(event.target.value)}
            />
          </label>
          <label>
            Created At
            <input
              className="field"
              type="date"
              value={draft.createdAt || TODAY}
              onChange={(event) => onExampleChange(-1, 'createdAt', event.target.value)}
            />
          </label>
        </div>
      </section>

      <details className="editor-section editor-collapsible-section">
        <summary className="editor-disclosure">
          <span>Definitions</span>
          <span className="editor-disclosure-meta">{definitions.length ? `${definitions.length} 条释义` : '暂无释义'}</span>
        </summary>

        <div className="editor-section-body">
          <div className="editor-title-row">
            <h4>Definitions</h4>
            <button type="button" className="ghost" onClick={onDefinitionAdd}>新增释义</button>
          </div>

          <div className="editor-list">
            {definitions.length === 0 ? <div className="empty">暂无释义</div> : null}
            {definitions.map((item, index) => (
              <div className="editor-item" key={`def-${index}`}>
                <input
                  className="field"
                  value={item}
                  onChange={(event) => onDefinitionChange(index, event.target.value)}
                  placeholder="输入释义"
                />
                <button type="button" className="danger" onClick={() => onDefinitionRemove(index)}>删除</button>
              </div>
            ))}
          </div>
        </div>
      </details>

      <section className="editor-section">
        <div className="editor-title-row">
          <h4>Examples</h4>
          <button type="button" className="ghost" onClick={onExampleAdd}>新增例句</button>
        </div>

        <div className="editor-list">
          {examples.length === 0 ? <div className="empty">暂无例句</div> : null}
          {examples.map((example, index) => {
            const focusPreviewHtml = buildExampleFocusPreviewHtml(example);
            const focusSummary = buildExampleFocusSummary(example);
            const hasExplanation = Boolean(String(example.explanation || '').trim());
            const source = normalizeExampleSource(example);
            const hasSource = Boolean(source.text || source.url);
            const youtube = normalizeExampleYoutube(example);
            const youtubeLink = youtube.url ? buildYouTubeLink(youtube.url, youtube.timestamp) : '';
            const hasYoutube = Boolean(youtube.url);

            return (
              <div className="example-editor-card" key={`example-${index}`}>
                <div className="editor-item between">
                  <strong>例句 {index + 1}</strong>
                  <button type="button" className="danger" onClick={() => onExampleRemove(index)}>删除</button>
                </div>

                <label>
                  text
                  <textarea
                    className="field textarea"
                    rows={3}
                    value={example.text || ''}
                    onChange={(event) => onExampleChange(index, 'text', event.target.value)}
                  />
                </label>

                <div className="example-focus-preview">
                  <div className="row-sub">Focus 渲染</div>
                  {focusPreviewHtml ? (
                    <div className="focus-preview-text example-focus-render" dangerouslySetInnerHTML={{ __html: focusPreviewHtml }} />
                  ) : (
                    <div className="focus-preview-text example-focus-render is-empty">输入例句后，这里会直接高亮 focus。</div>
                  )}
                </div>

                {hasSource ? (
                  <div className="example-source-row">
                    <span className="example-source-label">来源</span>
                    {source.url ? (
                      <a href={source.url} target="_blank" rel="noreferrer">{source.text || source.url}</a>
                    ) : (
                      <span>{source.text}</span>
                    )}
                  </div>
                ) : null}

                {hasYoutube ? (
                  <div className="example-source-row">
                    <span className="example-source-label">YouTube</span>
                    <a href={youtubeLink} target="_blank" rel="noreferrer">
                      {formatYouTubeLabel(youtube.timestamp)}
                    </a>
                  </div>
                ) : null}

                <details className="editor-section editor-collapsible-section example-config-section">
                  <summary className="editor-disclosure">
                    <span>来源与跳转</span>
                    <span className="editor-disclosure-meta">
                      {hasExplanation ? '已填解析' : '未填解析'} · {hasSource ? '有来源' : '无来源'} · {hasYoutube ? `YouTube ${formatYouTubeLabel(youtube.timestamp)}` : '无 YouTube'}
                    </span>
                  </summary>

                  <div className="editor-section-body">
                    <label>
                      explanation
                      <textarea
                        className="field textarea"
                        rows={2}
                        value={example.explanation || ''}
                        onChange={(event) => onExampleChange(index, 'explanation', event.target.value)}
                      />
                    </label>

                    <div className="editor-grid">
                      <label>
                        source text
                        <input
                          className="field"
                          value={source.text}
                          onChange={(event) => onExampleChange(index, 'source.text', event.target.value)}
                          placeholder="例: CET6 23 12 1 听力"
                        />
                      </label>

                      <label>
                        source url
                        <input
                          className="field"
                          value={source.url}
                          onChange={(event) => onExampleChange(index, 'source.url', event.target.value)}
                          placeholder="https://..."
                        />
                      </label>
                    </div>

                    <div className="editor-grid">
                      <label>
                        youtube url
                        <input
                          className="field"
                          value={youtube.url}
                          onChange={(event) => onExampleChange(index, 'youtube.url', event.target.value)}
                          placeholder="https://www.youtube.com/watch?v=..."
                        />
                      </label>

                      <label>
                        youtube timestamp 秒
                        <input
                          className="field"
                          type="number"
                          min="0"
                          value={youtube.timestamp}
                          onChange={(event) => onExampleChange(index, 'youtube.timestamp', event.target.value)}
                          placeholder="664"
                        />
                      </label>
                    </div>

                    {youtubeLink ? (
                      <a className="example-jump-link" href={youtubeLink} target="_blank" rel="noreferrer">
                        跳转到 YouTube {formatYouTubeLabel(youtube.timestamp)}
                      </a>
                    ) : null}
                  </div>
                </details>

                <details className="editor-section editor-collapsible-section example-config-section">
                  <summary className="editor-disclosure">
                    <span>Focus 编辑</span>
                    <span className="editor-disclosure-meta">{focusSummary}</span>
                  </summary>

                  <div className="editor-section-body">
                    <div className="editor-grid">
                      <label>
                        focusWords (逗号分隔)
                        <input
                          className="field"
                          value={Array.isArray(example.focusWords) ? example.focusWords.join(', ') : ''}
                          onChange={(event) => onExampleChange(index, 'focusWords', event.target.value)}
                        />
                      </label>

                      <label>
                        focusPositions (逗号分隔)
                        <input
                          className="field"
                          value={normalizeExampleFocusPositions(
                            Array.isArray(example.focusPositions) ? example.focusPositions : [],
                            tokenizeNonSpace(example.text).length,
                          ).join(', ')}
                          onChange={(event) => onExampleChange(index, 'focusPositions', event.target.value)}
                        />
                      </label>
                    </div>

                    <ExampleFocusPicker
                      example={example}
                      index={index}
                      onToggleFocusPosition={onExampleToggleFocusPosition}
                      onClearFocusPositions={onExampleClearFocusPositions}
                      onApplyFocusPositions={onExampleApplyFocusPositions}
                    />
                  </div>
                </details>
              </div>
            );
          })}
        </div>
      </section>

      <details className="editor-section raw-json-section">
        <summary className="editor-disclosure">Raw JSON (高级快速编辑)</summary>

        <textarea
          className="field textarea raw-editor"
          value={rawSource}
          onChange={(event) => {
            const nextRaw = event.target.value;
            setRawText(nextRaw);
            setRawDirty(true);

            try {
              const normalizedRaw = nextRaw.trim();
              if (!normalizedRaw) {
                throw new Error('JSON 不能为空');
              }
              const parsed = JSON.parse(nextRaw);
              setRawError('');
              onReplaceDraft(parsed);
            } catch (error) {
              setRawError(error.message || 'JSON 解析失败');
            }
          }}
        />
        {rawError ? (
          <div className="error">JSON 错误: {rawError}</div>
        ) : (
          <div className="muted">输入合法 JSON 后会自动同步到草稿，再正常保存到 data。</div>
        )}
      </details>

      <div className="editor-footer">
        <button type="button" className="ghost" onClick={onReset} disabled={!dirty || saving}>重置草稿</button>
        <button type="button" className="primary" onClick={onSave} disabled={!dirty || saving}>{saving ? '保存中...' : '保存到 data'}</button>
      </div>
    </div>
  );
}

function OrganizePanel({
  cleanData,
  mergeData,
  draft,
  loading,
  mergeLoading,
  includeLlm,
  setIncludeLlm,
  includeLowConfidence,
  setIncludeLowConfidence,
  includeMergeLlm,
  setIncludeMergeLlm,
  deleteSourceAfterMerge,
  setDeleteSourceAfterMerge,
  onRun,
  onRunMerge,
  onRunAll,
  onApplyLlmSuggestion,
  onApplyEntryRenameAndSave,
  onApplyAllSuggestions,
  onApplyAllAndSave,
  onApplyMerge,
  onApplySplit,
  applyingKey,
  splitApplyingKey,
  renameApplyingKey,
  hasCategory,
  hasDraft,
  savingDraft,
  analyzedFrom,
}) {
  const [editorByKey, setEditorByKey] = useState({});

  const setEditorValue = (key, field, value) => {
    setEditorByKey((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] || {}),
        [field]: value,
      },
    }));
  };

  const getEditorValue = (key, field, fallback = '') => {
    if (editorByKey[key] && field in editorByKey[key]) {
      return editorByKey[key][field];
    }
    return fallback;
  };

  const mergeSuggestions = mergeData?.data?.suggestions || [];
  const currentDefinitions = Array.isArray(draft?.definitions) ? draft.definitions : [];
  const llmEntry = Array.isArray(cleanData?.llm?.entry)
    ? cleanData.llm.entry.filter((item) => isActionableEntrySuggestion(item))
    : [];
  const llmDefinitions = Array.isArray(cleanData?.llm?.definitions)
    ? cleanData.llm.definitions.filter((item) => isActionableDefinitionSuggestion(item))
    : [];
  const llmExamples = Array.isArray(cleanData?.llm?.examples)
    ? cleanData.llm.examples.filter((item) => isActionableExampleSuggestion(item))
    : [];
  const llmNotes = Array.isArray(cleanData?.llm?.global_notes)
    ? cleanData.llm.global_notes.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const autoEntryCount = llmEntry.filter((item) => normalizeLlmAction(item.action) === 'rename').length;
  const totalAutoCount = autoEntryCount + llmDefinitions.length + llmExamples.length;
  const fileSuggestionCount = llmEntry.length + llmDefinitions.length + llmExamples.length;
  const totalSuggestionCount = fileSuggestionCount + mergeSuggestions.length;
  const analysisToken = [
    analyzedFrom,
    cleanData?.file || '',
    cleanData?.heuristic?.word || '',
    llmDefinitions.length,
    llmExamples.length,
    llmEntry.length,
  ].join('|');

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-heading">
          <h3>整理建议</h3>
          <div className="panel-caption">
            {totalSuggestionCount
              ? `文件 ${fileSuggestionCount} 条 · 合并 ${mergeSuggestions.length} 条 · ${totalAutoCount} 条可自动应用`
              : '统一生成文件清洗、词条拆分和词形合并建议'}
          </div>
        </div>
        <span className={`badge ${totalSuggestionCount ? 'high' : 'medium'}`}>{totalSuggestionCount} 条建议</span>
      </div>

      <div className="panel-body list-body">
        <div className="organize-toolbar">
          <div className="organize-actions">
            <button className="primary" onClick={onRunAll} disabled={(loading || mergeLoading) || !hasCategory}>
              {loading || mergeLoading ? '分析中...' : '分析全部'}
            </button>
            <button className="ghost" onClick={onRun} disabled={loading || !hasDraft}>{loading ? '文件中...' : '文件'}</button>
            <button className="ghost" onClick={onRunMerge} disabled={mergeLoading || !hasCategory}>{mergeLoading ? '目录中...' : '目录'}</button>
            <button className="ghost" onClick={onApplyAllAndSave} disabled={!hasDraft || !cleanData || totalAutoCount === 0 || savingDraft}>{savingDraft ? '保存中...' : '应用并保存'}</button>
            <button className="ghost" onClick={onApplyAllSuggestions} disabled={!hasDraft || !cleanData || totalAutoCount === 0}>应用到草稿</button>
          </div>
          <details className="organize-options">
            <summary>选项</summary>
            <div className="organize-option-grid">
              <label className="inline-check">
                <input type="checkbox" checked={includeLlm} onChange={(event) => setIncludeLlm(event.target.checked)} />
                文件 LLM
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={includeMergeLlm}
                  onChange={(event) => setIncludeMergeLlm(event.target.checked)}
                />
                合并 LLM
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={includeLowConfidence}
                  onChange={(event) => setIncludeLowConfidence(event.target.checked)}
                />
                低置信度
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={deleteSourceAfterMerge}
                  onChange={(event) => setDeleteSourceAfterMerge(event.target.checked)}
                />
                删除源文件
              </label>
            </div>
          </details>
        </div>
        <div className="section-title">当前文件清洗</div>
        {!cleanData ? (
          <div className="empty">选择词条后点击“分析当前文件”或“一键分析”。</div>
        ) : (
          <>
            <div className="analysis-source">
              分析基于: {analyzedFrom === 'draft' ? '当前草稿（含未保存修改）' : 'data 中已保存文件'}
            </div>
            {cleanData.llm ? (
              <>
                <div className="section-title">LLM 建议</div>
                {llmEntry.length || llmDefinitions.length || llmExamples.length || llmNotes.length ? (
                  <>
                    {llmEntry.length ? (
                      <>
                        <div className="section-title">Entry</div>
                        <ul>
                          {llmEntry.map((item, index) => {
                            const action = normalizeLlmAction(item.action);
                            const entries = Array.isArray(item.suggested_entries) ? item.suggested_entries : [];
                            const splitActionKey = suggestionItemKey(`entry-split:${analysisToken}`, item, index);
                            const renameActionKey = suggestionItemKey(`entry-rename:${analysisToken}`, item, index);
                            return (
                              <li key={`llm-entry-${index}`}>
                                <div className="row-main between">
                                  <div className="row-main">
                                    <strong>{action}</strong>
                                    <span className="badge medium">{item.confidence ?? 'llm'}</span>
                                  </div>
                                  {action === 'rename' ? (
                                    <div className="suggestion-actions">
                                      <button
                                        className="ghost"
                                        onClick={() => onApplyLlmSuggestion('entry', item)}
                                        disabled={!hasDraft || Boolean(renameApplyingKey)}
                                      >
                                        仅改草稿
                                      </button>
                                      <button
                                        className="primary"
                                        onClick={() => onApplyEntryRenameAndSave(item, renameActionKey)}
                                        disabled={!hasDraft || savingDraft || Boolean(renameApplyingKey)}
                                      >
                                        {renameApplyingKey === renameActionKey ? '重命名中...' : '应用并重命名'}
                                      </button>
                                    </div>
                                  ) : action === 'split' ? (
                                    <button
                                      className="ghost"
                                      onClick={() => onApplySplit(item, splitActionKey)}
                                      disabled={!hasDraft || Boolean(splitApplyingKey)}
                                    >
                                      {splitApplyingKey === splitActionKey ? '拆分中...' : '自动拆分'}
                                    </button>
                                  ) : (
                                    <span className="muted">需手动处理</span>
                                  )}
                                </div>
                                <div className="row-sub">{item.reason || ''}</div>
                                {action === 'rename' ? (
                                  <div className="suggestion-edit">
                                    <div className="row-sub">建议词条</div>
                                    <div className="json-box">{item.suggested_word}</div>
                                  </div>
                                ) : null}
                                {action === 'split' ? (
                                  <div className="suggestion-edit">
                                    <div className="row-sub">建议拆分为</div>
                                    <pre className="json-box">{JSON.stringify(entries, null, 2)}</pre>
                                  </div>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      </>
                    ) : null}

                    {llmDefinitions.length ? (
                      <>
                        <div className="section-title">Definitions</div>
                        <ul>
                          {llmDefinitions.map((item, index) => (
                            <li key={`llm-def-${index}`}>
                              {(() => {
                                const action = normalizeLlmAction(item.action);
                                const itemIndex = parseIndex(item.index);
                                const itemKey = suggestionItemKey(`llm-def:${analysisToken}`, item, index);
                                const editorField = action === 'replace_all' ? 'suggested_definitions' : 'suggested';
                                const editedValue = getEditorValue(
                                  itemKey,
                                  editorField,
                                  getDefinitionSuggestionEditorValue(item),
                                );
                                const patched = patchDefinitionSuggestionFromEditor(item, editedValue);
                                const currentDefinition = itemIndex !== null && itemIndex < currentDefinitions.length
                                  ? String(currentDefinitions[itemIndex] || '').trim()
                                  : '';
                                const showEditor = action !== 'drop';
                                const suggestionLabel = action === 'append'
                                  ? '将追加到 Definitions 末尾'
                                  : action === 'replace_all'
                                    ? '将整体替换当前 Definitions'
                                    : itemIndex !== null
                                      ? `当前 #${itemIndex}: ${currentDefinition || '(空释义)'}`
                                      : '目标释义';

                                return (
                                  <>
                                    <div className="row-main between">
                                      <div className="row-main">
                                        <strong>{itemIndex !== null ? `#${itemIndex}` : 'new'}</strong>
                                        <span className="badge medium">{action}</span>
                                      </div>
                                      <button
                                        className="ghost"
                                        onClick={() => onApplyLlmSuggestion('definition', patched)}
                                        disabled={!hasDraft}
                                      >
                                        应用此条
                                      </button>
                                    </div>
                                    <div className="row-sub">{item.reason || ''}</div>
                                    <div className="row-sub">{suggestionLabel}</div>
                                    {showEditor ? (
                                      <div className="suggestion-edit">
                                        <div className="row-sub">
                                          {action === 'replace_all' ? '可编辑建议释义列表（每行一条）' : '可编辑建议释义'}
                                        </div>
                                        <textarea
                                          className="field textarea suggestion-input"
                                          rows={action === 'replace_all' ? 4 : 2}
                                          value={editedValue}
                                          onChange={(event) => setEditorValue(itemKey, editorField, event.target.value)}
                                        />
                                      </div>
                                    ) : null}
                                  </>
                                );
                              })()}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}

                    {llmExamples.length ? (
                      <>
                        <div className="section-title">Examples</div>
                        <ul>
                          {llmExamples.map((item, index) => (
                            <li key={`llm-ex-${index}`}>
                              {(() => {
                                const itemKey = suggestionItemKey(`llm-ex:${analysisToken}`, item, index);
                                const suggestedText = getEditorValue(itemKey, 'suggested_text', String(item.suggested_text || ''));
                                const suggestedExplanation = getEditorValue(itemKey, 'suggested_explanation', String(item.suggested_explanation || ''));
                                const patched = {
                                  ...item,
                                  suggested_text: suggestedText,
                                  suggested_explanation: suggestedExplanation,
                                };

                                return (
                                  <>
                                    <div className="row-main between">
                                      <div className="row-main">
                                        <strong>#{item.index}</strong>
                                        <span className="badge medium">{normalizeLlmAction(item.action)}</span>
                                      </div>
                                      <button
                                        className="ghost"
                                        onClick={() => onApplyLlmSuggestion('example', patched)}
                                        disabled={!hasDraft}
                                      >
                                        应用此条
                                      </button>
                                    </div>
                                    <div className="row-sub">{item.reason || ''}</div>
                                    <div className="suggestion-edit">
                                      <div className="row-sub">可编辑建议 text</div>
                                      <textarea
                                        className="field textarea suggestion-input"
                                        rows={2}
                                        value={suggestedText}
                                        onChange={(event) => setEditorValue(itemKey, 'suggested_text', event.target.value)}
                                      />
                                      <div className="row-sub">可编辑建议 explanation</div>
                                      <textarea
                                        className="field textarea suggestion-input"
                                        rows={2}
                                        value={suggestedExplanation}
                                        onChange={(event) => setEditorValue(itemKey, 'suggested_explanation', event.target.value)}
                                      />
                                    </div>
                                  </>
                                );
                              })()}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}

                    {llmNotes.length ? (
                      <>
                        <div className="section-title">Global Notes</div>
                        <ul>
                          {llmNotes.map((item, index) => (
                            <li key={`llm-note-${index}`}>
                              <div className="row-sub">{item}</div>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </>
                ) : (
                  <div className="muted">LLM 未返回额外可执行建议。</div>
                )}

                <details className="llm-raw">
                  <summary>查看原始 LLM JSON</summary>
                  <pre className="json-box">{JSON.stringify(cleanData.llm, null, 2)}</pre>
                </details>
              </>
            ) : null}

            {cleanData.llm_error ? <div className="error">LLM 建议失败: {cleanData.llm_error}</div> : null}
          </>
        )}

        <div className="organize-divider" />
        <div className="section-title">词形合并建议 ({mergeSuggestions.length})</div>
        {!mergeSuggestions.length ? (
          <div className="empty">点击“扫描目录合并”或“一键分析”生成目录级合并建议。</div>
        ) : (
          <ul>
            {mergeSuggestions.map((item, index) => {
              const actionKey = `${item.source.file}->${item.target.file}`;
              const applying = applyingKey === actionKey;
              const createTarget = Boolean(item.create_target_if_missing || item?.target?.exists === false);

              return (
                <li key={`merge-${index}`}>
                  <div className="row-main between merge-row">
                    <div className="row-main merge-main">
                      <strong>{item.source.word}</strong>
                      <span className="arrow">→</span>
                      <strong>{item.target.word}</strong>
                      <span className={`badge ${item.confidence_level}`}>{item.confidence_level}</span>
                      {item.source_model ? <span className="badge medium">{item.source_model}</span> : null}
                      {createTarget ? <span className="badge medium">new</span> : null}
                    </div>
                    <button className="ghost" onClick={() => onApplyMerge(item)} disabled={applying}>
                      {applying ? '处理中...' : createTarget ? '新建并合并' : '执行合并'}
                    </button>
                  </div>
                  <div className="row-sub merge-path">{item.source.file} → {item.target.file}</div>
                  <div className="row-sub merge-reason">{item.reason} | 置信度 {item.confidence}</div>
                </li>
              );
            })}
          </ul>
        )}
        {mergeData?.llm_error ? <div className="error">LLM 合并建议失败: {mergeData.llm_error}</div> : null}
      </div>
    </div>
  );
}

function ReviewPanel({ reviewData, loading, reviewDate, setReviewDate, onRefresh, onScore }) {
  const before = reviewData?.before;
  const after = reviewData?.after;
  const hasRecordedReview = Boolean(reviewData?.recorded_review && after);
  const current = hasRecordedReview ? after : before;

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-heading">
          <h3>复习建议与熟练度评分</h3>
          <div className="panel-caption">{current ? `${current.status} · 下次 ${current.next_review_date}` : '查看复习状态并直接记录本次熟练度评分'}</div>
        </div>
        <span className={`badge ${current ? 'high' : 'medium'}`}>{current?.review_count || 0} 次</span>
      </div>

      <div className="panel-body">
        <div className="panel-toolbar">
          <input type="date" value={reviewDate} onChange={(event) => setReviewDate(event.target.value)} />
          <button className="ghost" onClick={onRefresh} disabled={loading}>{loading ? '刷新中...' : '刷新建议'}</button>
        </div>
        {!current ? (
          <div className="empty">选择词条后可查看复习建议。</div>
        ) : (
          <>
            {hasRecordedReview ? (
              <div className="analysis-source">当前展示的是本次熟练度评分后的最新复习计划。</div>
            ) : null}
            <div className="status-grid">
              <div>
                <div className="card-title">当前状态</div>
                <div className="card-main">{current.status}</div>
                <div className="card-sub">{current.message}</div>
              </div>

              <div>
                <div className="card-title">预测下次复习</div>
                <div className="card-main">{current.next_review_date}</div>
                <div className="card-sub">剩余 {current.days_until_due} 天</div>
              </div>

              <div>
                <div className="card-title">最近一次熟练度记录</div>
                <div className="card-main">{current.last_review ? `${current.last_review.date} / ${formatScoreSummary(current.last_review.score)}` : '无'}</div>
                <div className="card-sub">累计 {current.review_count} 次</div>
              </div>
            </div>

            <div className="section-title">本次熟练度评分</div>
            <div className="score-grid">
              {[0, 1, 2, 3, 4, 5].map((score) => (
                <button key={score} className="score-btn" onClick={() => onScore(score)} disabled={loading}>
                  <strong>{score}</strong>
                  <span>{scoreLabels[score]}</span>
                </button>
              ))}
            </div>

            {after && reviewData?.recorded_review ? (
              <div className="after-box">
                已记录 {reviewData.recorded_review.date} 熟练度 {formatScoreSummary(reviewData.recorded_review.score)}，
                下次建议 {after.next_review_date}。
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function ModeSwitch({ mode, onChange }) {
  return (
    <div className="mode-switch" role="tablist" aria-label="工作模式">
      <button
        type="button"
        className={`mode-chip ${mode === 'manual' ? 'active' : ''}`}
        onClick={() => onChange('manual')}
      >
        手动选取
      </button>
      <button
        type="button"
        className={`mode-chip ${mode === 'recommend' ? 'active' : ''}`}
        onClick={() => onChange('recommend')}
      >
        推荐推送
      </button>
    </div>
  );
}

function ManualSelectionPanel({
  categories,
  category,
  filename,
  entries,
  filteredEntries,
  entryFilter,
  filterCounts,
  fileQuery,
  setFileQuery,
  loadingCategories,
  loadingFiles,
  onEntryFilterChange,
  onCategorySelect,
  onFilenameSelect,
}) {
  return (
    <div className="panel sidebar-panel manual-selection-panel">
      <div className="panel-header">
        <h3>手动选择</h3>
        <span className="badge high">{entries.length} files</span>
      </div>

      <div className="panel-body sidebar-section category-section">
        <div className="section-title">目录</div>
        <div className="nav-list nav-list-scroll category-list-scroll">
          {loadingCategories ? <div className="empty">目录加载中...</div> : null}
          {!loadingCategories && !categories.length ? <div className="empty">还没有可用目录。</div> : null}
          {categories.map((item) => (
            <button
              key={item}
              type="button"
              className={`nav-item ${item === category ? 'active' : ''}`}
              onClick={() => onCategorySelect(item)}
            >
              <span>{item}</span>
              {item === category ? <span className="nav-state">当前</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="panel-body sidebar-section sidebar-fill file-section">
        <div className="section-title">文件</div>
        <label>
          筛选词条
          <input
            className="field"
            placeholder="输入文件名或单词"
            value={fileQuery}
            onChange={(event) => setFileQuery(event.target.value)}
            disabled={loadingFiles}
          />
        </label>

        <div className="recommend-actions">
          {ENTRY_FILTER_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={entryFilter === option.value ? 'primary' : 'ghost'}
              onClick={() => onEntryFilterChange(option.value)}
              disabled={loadingFiles}
            >
              {option.label} {filterCounts[option.value]}
            </button>
          ))}
        </div>

        <div className="file-list-meta">
          <span>{loadingFiles ? '词条加载中...' : category ? `${filteredEntries.length} / ${entries.length} 条` : '先选目录'}</span>
          {fileQuery.trim() ? <span>过滤: {fileQuery.trim()}</span> : null}
        </div>

        <div className="nav-list nav-list-scroll">
          {!loadingFiles && !category ? <div className="empty">先选择目录，再查看词条列表。</div> : null}
          {!loadingFiles && category && !filteredEntries.length ? <div className="empty">没有匹配的词条。</div> : null}
          {filteredEntries.map((item) => (
            <button
              key={item.file}
              type="button"
              className={`nav-item ${item.file === filename ? 'active' : ''}`}
              onClick={() => onFilenameSelect(item.file)}
            >
              <span className="nav-main">{item.word}</span>
              <span className="nav-sub">
                {item.file}
                {item.marked ? ' · 已标记' : ''}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function RecommendationModePanel({
  categories,
  scope,
  onScopeChange,
  preferences,
  onPreferencesChange,
  recommendation,
  alternatives,
  meta,
  loading,
  onPush,
  onNext,
  onUse,
  savingPreferences,
}) {
  const current = recommendation;
  const status = current?.advice?.status || '';
  const normalizedPreferences = normalizeRecommendationPreferences(preferences);

  const updateWeight = (key, value) => {
    const number = Number(value);
    onPreferencesChange({ [key]: Number.isFinite(number) ? number : DEFAULT_RECOMMENDATION_PREFERENCES[key] });
  };

  const updateChoice = (key, value) => {
    onPreferencesChange({ [key]: value });
  };

  return (
    <div className="panel sidebar-panel">
      <div className="panel-header">
        <h3>推荐模式</h3>
        <span className={`badge ${status === 'overdue' || status === 'due_today' ? 'medium' : 'high'}`}>
          {current?.advice?.status || 'idle'}
        </span>
      </div>

      <div className="panel-body sidebar-section">
        <label>
          推荐范围
          <select value={scope} onChange={(event) => onScopeChange(event.target.value)}>
            <option value={ALL_SCOPE}>全部目录</option>
            {categories.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>

        <details className="recommend-tuning">
          <summary className="recommend-tuning-summary">
            <span>
              <span className="section-title">算法偏好</span>
              <span>
                {formatRecommendationPreferenceSummary(normalizedPreferences)}
                {savingPreferences ? ' · 保存中' : ''}
              </span>
            </span>
          </summary>

          <div className="recommend-tuning-body">
            <div className="recommend-segment-group">
              <div className="recommend-segment-label">创建时间</div>
              <div className="recommend-segment" role="group" aria-label="创建时间方向">
                <button
                  type="button"
                  className={normalizedPreferences.created_order === 'recent' ? 'active' : ''}
                  onClick={() => updateChoice('created_order', 'recent')}
                  disabled={loading}
                >
                  最近加入
                </button>
                <button
                  type="button"
                  className={normalizedPreferences.created_order === 'oldest' ? 'active' : ''}
                  onClick={() => updateChoice('created_order', 'oldest')}
                  disabled={loading}
                >
                  最早加入
                </button>
              </div>
            </div>

            <div className="recommend-segment-group">
              <div className="recommend-segment-label">最近评分</div>
              <div className="recommend-segment" role="group" aria-label="评分方向">
                <button
                  type="button"
                  className={normalizedPreferences.score_order === 'low' ? 'active' : ''}
                  onClick={() => updateChoice('score_order', 'low')}
                  disabled={loading}
                >
                  低分/未记录
                </button>
                <button
                  type="button"
                  className={normalizedPreferences.score_order === 'high' ? 'active' : ''}
                  onClick={() => updateChoice('score_order', 'high')}
                  disabled={loading}
                >
                  高分
                </button>
              </div>
            </div>
          </div>

          <div className="recommend-weight-list">
            {RECOMMENDATION_WEIGHT_OPTIONS.map((option) => (
              <label key={option.key} className="recommend-weight-row">
                <span className="recommend-weight-head">
                  <strong>{option.label}</strong>
                  <output>{normalizedPreferences[option.key].toFixed(2)}</output>
                </span>
                <span className="recommend-weight-help">{option.description}</span>
                <input
                  type="range"
                  min="0"
                  max="5"
                  step="0.05"
                  value={normalizedPreferences[option.key]}
                  onChange={(event) => updateWeight(option.key, event.target.value)}
                  disabled={loading}
                />
              </label>
            ))}
          </div>

          <button
            type="button"
            className="ghost recommend-reset-button"
            onClick={() => onPreferencesChange(DEFAULT_RECOMMENDATION_PREFERENCES)}
            disabled={loading}
          >
            重置默认权重
          </button>
        </details>

        <div className="recommend-actions">
          <button type="button" className="primary" onClick={onPush} disabled={loading}>
            {loading ? '计算中...' : '推送一个词'}
          </button>
          <button type="button" className="ghost" onClick={onNext} disabled={loading || !current}>
            换一个
          </button>
        </div>

        {meta ? (
          <div className="muted">
            已扫描 {meta.scanned_files} 个文件，候选 {meta.candidate_count} 个。
            <br />
            {formatRecommendationPreferenceSummary(meta.preferences || normalizedPreferences)}
          </div>
        ) : null}

        {!current ? (
          <div className="empty">点击“推送一个词”，系统会按复习优先级帮你挑一个目标。</div>
        ) : (
          <div
            className="recommend-card recommend-card-action"
            role="button"
            tabIndex={0}
            onClick={() => onUse(current)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onUse(current);
              }
            }}
          >
            <div className="recommend-kicker">系统推荐</div>
            <div className="recommend-word">{current.word}</div>
            <div className="recommend-path">{formatCategoryLabel(current.category)} / {current.file}</div>
            <div className="recommend-badges">
              <span className="stat-pill"><strong>{current.priority_score}</strong> priority</span>
              <span className="stat-pill"><strong>{current.advice?.next_review_date || '--'}</strong> 下次复习</span>
              <span className="stat-pill"><strong>{current.score_breakdown?.last_score ?? '无'}</strong> 最近评分</span>
            </div>
            <div className="recommend-breakdown">
              <span>到期 {current.score_breakdown?.weighted?.due ?? '--'}</span>
              <span>创建 {current.score_breakdown?.weighted?.created ?? '--'}</span>
              <span>评分 {current.score_breakdown?.weighted?.score ?? '--'}</span>
            </div>
            <p className="selection-sub">{current.reason}</p>
          </div>
        )}

        {alternatives.length ? (
          <>
            <div className="section-title">备选词条</div>
            <div className="nav-list">
              {alternatives.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="nav-item"
                  onClick={() => onUse(item)}
                >
                  <span className="nav-main">{item.word}</span>
                  <span className="nav-sub">{formatCategoryLabel(item.category)} / {item.file}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function App({ embedded = false, onOpenConfig = null, launchRequest = null }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mode, setMode] = useState('manual');
  const [selectionSource, setSelectionSource] = useState('manual');

  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState(() => normalizeCategoryValue(localStorage.getItem('defaultCategory') || ''));
  const [entries, setEntries] = useState([]);
  const [filename, setFilename] = useState('');
  const [fileQuery, setFileQuery] = useState('');
  const [entryFilter, setEntryFilter] = useState('marked');

  const [recommendScope, setRecommendScope] = useState(ALL_SCOPE);
  const [recommendation, setRecommendation] = useState(null);
  const [recommendAlternatives, setRecommendAlternatives] = useState([]);
  const [recommendMeta, setRecommendMeta] = useState(null);
  const [recommendExcludeKeys, setRecommendExcludeKeys] = useState([]);
  const [recommendPreferences, setRecommendPreferences] = useState(() => (
    normalizeRecommendationPreferences(DEFAULT_RECOMMENDATION_PREFERENCES)
  ));
  const [recommendPreferencesReady, setRecommendPreferencesReady] = useState(false);
  const [savingRecommendPreferences, setSavingRecommendPreferences] = useState(false);

  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftDirty, setDraftDirty] = useState(false);

  const [mergeData, setMergeData] = useState(null);
  const [cleanData, setCleanData] = useState(null);
  const [reviewData, setReviewData] = useState(null);

  const [includeLowConfidence, setIncludeLowConfidence] = useState(false);
  const [deleteSourceAfterMerge, setDeleteSourceAfterMerge] = useState(true);
  const [includeMergeLlm, setIncludeMergeLlm] = useState(true);
  const [includeLlm, setIncludeLlm] = useState(true);
  const [reviewDate, setReviewDate] = useState(TODAY);
  const [editorSyncToken, setEditorSyncToken] = useState(0);

  const [loadingCategories, setLoadingCategories] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingRecommendation, setLoadingRecommendation] = useState(false);
  const [loadingMerge, setLoadingMerge] = useState(false);
  const [loadingClean, setLoadingClean] = useState(false);
  const [loadingReview, setLoadingReview] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [savingMarked, setSavingMarked] = useState(false);
  const [mergeApplyingKey, setMergeApplyingKey] = useState('');
  const [splitApplyingKey, setSplitApplyingKey] = useState('');
  const [renameApplyingKey, setRenameApplyingKey] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [ttsVoiceLabel, setTtsVoiceLabel] = useState('');
  const pendingSelectionRef = useRef({ category: '', filename: '' });
  const speechRequestRef = useRef(0);
  const recommendPreferenceHydratedRef = useRef(false);
  const savedRecommendPreferenceKeyRef = useRef('');
  const recommendPreferenceSaveTimerRef = useRef(null);
  const cleanPanelRef = useRef(null);
  const reviewPanelRef = useRef(null);

  const deferredFileQuery = useDeferredValue(fileQuery);
  const hasSelection = Boolean(category && filename);
  const apiCategory = toApiCategory(category);

  const filterCounts = useMemo(() => ({
    marked: entries.filter((item) => item.marked).length,
    all: entries.length,
    unmarked: entries.filter((item) => !item.marked).length,
  }), [entries]);

  const normalizedRecommendPreferences = useMemo(
    () => normalizeRecommendationPreferences(recommendPreferences),
    [recommendPreferences],
  );

  const filteredEntries = useMemo(() => {
    const filteredByMark = entries.filter((item) => {
      if (entryFilter === 'marked') return item.marked;
      if (entryFilter === 'unmarked') return !item.marked;
      return true;
    });
    const query = deferredFileQuery.trim().toLowerCase();
    if (!query) return filteredByMark;
    return filteredByMark.filter((item) => {
      const normalizedFile = item.file.toLowerCase();
      const normalizedWord = item.word.toLowerCase();
      return normalizedFile.includes(query) || normalizedWord.includes(query);
    });
  }, [deferredFileQuery, entries, entryFilter]);

  const activeWord = useMemo(() => {
    if (!hasSelection) return '';
    return String(draft?.word || detail?.word || filename.replace(/\.json$/i, '')).trim();
  }, [detail, draft, filename, hasSelection]);
  const currentMarked = Boolean(draft?.marked ?? detail?.marked);
  const youdaoUrl = useMemo(() => buildYoudaoUrl(activeWord), [activeWord]);

  const ttsSupported = typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function';

  const showNotice = (message) => {
    setError('');
    setNotice(message);
  };

  const showError = (message) => {
    setNotice('');
    setError(message);
  };

  const hydrateDetailAndDraft = (data) => {
    const normalized = deepClone(data || null);
    setDetail(normalized);
    setDraft(normalized);
    setDraftDirty(false);
    setEditorSyncToken((prev) => prev + 1);
  };

  const resetEntryState = () => {
    setDetail(null);
    setDraft(null);
    setDraftDirty(false);
    setCleanData(null);
    setReviewData(null);
  };

  const updateDraft = (updater) => {
    setDraft((prev) => {
      const base = deepClone(prev || {});
      const next = updater(base) || base;
      return next;
    });
    setDraftDirty(true);
  };

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(''), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(''), 5600);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (!draftDirty) return undefined;

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [draftDirty]);

  useEffect(() => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    return () => {
      if (synth) synth.cancel();
      if (recommendPreferenceSaveTimerRef.current) {
        window.clearTimeout(recommendPreferenceSaveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetchConfig()
      .then((config) => {
        if (cancelled) return;
        const nextPreferences = recommendationPreferencesFromConfig(config || {});
        savedRecommendPreferenceKeyRef.current = recommendationPreferencesKey(nextPreferences);
        setRecommendPreferences(nextPreferences);
      })
      .catch((err) => {
        if (!cancelled) {
          showError(`读取推荐偏好失败: ${err.message}`);
        }
      })
      .finally(() => {
        if (cancelled) return;
        recommendPreferenceHydratedRef.current = true;
        setRecommendPreferencesReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!recommendPreferencesReady || !recommendPreferenceHydratedRef.current) return undefined;

    const currentKey = recommendationPreferencesKey(normalizedRecommendPreferences);
    if (currentKey === savedRecommendPreferenceKeyRef.current) {
      return undefined;
    }

    if (recommendPreferenceSaveTimerRef.current) {
      window.clearTimeout(recommendPreferenceSaveTimerRef.current);
    }

    recommendPreferenceSaveTimerRef.current = window.setTimeout(() => {
      setSavingRecommendPreferences(true);
      saveConfig(recommendationPreferencesToConfig(normalizedRecommendPreferences))
        .then((res) => {
          const nextConfig = res?.data || {};
          const nextPreferences = recommendationPreferencesFromConfig(nextConfig);
          savedRecommendPreferenceKeyRef.current = recommendationPreferencesKey(nextPreferences);
          setRecommendPreferences(nextPreferences);
          window.dispatchEvent(new Event('config-updated'));
        })
        .catch((err) => {
          showError(`保存推荐偏好失败: ${err.message}`);
        })
        .finally(() => {
          setSavingRecommendPreferences(false);
        });
    }, 420);

    return () => {
      if (recommendPreferenceSaveTimerRef.current) {
        window.clearTimeout(recommendPreferenceSaveTimerRef.current);
      }
    };
  }, [normalizedRecommendPreferences, recommendPreferencesReady]);

  useEffect(() => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    speechRequestRef.current += 1;
    setTtsVoiceLabel('');
    if (synth) synth.cancel();
  }, [activeWord]);

  const confirmDiscardDraft = () => {
    if (!draftDirty) return true;
    return window.confirm('当前草稿有未保存修改，继续切换会丢失这些更改。确定继续吗？');
  };

  const selectEntry = (nextCategory, nextFilename, source = 'manual') => {
    const normalizedCategory = normalizeCategoryValue(nextCategory);
    const normalizedFilename = normalizeFilename(nextFilename);
    const changingCategory = normalizedCategory !== category;
    const changingFile = Boolean(normalizedFilename && normalizedFilename !== filename);

    if ((changingCategory || changingFile) && !confirmDiscardDraft()) {
      return false;
    }

    setSelectionSource(source);
    if (changingCategory) {
      pendingSelectionRef.current = {
        category: normalizedCategory,
        filename: normalizedFilename,
      };
      setFilename('');
      setCategory(normalizedCategory);
      return true;
    }

    if (changingFile) {
      pendingSelectionRef.current = {
        category: normalizedCategory,
        filename: normalizedFilename,
      };
      setFilename(normalizedFilename);
      return true;
    }

    return false;
  };

  const handleLaunchRequest = useEffectEvent((request) => {
    const nextCategory = normalizeCategoryValue(request?.category);
    const nextFilename = normalizeFilename(request?.filename);
    if (!nextFilename) return null;

    setMode('manual');
    setFileQuery('');

    const isSameEntry = nextCategory === category && nextFilename === filename;
    const changed = selectEntry(nextCategory, nextFilename, 'manual');
    if (!changed && !isSameEntry) {
      return null;
    }

    return window.setTimeout(() => {
      scrollToFocusPanel(request?.focus === 'review' ? 'review' : 'clean');
    }, changed ? 220 : 60);
  });

  const applyRecommendationResult = (res) => {
    setRecommendation(res?.recommended || null);
    setRecommendAlternatives(res?.alternatives || []);
    setRecommendMeta(res?.meta || null);
    return res?.recommended || null;
  };

  const requestRecommendation = async (excludeKeys = []) => {
    setLoadingRecommendation(true);
    try {
      setError('');
      const res = await fetchRecommendedWord(
        recommendScope === ALL_SCOPE ? '' : recommendScope,
        excludeKeys,
        6,
        normalizedRecommendPreferences,
      );
      const recommended = applyRecommendationResult(res);
      if (!recommended) {
        showNotice('当前范围没有可推荐的词条');
      }
      return res;
    } catch (err) {
      showError(err.message);
      return null;
    } finally {
      setLoadingRecommendation(false);
    }
  };

  useEffect(() => {
    setLoadingCategories(true);
    fetchCategories()
      .then((res) => {
        const list = res.categories || [];
        setCategories(list);
        setCategory((prev) => {
          if (prev && list.includes(prev)) {
            return prev;
          }
          return '';
        });
        setRecommendScope((prev) => (prev !== ALL_SCOPE && !list.includes(prev) ? ALL_SCOPE : prev));
      })
      .catch((err) => showError(err.message))
      .finally(() => setLoadingCategories(false));
  }, []);

  useEffect(() => {
    let cancelled = false;

    setEntries([]);
    setFilename('');
    setMergeData(null);
    resetEntryState();
    setLoadingFiles(false);

    if (!apiCategory) {
      return () => {
        cancelled = true;
      };
    }

    setLoadingFiles(true);

    fetchFiles(apiCategory)
      .then((res) => {
        if (cancelled) return;
        const list = (Array.isArray(res?.entries) && res.entries.length
          ? res.entries
          : (res.files || []).map((item) => ({ file: item, word: item.replace(/\.json$/i, ''), marked: false })))
          .map((item) => normalizeManualEntry(item))
          .filter((item) => item.file);
        const filenames = list.map((item) => item.file);
        let nextFilename = '';
        setEntries(list);
        const pendingSelection = pendingSelectionRef.current;
        if (pendingSelection.category === apiCategory && pendingSelection.filename && filenames.includes(pendingSelection.filename)) {
          nextFilename = pendingSelection.filename;
        }
        if (pendingSelection.category === apiCategory) {
          pendingSelectionRef.current = { category: apiCategory, filename: '' };
        }
        if (nextFilename) {
          setFilename(nextFilename);
        }
      })
      .catch((err) => {
        if (!cancelled) showError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingFiles(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiCategory, category]);

  useEffect(() => {
    if (mode !== 'recommend' || !categories.length) return undefined;

    let cancelled = false;
    setRecommendation(null);
    setRecommendAlternatives([]);
    setRecommendMeta(null);
    setRecommendExcludeKeys([]);

    const run = async () => {
      setLoadingRecommendation(true);
      try {
        setError('');
        const res = await fetchRecommendedWord(
          recommendScope === ALL_SCOPE ? '' : recommendScope,
          [],
          6,
          normalizedRecommendPreferences,
        );
        if (cancelled) return;
        const recommended = applyRecommendationResult(res);
        if (!recommended) {
          showNotice('当前范围没有可推荐的词条');
        }
      } catch (err) {
        if (!cancelled) {
          showError(err.message);
        }
      } finally {
        if (!cancelled) {
          setLoadingRecommendation(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [categories.length, mode, recommendScope, normalizedRecommendPreferences]);

  useEffect(() => {
    if (!hasSelection) return undefined;

    let cancelled = false;
    resetEntryState();

    Promise.all([
      fetchVocabDetail(apiCategory, filename),
      getReviewAdvice(apiCategory, filename),
    ])
      .then(([detailRes, reviewRes]) => {
        if (cancelled) return;
        hydrateDetailAndDraft(detailRes.data || null);
        setReviewData(reviewRes || null);
      })
      .catch((err) => {
        if (!cancelled) showError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [apiCategory, category, filename, hasSelection]);

  useEffect(() => {
    if (!launchRequest?.filename) return undefined;

    const timer = handleLaunchRequest(launchRequest);
    if (timer === null) return undefined;
    return () => window.clearTimeout(timer);
  }, [launchRequest]);

  const handleCategorySelect = (nextCategory) => {
    if (!selectEntry(nextCategory, '', 'manual')) return;
    setFileQuery('');
  };

  const handleFilenameSelect = (nextFilename) => {
    void selectEntry(category, nextFilename, 'manual');
  };

  const handleRecommendScopeChange = (nextScope) => {
    setRecommendScope(nextScope);
    setRecommendation(null);
    setRecommendAlternatives([]);
    setRecommendMeta(null);
    setRecommendExcludeKeys([]);
  };

  const handleRecommendPreferencesChange = (patch) => {
    setRecommendPreferences((prev) => normalizeRecommendationPreferences({
      ...prev,
      ...(patch || {}),
    }));
    setRecommendation(null);
    setRecommendAlternatives([]);
    setRecommendMeta(null);
    setRecommendExcludeKeys([]);
  };

  const handleRecommendRefresh = async () => {
    setRecommendExcludeKeys([]);
    const res = await requestRecommendation([]);
    if (res?.recommended) {
      handleUseRecommendation(res.recommended);
    }
  };

  const handleRecommendNext = async () => {
    const nextExcluded = [...new Set([...recommendExcludeKeys, recommendation?.key].filter(Boolean))];
    setRecommendExcludeKeys(nextExcluded);
    const res = await requestRecommendation(nextExcluded);
    if (res?.recommended) {
      handleUseRecommendation(res.recommended);
    }
  };

  const handleUseRecommendation = (item) => {
    if (!item?.file) return;
    const changed = selectEntry(item.category ?? '', item.file, 'recommendation');
    if (changed) {
      showNotice(`已载入推荐词条 ${item.word}`);
    }
  };

  const refreshFiles = async () => {
    if (!apiCategory) {
      setEntries([]);
      setFilename('');
      resetEntryState();
      showError('先选择目录，再刷新词条列表');
      return;
    }

    setLoadingFiles(true);
    try {
      const res = await fetchFiles(apiCategory);
      const list = (Array.isArray(res?.entries) && res.entries.length
        ? res.entries
        : (res.files || []).map((item) => ({ file: item, word: item.replace(/\.json$/i, ''), marked: false })))
        .map((item) => normalizeManualEntry(item))
        .filter((item) => item.file);
      const filenames = list.map((item) => item.file);
      setEntries(list);

      if (!list.length) {
        setFilename('');
        resetEntryState();
        return;
      }

      if (filename && !filenames.includes(filename)) {
        const pending = pendingSelectionRef.current;
        if (pending.category === apiCategory && pending.filename && filenames.includes(pending.filename)) {
          setFilename(pending.filename);
          pendingSelectionRef.current = { category: apiCategory, filename: '' };
        } else {
          setFilename('');
          resetEntryState();
        }
      }
    } catch (err) {
      showError(err.message);
    } finally {
      setLoadingFiles(false);
    }
  };

  const handleMerge = async () => {
    if (!apiCategory) {
      showError('先选择目录，再分析目录');
      return;
    }

    setLoadingMerge(true);
    try {
      setError('');
      const res = await runFolderRefine(apiCategory, includeLowConfidence, includeMergeLlm);
      setMergeData(res);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoadingMerge(false);
    }
  };

  const handleApplyMerge = async (item) => {
    if (!item?.source?.file || !item?.target?.file) return;

    const sourceFile = item.source.file;
    const targetFile = item.target.file;
    const createTargetIfMissing = Boolean(item.create_target_if_missing || item?.target?.exists === false);
    const actionKey = `${sourceFile}->${targetFile}`;

    setMergeApplyingKey(actionKey);
    try {
      setError('');
      const mergeApplyRes = await applyMergeSuggestion(
        apiCategory,
        sourceFile,
        targetFile,
        deleteSourceAfterMerge,
        createTargetIfMissing,
      );

      setMergeData((prev) => {
        if (!prev?.data || !Array.isArray(prev?.data?.suggestions)) {
          return prev;
        }
        const nextSuggestions = prev.data.suggestions.filter((candidate) => {
          const candidateSourceFile = candidate?.source?.file || '';
          const candidateKey = `${candidate?.source?.file || ''}->${candidate?.target?.file || ''}`;
          if (candidateKey === actionKey) return false;
          if (candidateSourceFile === sourceFile) return false;
          return true;
        });
        return {
          ...prev,
          data: {
            ...prev.data,
            suggestions: nextSuggestions,
          },
        };
      });

      void refreshFiles();

      if (deleteSourceAfterMerge && filename === sourceFile) {
        setFilename(targetFile);
      }

      if (filename === targetFile) {
        void Promise.all([
          fetchVocabDetail(apiCategory, targetFile),
          getReviewAdvice(apiCategory, targetFile),
        ])
          .then(([detailRes, reviewRes]) => {
            hydrateDetailAndDraft(detailRes.data || null);
            setReviewData(reviewRes || null);
          })
          .catch((err) => showError(err.message));
      }

      if (mergeApplyRes?.target_created) {
        showNotice(`已新建并合并: ${sourceFile} → ${targetFile}`);
      } else {
        showNotice(`已执行合并: ${sourceFile} → ${targetFile}`);
      }
    } catch (err) {
      showError(err.message);
    } finally {
      setMergeApplyingKey('');
    }
  };

  const handleClean = async () => {
    if (!hasSelection) return;

    setLoadingClean(true);
    try {
      setError('');
      const analysisDraft = draft ? sanitizeDraftForSave(draft, filename.replace(/\.json$/i, '')) : null;
      const res = await runFileRefine(apiCategory, filename, includeLlm, analysisDraft);
      setCleanData(res);
      if (res?.analyzed_from === 'draft') {
        showNotice('已基于当前草稿生成清洗建议');
      }
    } catch (err) {
      showError(err.message);
    } finally {
      setLoadingClean(false);
    }
  };

  const handleOrganize = async () => {
    if (!apiCategory) {
      showError('先选择目录，再生成整理建议');
      return;
    }

    const shouldAnalyzeFile = Boolean(hasSelection);
    setLoadingMerge(true);
    if (shouldAnalyzeFile) {
      setLoadingClean(true);
    }

    try {
      setError('');
      const jobs = [
        runFolderRefine(apiCategory, includeLowConfidence, includeMergeLlm),
      ];

      if (shouldAnalyzeFile) {
        const analysisDraft = draft ? sanitizeDraftForSave(draft, filename.replace(/\.json$/i, '')) : null;
        jobs.unshift(runFileRefine(apiCategory, filename, includeLlm, analysisDraft));
      }

      const results = await Promise.allSettled(jobs);
      const errors = [];
      let folderIndex = 0;

      if (shouldAnalyzeFile) {
        const fileResult = results[0];
        folderIndex = 1;
        if (fileResult.status === 'fulfilled') {
          setCleanData(fileResult.value);
        } else {
          errors.push(fileResult.reason?.message || '文件清洗建议失败');
        }
      }

      const folderResult = results[folderIndex];
      if (folderResult.status === 'fulfilled') {
        setMergeData(folderResult.value);
      } else {
        errors.push(folderResult.reason?.message || '词形合并建议失败');
      }

      if (errors.length) {
        showError(errors.join('；'));
      } else if (shouldAnalyzeFile) {
        showNotice('已生成当前文件和目录合并整理建议');
      } else {
        showNotice('已生成目录合并整理建议');
      }
    } finally {
      setLoadingMerge(false);
      if (shouldAnalyzeFile) {
        setLoadingClean(false);
      }
    }
  };

  const handleApplyLlmSuggestion = (kind, item) => {
    if (!draft || !item) return;
    if (kind === 'entry') {
      if (!isActionableEntrySuggestion(item)) return;
      const action = normalizeLlmAction(item.action);
      if (action !== 'rename') return;
      const suggestedWord = collapseWhitespace(item.suggested_word);
      if (!suggestedWord) return;
      updateDraft((base) => applyEntryRenameToDraft(base, suggestedWord));
      showNotice('已应用词条重命名建议到草稿');
      return;
    }
    if (kind === 'definition' && !isActionableDefinitionSuggestion(item)) return;
    if (kind === 'example' && !isActionableExampleSuggestion(item)) return;

    const llmPayload = kind === 'definition'
      ? { definitions: [item], examples: [] }
      : { definitions: [], examples: [item] };

    updateDraft((base) => buildFullyAutoAppliedDraft(base, {
      heuristic: { suggestions: [] },
      llm: llmPayload,
    }));
    showNotice('已应用该 LLM 建议到草稿');
  };

  const handleApplyEntryRenameAndSave = async (item, actionKey = '') => {
    if (!draft || !hasSelection || !isActionableEntrySuggestion(item)) return;
    if (normalizeLlmAction(item.action) !== 'rename') return;

    const suggestedWord = collapseWhitespace(item.suggested_word);
    if (!suggestedWord) return;

    const expectedFilename = normalizeWordFilename(suggestedWord);
    if (expectedFilename && expectedFilename.toLowerCase() === filename.toLowerCase()) {
      updateDraft((base) => applyEntryRenameToDraft(base, suggestedWord));
      showNotice('当前文件名已匹配该词条，已应用到草稿');
      return;
    }

    setRenameApplyingKey(actionKey || 'rename');
    setSavingDraft(true);
    try {
      setError('');
      const renamedDraft = applyEntryRenameToDraft(draft, suggestedWord);
      const payload = sanitizeDraftForSave(renamedDraft, suggestedWord);
      const res = await renameVocabDetail(apiCategory, filename, suggestedWord, payload);
      const savedFilename = res.file || res.target_file || expectedFilename || filename;
      const savedData = res.data || payload;

      hydrateDetailAndDraft(savedData);
      pendingSelectionRef.current = { category: apiCategory, filename: savedFilename };
      setDraftDirty(false);
      setFilename(savedFilename);
      void refreshFiles();

      const refreshed = await runFileRefine(apiCategory, savedFilename, false, savedData);
      setCleanData(refreshed);
      if (res?.merged_to_existing) {
        showNotice(`已合并到已有词条: ${filename} → ${savedFilename}`);
      } else {
        showNotice(`已重命名: ${filename} → ${savedFilename}`);
      }
    } catch (err) {
      showError(err.message);
    } finally {
      setSavingDraft(false);
      setRenameApplyingKey('');
    }
  };

  const handleApplySplit = async (item, actionKey = '') => {
    if (!hasSelection || !draft || !isActionableEntrySuggestion(item)) return;
    if (normalizeLlmAction(item.action) !== 'split') return;

    setSplitApplyingKey(actionKey || 'split');
    try {
      setError('');
      const payload = sanitizeDraftForSave(draft, filename.replace(/\.json$/i, ''));
      const res = await applySplitSuggestion(
        apiCategory,
        filename,
        item,
        deleteSourceAfterMerge,
        payload,
      );
      const entriesCreated = Array.isArray(res?.entries) ? res.entries : [];
      const updatedCount = Array.isArray(res?.updated_files) ? res.updated_files.length : 0;
      const createdCount = Array.isArray(res?.created_files) ? res.created_files.length : 0;
      const firstTarget = entriesCreated[0]?.file || '';

      setCleanData(null);
      void refreshFiles();

      if (deleteSourceAfterMerge && firstTarget) {
        pendingSelectionRef.current = { category: apiCategory, filename: firstTarget };
        setDraftDirty(false);
        setFilename(firstTarget);
      } else if (firstTarget) {
        showNotice(`已拆分：新建 ${createdCount} 个，更新 ${updatedCount} 个`);
      }

      if (deleteSourceAfterMerge && !firstTarget) {
        setFilename('');
        resetEntryState();
      }

      if (firstTarget && !deleteSourceAfterMerge) {
        const refreshed = await runFileRefine(apiCategory, filename, false, payload);
        setCleanData(refreshed);
      }

      if (deleteSourceAfterMerge && firstTarget) {
        showNotice(`已拆分：新建 ${createdCount} 个，更新 ${updatedCount} 个，并切换到 ${firstTarget}`);
      }
    } catch (err) {
      showError(err.message);
    } finally {
      setSplitApplyingKey('');
    }
  };

  const handleApplyAllSuggestions = () => {
    if (!draft) return;

    const autoLlmCount = countActionableLlmItems(cleanData?.llm || null);
    const totalAutoCount = autoLlmCount;
    if (!totalAutoCount) {
      showNotice('当前没有可自动应用的建议');
      return;
    }

    updateDraft((base) => buildFullyAutoAppliedDraft(base, cleanData));
    showNotice(`已一键应用 ${totalAutoCount} 条建议到草稿`);
  };

  const handleApplyAllAndSave = async () => {
    if (!draft || !hasSelection) return;

    const autoLlmCount = countActionableLlmItems(cleanData?.llm || null);
    const totalAutoCount = autoLlmCount;
    if (!totalAutoCount) {
      showNotice('当前没有可自动应用的建议');
      return;
    }

    setSavingDraft(true);
    try {
      setError('');
      const nextDraft = buildFullyAutoAppliedDraft(draft, cleanData);
      const payload = sanitizeDraftForSave(nextDraft, filename.replace(/\.json$/i, ''));
      const nextWord = collapseWhitespace(payload.word || '');
      const currentWord = collapseWhitespace(detail?.word || filename.replace(/\.json$/i, ''));
      const res = nextWord && nextWord.toLowerCase() !== currentWord.toLowerCase()
        ? await renameVocabDetail(apiCategory, filename, nextWord, payload)
        : await saveVocabDetail(apiCategory, filename, payload);
      const savedFilename = res.file || res.target_file || filename;
      hydrateDetailAndDraft(res.data || payload);
      setDraftDirty(false);
      if (savedFilename !== filename) {
        pendingSelectionRef.current = { category: apiCategory, filename: savedFilename };
        setFilename(savedFilename);
      }
      void refreshFiles();

      const refreshed = await runFileRefine(apiCategory, savedFilename, false, res.data || payload);
      setCleanData(refreshed);
      showNotice(`已一键应用 ${totalAutoCount} 条建议并保存到 data`);
    } catch (err) {
      showError(err.message);
    } finally {
      setSavingDraft(false);
    }
  };

  const handleDraftSave = async () => {
    if (!draft || !hasSelection) return;

    setSavingDraft(true);
    try {
      setError('');
      const payload = sanitizeDraftForSave(draft, filename.replace(/\.json$/i, ''));
      const nextWord = collapseWhitespace(payload.word || '');
      const currentWord = collapseWhitespace(detail?.word || filename.replace(/\.json$/i, ''));
      const res = nextWord && nextWord.toLowerCase() !== currentWord.toLowerCase()
        ? await renameVocabDetail(apiCategory, filename, nextWord, payload)
        : await saveVocabDetail(apiCategory, filename, payload);
      const savedFilename = res.file || res.target_file || filename;
      hydrateDetailAndDraft(res.data || payload);
      setDraftDirty(false);
      if (savedFilename !== filename) {
        pendingSelectionRef.current = { category: apiCategory, filename: savedFilename };
        setFilename(savedFilename);
      }
      void refreshFiles();

      if (cleanData) {
        const refreshed = await runFileRefine(apiCategory, savedFilename, false, res.data || payload);
        setCleanData(refreshed);
      }
      showNotice('已保存到 data');
    } catch (err) {
      showError(err.message);
    } finally {
      setSavingDraft(false);
    }
  };

  const handleDraftReset = () => {
    hydrateDetailAndDraft(detail);
    showNotice('草稿已重置');
  };

  const handleToggleMarked = async () => {
    if (!hasSelection || !detail) return;

    setSavingMarked(true);
    try {
      setError('');
      const payload = { ...detail, marked: !currentMarked };
      const res = await saveVocabDetail(apiCategory, filename, payload);
      const nextData = res.data || payload;

      setDetail(deepClone(nextData));
      setDraft((prev) => (prev ? { ...prev, marked: Boolean(nextData.marked) } : prev));
      setEntries((prev) => prev.map((item) => (
        item.file === filename
          ? {
              ...item,
              word: collapseWhitespace(nextData.word || item.word || filename.replace(/\.json$/i, '')) || item.word,
              marked: Boolean(nextData.marked),
            }
          : item
      )));
      showNotice(Boolean(nextData.marked) ? '已标记当前词条' : '已取消标记');
    } catch (err) {
      showError(err.message);
    } finally {
      setSavingMarked(false);
    }
  };

  const handleReviewRefresh = async () => {
    if (!hasSelection) return;

    setLoadingReview(true);
    try {
      setError('');
      const res = await getReviewAdvice(apiCategory, filename);
      setReviewData(res);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoadingReview(false);
    }
  };

  const handleScore = async (score) => {
    if (!hasSelection) return;

    setLoadingReview(true);
    try {
      setError('');
      const reviewRes = await submitReviewScore(apiCategory, filename, score, reviewDate);
      setReviewData(reviewRes);

      const detailRes = await fetchVocabDetail(apiCategory, filename);
      hydrateDetailAndDraft(detailRes.data || null);
      showNotice(`已记录评分 ${score}`);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoadingReview(false);
    }
  };

  const handleSpeakWord = (lang, label) => {
    const word = collapseWhitespace(activeWord);
    if (!word) return;
    if (!ttsSupported) {
      showError('当前浏览器不支持 TTS 朗读');
      return;
    }

    const synth = window.speechSynthesis;
    const requestId = speechRequestRef.current + 1;
    speechRequestRef.current = requestId;
    setTtsVoiceLabel('');
    synth.cancel();

    const utterance = new window.SpeechSynthesisUtterance(word);
    utterance.lang = lang;
    utterance.rate = 0.92;
    utterance.pitch = 1;

    const preferredVoice = pickPreferredVoice(synth.getVoices(), lang);
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }

    utterance.onstart = () => {
      if (speechRequestRef.current === requestId) {
        setTtsVoiceLabel(label);
      }
    };

    utterance.onend = () => {
      if (speechRequestRef.current === requestId) {
        setTtsVoiceLabel('');
      }
    };

    utterance.onerror = (event) => {
      if (speechRequestRef.current !== requestId) return;
      setTtsVoiceLabel('');
      if (event?.error && !['canceled', 'interrupted'].includes(event.error)) {
        showError('TTS 播放失败');
      }
    };

    synth.speak(utterance);
  };

  const handleStopSpeech = () => {
    if (!ttsSupported) return;
    speechRequestRef.current += 1;
    setTtsVoiceLabel('');
    window.speechSynthesis.cancel();
  };

  const scrollToFocusPanel = (focus) => {
    const targetRef = focus === 'review' ? reviewPanelRef : cleanPanelRef;
    targetRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleOpenYoudao = () => {
    if (!youdaoUrl) return;
    window.open(youdaoUrl, '_blank', 'noopener,noreferrer');
  };

  const handleOpenConfig = () => {
    if (typeof onOpenConfig === 'function') {
      onOpenConfig();
      return;
    }
    setDrawerOpen(true);
  };

  return (
    <div className={`review-scope page workspace-page${embedded ? ' embedded' : ''}`}>
      {!embedded ? (
        <header className="topbar">
          <div className="brand-wrap">
            <div className="brand-mark" />
            <div>
              <div className="brand">Master Server Review</div>
              <div className="subtitle">词库精加工控制台</div>
            </div>
          </div>

          <div className="toolbar workspace-toolbar">
            <ModeSwitch mode={mode} onChange={setMode} />
            <button className="ghost" onClick={refreshFiles} disabled={loadingFiles || !apiCategory}>
              {loadingFiles ? '刷新中...' : '刷新当前目录'}
            </button>
            <button className="primary" onClick={handleOpenConfig}>配置</button>
          </div>
        </header>
      ) : null}

      <main className="workspace-shell">
        <aside className="workspace-sidebar">
          {mode === 'manual' ? (
            <ManualSelectionPanel
              categories={categories}
              category={category}
              filename={filename}
              entries={entries}
              filteredEntries={filteredEntries}
              entryFilter={entryFilter}
              filterCounts={filterCounts}
              fileQuery={fileQuery}
              setFileQuery={setFileQuery}
              loadingCategories={loadingCategories}
              loadingFiles={loadingFiles}
              onEntryFilterChange={setEntryFilter}
              onCategorySelect={handleCategorySelect}
              onFilenameSelect={handleFilenameSelect}
            />
          ) : (
            <RecommendationModePanel
              categories={categories}
              scope={recommendScope}
              onScopeChange={handleRecommendScopeChange}
              preferences={normalizedRecommendPreferences}
              onPreferencesChange={handleRecommendPreferencesChange}
              recommendation={recommendation}
              alternatives={recommendAlternatives}
              meta={recommendMeta}
              loading={loadingRecommendation}
              onPush={handleRecommendRefresh}
              onNext={handleRecommendNext}
              onUse={handleUseRecommendation}
              savingPreferences={savingRecommendPreferences}
            />
          )}
        </aside>

        <section className="workspace-main">
          <section className={`panel panel-soft workspace-summary${hasSelection ? '' : ' is-empty'}`}>
            <div className="panel-body">
              <div className="workspace-summary-top">
                <div>
                  <div className="hero-kicker">{selectionSource === 'recommendation' ? 'Recommended Target' : 'Current Target'}</div>
                  <div className="workspace-title-row">
                    <div className={`workspace-title${hasSelection ? '' : ' is-empty'}`}>
                      {hasSelection ? (activeWord || filename.replace(/\.json$/i, '')) : '先选择一个词条开始处理'}
                    </div>
                    {hasSelection ? (
                      <div className="word-tools">
                        <button
                          type="button"
                          className={currentMarked ? 'primary workspace-mark-button is-marked' : 'ghost workspace-mark-button'}
                          onClick={handleToggleMarked}
                          disabled={savingMarked}
                        >
                          {savingMarked ? '保存中...' : (currentMarked ? '取消标记' : '标记词条')}
                        </button>
                        <button type="button" className="ghost" onClick={() => handleSpeakWord('en-US', '美音')} disabled={!ttsSupported}>
                          {ttsVoiceLabel === '美音' ? '朗读中·美音' : '美音'}
                        </button>
                        <button type="button" className="ghost" onClick={() => handleSpeakWord('en-GB', '英音')} disabled={!ttsSupported}>
                          {ttsVoiceLabel === '英音' ? '朗读中·英音' : '英音'}
                        </button>
                        <button type="button" className="ghost" onClick={handleOpenYoudao} disabled={!youdaoUrl}>有道词典</button>
                        {ttsVoiceLabel ? (
                          <button type="button" className="ghost" onClick={handleStopSpeech}>停止</button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <p className="selection-sub">
                    {hasSelection
                      ? `${formatCategoryLabel(category)} / ${filename}`
                      : mode === 'recommend'
                        ? '推荐模式下，从推荐面板直接进入编辑、清洗和复习。'
                        : '手动模式下，先选目录，再点具体词条文件。'}
                  </p>
                  {!hasSelection ? (
                    <div className="workspace-empty-steps">
                      <span>1. 选目录</span>
                      <span>2. 选词条</span>
                      <span>3. 直接清洗与复习</span>
                    </div>
                  ) : null}
                </div>

                {embedded ? (
                  <div className="workspace-summary-actions">
                    <div className="section-title">工作模式</div>
                    <ModeSwitch mode={mode} onChange={setMode} />
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <div className="workspace-columns">
            <aside className="editor-column">
              <div className="panel">
                <div className="panel-header">
                  <h3>词条编辑器</h3>
                  {draft ? <span className={`badge ${draftDirty ? 'medium' : 'high'}`}>{draftDirty ? 'draft' : 'synced'}</span> : null}
                </div>
                <EditorPanel
                  key={`editor-${editorSyncToken}`}
                  draft={draft}
                  dirty={draftDirty}
                  saving={savingDraft}
                  onWordChange={(value) => updateDraft((base) => ({ ...base, word: value }))}
                  onDefinitionChange={(index, value) => updateDraft((base) => {
                    const definitions = Array.isArray(base.definitions) ? [...base.definitions] : [];
                    definitions[index] = value;
                    return { ...base, definitions };
                  })}
                  onDefinitionAdd={() => updateDraft((base) => {
                    const definitions = Array.isArray(base.definitions) ? [...base.definitions] : [];
                    definitions.push('');
                    return { ...base, definitions };
                  })}
                  onDefinitionRemove={(index) => updateDraft((base) => {
                    const definitions = Array.isArray(base.definitions) ? [...base.definitions] : [];
                    definitions.splice(index, 1);
                    return { ...base, definitions };
                  })}
                  onExampleChange={(index, field, value) => updateDraft((base) => {
                    if (index === -1 && field === 'createdAt') {
                      return { ...base, createdAt: value };
                    }

                    const examples = Array.isArray(base.examples) ? [...base.examples] : [];
                    if (index < 0 || index >= examples.length) return { ...base, examples };

                    const example = { ...(examples[index] || {}) };
                    if (field === 'focusWords') {
                      example.focusWords = String(value || '')
                        .split(',')
                        .map((item) => item.trim())
                        .filter((item) => Boolean(item));
                    } else if (field === 'focusPositions') {
                      const tokenCount = tokenizeNonSpace(example.text).length;
                      const normalizedPositions = normalizeExampleFocusPositions(
                        String(value || '').split(','),
                        tokenCount,
                      );
                      if (normalizedPositions.length) {
                        example.focusPositions = normalizedPositions;
                      } else {
                        delete example.focusPositions;
                      }
                    } else if (field === 'source.text' || field === 'source.url') {
                      const currentSource = normalizeExampleSource(example);
                      const sourceField = field === 'source.text' ? 'text' : 'url';
                      const nextSource = {
                        ...currentSource,
                        [sourceField]: sourceField === 'text' ? collapseWhitespace(value) : String(value || '').trim(),
                      };
                      if (nextSource.text || nextSource.url) {
                        example.source = nextSource;
                      } else {
                        delete example.source;
                      }
                    } else if (field === 'youtube.url' || field === 'youtube.timestamp') {
                      const currentYoutube = normalizeExampleYoutube(example);
                      const nextYoutube = {
                        ...currentYoutube,
                        [field === 'youtube.url' ? 'url' : 'timestamp']: field === 'youtube.url'
                          ? String(value || '').trim()
                          : Math.max(0, parseInt(value, 10) || 0),
                      };
                      if (nextYoutube.url) {
                        example.youtube = nextYoutube;
                      } else {
                        delete example.youtube;
                      }
                    } else {
                      example[field] = value;
                      if (field === 'text' && Array.isArray(example.focusPositions)) {
                        const normalizedPositions = normalizeExampleFocusPositions(
                          example.focusPositions,
                          tokenizeNonSpace(value).length,
                        );
                        if (normalizedPositions.length) {
                          example.focusPositions = normalizedPositions;
                        } else {
                          delete example.focusPositions;
                        }
                      }
                    }

                    examples[index] = example;
                    return { ...base, examples };
                  })}
                  onExampleAdd={() => updateDraft((base) => {
                    const examples = Array.isArray(base.examples) ? [...base.examples] : [];
                    examples.push({
                      text: '',
                      explanation: '',
                      source: { text: '', url: '' },
                      youtube: { url: '', timestamp: 0 },
                      focusWords: [String(base.word || '').trim()].filter(Boolean),
                    });
                    return { ...base, examples };
                  })}
                  onExampleRemove={(index) => updateDraft((base) => {
                    const examples = Array.isArray(base.examples) ? [...base.examples] : [];
                    examples.splice(index, 1);
                    return { ...base, examples };
                  })}
                  onExampleToggleFocusPosition={(index, tokenIndex) => updateDraft((base) => {
                    const examples = Array.isArray(base.examples) ? [...base.examples] : [];
                    if (index < 0 || index >= examples.length) return { ...base, examples };

                    const example = { ...(examples[index] || {}) };
                    const tokenCount = tokenizeNonSpace(example.text).length;
                    if (!tokenCount) return { ...base, examples };

                    const current = normalizeExampleFocusPositions(example.focusPositions, tokenCount);
                    const next = current.includes(tokenIndex)
                      ? current.filter((item) => item !== tokenIndex)
                      : [...current, tokenIndex];
                    const normalized = normalizeExampleFocusPositions(next, tokenCount);

                    if (normalized.length) {
                      example.focusPositions = normalized;
                    } else {
                      delete example.focusPositions;
                    }

                    examples[index] = example;
                    return { ...base, examples };
                  })}
                  onExampleClearFocusPositions={(index) => updateDraft((base) => {
                    const examples = Array.isArray(base.examples) ? [...base.examples] : [];
                    if (index < 0 || index >= examples.length) return { ...base, examples };

                    const example = { ...(examples[index] || {}) };
                    delete example.focusPositions;
                    examples[index] = example;
                    return { ...base, examples };
                  })}
                  onExampleApplyFocusPositions={(index, positions) => updateDraft((base) => {
                    const examples = Array.isArray(base.examples) ? [...base.examples] : [];
                    if (index < 0 || index >= examples.length) return { ...base, examples };

                    const example = { ...(examples[index] || {}) };
                    const normalized = normalizeExampleFocusPositions(
                      Array.isArray(positions) ? positions : [],
                      tokenizeNonSpace(example.text).length,
                    );
                    if (!normalized.length) return { ...base, examples };

                    example.focusPositions = normalized;
                    examples[index] = example;
                    return { ...base, examples };
                  })}
                  onReplaceDraft={(value) => updateDraft(() => deepClone(value || {}))}
                  onReset={handleDraftReset}
                  onSave={handleDraftSave}
                />
              </div>
            </aside>

            <section className="inspector-column">
              <div ref={reviewPanelRef}>
                <ReviewPanel
                  reviewData={reviewData}
                  loading={loadingReview}
                  reviewDate={reviewDate}
                  setReviewDate={setReviewDate}
                  onRefresh={handleReviewRefresh}
                  onScore={handleScore}
                />
              </div>

              <div ref={cleanPanelRef}>
                <OrganizePanel
                  cleanData={cleanData}
                  mergeData={mergeData}
                  draft={draft}
                  loading={loadingClean}
                  mergeLoading={loadingMerge}
                  includeLlm={includeLlm}
                  setIncludeLlm={setIncludeLlm}
                  includeLowConfidence={includeLowConfidence}
                  setIncludeLowConfidence={setIncludeLowConfidence}
                  includeMergeLlm={includeMergeLlm}
                  setIncludeMergeLlm={setIncludeMergeLlm}
                  deleteSourceAfterMerge={deleteSourceAfterMerge}
                  setDeleteSourceAfterMerge={setDeleteSourceAfterMerge}
                  onRun={handleClean}
                  onRunMerge={handleMerge}
                  onRunAll={handleOrganize}
                  onApplyLlmSuggestion={handleApplyLlmSuggestion}
                  onApplyEntryRenameAndSave={handleApplyEntryRenameAndSave}
                  onApplyAllSuggestions={handleApplyAllSuggestions}
                  onApplyAllAndSave={handleApplyAllAndSave}
                  onApplyMerge={handleApplyMerge}
                  onApplySplit={handleApplySplit}
                  applyingKey={mergeApplyingKey}
                  splitApplyingKey={splitApplyingKey}
                  renameApplyingKey={renameApplyingKey}
                  hasCategory={Boolean(apiCategory)}
                  hasDraft={Boolean(draft)}
                  savingDraft={savingDraft}
                  analyzedFrom={cleanData?.analyzed_from || 'file'}
                />
              </div>
            </section>
          </div>
        </section>
      </main>

      {error ? (
        <div className="global-error">
          <span>{error}</span>
          <button type="button" className="toast-close" onClick={() => setError('')}>关闭</button>
        </div>
      ) : null}
      {notice ? (
        <div className="global-notice">
          <span>{notice}</span>
          <button type="button" className="toast-close" onClick={() => setNotice('')}>关闭</button>
        </div>
      ) : null}

      {!embedded ? <ConfigDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} /> : null}
    </div>
  );
}
