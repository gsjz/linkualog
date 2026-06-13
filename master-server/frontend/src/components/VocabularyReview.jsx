import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import UiIcon from './UiIcon';

import {
  fetchConfig,
  fetchRecommendedWord,
  getVocabularyCategories,
  getVocabularyDetail,
  getVocabularyList,
  getReviewVisualization,
  saveConfig,
  saveVocabularyDetail,
  submitReviewScore,
} from '../api/client';
import { RelationGraphPanel } from './VisualizationDashboard.jsx';

const REVIEW_CATEGORY_KEY = 'vocabReviewCategory';
const DESKTOP_CONTENT_COLLAPSED_KEY = 'vocabReviewDesktopContentDefaultCollapsed';
const RELATION_GRAPH_FULL_COMPONENT_KEY = 'vocabReviewRelationGraphFullComponent';
const ALL_CATEGORIES_VALUE = '__all_categories__';
const FOCUS_RENDER_TOKEN_REGEX = /\s+|[\p{L}\p{N}_]+|[^\s]/gu;
const CATEGORY_LABELS = {
  cet: 'CET',
  daily: 'Daily',
  kaoyan: 'Kaoyan',
  toefl: 'TOEFL',
  ielts: 'IELTS',
};
const SCORE_LABELS = {
  0: '完全忘记',
  1: '非常吃力',
  2: '勉强想起',
  3: '基本记住',
  4: '比较牢固',
  5: '非常熟练',
};
const SCORE_SHORT_LABELS = {
  0: '忘了',
  1: '吃力',
  2: '想起',
  3: '记住',
  4: '牢固',
  5: '熟练',
};
const ENTRY_FILTER_OPTIONS = [
  { value: 'marked', label: '标记词条', compactLabel: '标记' },
  { value: 'needs_processing', label: '待处理', compactLabel: '待处理' },
  { value: 'all', label: '全部词条', compactLabel: '全部' },
  { value: 'unmarked', label: '未标记', compactLabel: '未标' },
];
const MANUAL_SORT_OPTIONS = [
  { value: 'name', label: '词名' },
  { value: 'recent', label: '最近' },
  { value: 'oldest', label: '最早' },
];
const ALL_RECOMMEND_SCOPE = '__all_recommend_scope__';
const DEFAULT_RECOMMENDATION_PREFERENCES = {
  due_weight: 2.2,
  created_weight: 0.35,
  score_weight: 0.75,
  created_order: 'recent',
  score_order: 'low',
};
const RECOMMENDATION_TOTAL_WEIGHT = DEFAULT_RECOMMENDATION_PREFERENCES.due_weight
  + DEFAULT_RECOMMENDATION_PREFERENCES.created_weight
  + DEFAULT_RECOMMENDATION_PREFERENCES.score_weight;
const RECOMMENDATION_TRIANGLE_SIZE = 236;
const RECOMMENDATION_TRIANGLE_POINTS = {
  due: { x: 118, y: 24, label: '到期优先' },
  created: { x: 28, y: 204, label: '创建时间' },
  score: { x: 208, y: 204, label: '熟练度' },
};
const RECOMMENDATION_STRATEGY_PRESETS = [
  {
    key: 'due',
    title: '到期复习',
    preferences: {
      due_weight: 2.75,
      created_weight: 0.25,
      score_weight: 0.3,
      created_order: 'recent',
      score_order: 'low',
    },
  },
  {
    key: 'weak',
    title: '补弱优先',
    preferences: {
      due_weight: 1.3,
      created_weight: 0.35,
      score_weight: 1.65,
      created_order: 'recent',
      score_order: 'low',
    },
  },
  {
    key: 'new',
    title: '新词回看',
    preferences: {
      due_weight: 0.8,
      created_weight: 1.75,
      score_weight: 0.75,
      created_order: 'recent',
      score_order: 'low',
    },
  },
  {
    key: 'high',
    title: '高分巩固',
    preferences: {
      due_weight: 0.8,
      created_weight: 0.35,
      score_weight: 2.15,
      created_order: 'oldest',
      score_order: 'high',
    },
  },
  {
    key: 'balanced',
    title: '均衡',
    preferences: {
      due_weight: 1.1,
      created_weight: 1.1,
      score_weight: 1.1,
      created_order: 'recent',
      score_order: 'low',
    },
  },
];

const getTodayLocalDateString = () => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getStoredReviewCategory = () => {
  const savedReviewCategory = localStorage.getItem(REVIEW_CATEGORY_KEY);
  const fallbackCategory = savedReviewCategory !== null
    ? String(savedReviewCategory || '').trim()
    : String(localStorage.getItem('defaultCategory') || '').trim();
  return isAllCategoriesValue(fallbackCategory) ? '' : fallbackCategory;
};

const getStoredDesktopContentDefaultCollapsed = () => (
  localStorage.getItem(DESKTOP_CONTENT_COLLAPSED_KEY) === '1'
);

const getStoredRelationGraphFullComponent = () => (
  localStorage.getItem(RELATION_GRAPH_FULL_COMPONENT_KEY) === '1'
);

const isAllCategoriesValue = (value) => String(value || '').trim() === ALL_CATEGORIES_VALUE;

const normalizeVocabularyLaunchWord = (value) => String(value || '')
  .trim()
  .replace(/\.json$/i, '');

const buildVocabularyWordKey = (value) => normalizeVocabularyLaunchWord(value)
  .toLowerCase()
  .replace(/[\s_]+/g, '-');

const buildVocabularyEntryId = (category, value) => {
  const categoryKey = String(category || '').trim().toLowerCase() || '__root__';
  return `${categoryKey}::${buildVocabularyWordKey(value)}`;
};

const buildLaunchRequestKey = (request) => {
  const targetWord = normalizeVocabularyLaunchWord(request?.word || request?.filename || request?.fileKey);
  const targetFileKey = normalizeVocabularyLaunchWord(request?.fileKey || request?.filename || request?.word);
  if (!targetWord && !targetFileKey) return '';
  return [
    String(request?.category || '').trim(),
    targetWord,
    targetFileKey,
    String(request?.focus || '').trim(),
    String(request?.autoRefineToken || '').trim(),
  ].join('\u0001');
};

const normalizeVocabularyEntry = (entry, fallbackCategory = '') => {
  const key = normalizeVocabularyLaunchWord(entry?.key || entry?.file || entry?.word);
  const file = String(entry?.file || (key ? `${key}.json` : '')).trim();
  const word = String(entry?.word || key || '').trim();
  const category = String(entry?.category || fallbackCategory || '').trim();
  const createdAt = String(entry?.createdAt || entry?.created_at || '').trim();
  return {
    id: buildVocabularyEntryId(category, file || key || word),
    key,
    file,
    word: word || key,
    category,
    marked: Boolean(entry?.marked),
    needsProcessing: Boolean(entry?.needsProcessing || entry?.needs_processing),
    needs_processing: Boolean(entry?.needsProcessing || entry?.needs_processing),
    refineCached: Boolean(entry?.refineCached || entry?.refine_cached),
    refine_cached: Boolean(entry?.refineCached || entry?.refine_cached),
    relationCached: Boolean(entry?.relationCached || entry?.relation_cached),
    relation_cached: Boolean(entry?.relationCached || entry?.relation_cached),
    createdAt,
    created_at: createdAt,
  };
};

const buildRelationNodeLookupKey = (category, value) => {
  const categoryKey = String(category || '').trim().toLowerCase();
  const fileKey = buildVocabularyWordKey(value);
  return categoryKey && fileKey ? `${categoryKey}::${fileKey}` : '';
};

const sortRelationNodesForFocus = (focusNodeId) => (left, right) => {
  if (left?.id === focusNodeId) return -1;
  if (right?.id === focusNodeId) return 1;
  return String(left?.word || left?.file || '').localeCompare(
    String(right?.word || right?.file || ''),
    undefined,
    { sensitivity: 'base' },
  );
};

const buildRelationGraphIndex = (graph) => {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const nodeById = new Map();
  const nodeByLookupKey = new Map();
  const adjacency = new Map();
  const edgesByNodeId = new Map();
  const validEdges = [];

  nodes.forEach((node) => {
    const id = String(node?.id || '').trim();
    if (!id) return;
    nodeById.set(id, node);

    [
      buildRelationNodeLookupKey(node?.category, node?.file || node?.word),
      buildRelationNodeLookupKey(node?.category, node?.word),
    ].filter(Boolean).forEach((key) => {
      if (!nodeByLookupKey.has(key)) nodeByLookupKey.set(key, node);
    });
  });

  edges.forEach((edge) => {
    const source = String(edge?.source || '').trim();
    const target = String(edge?.target || '').trim();
    if (!source || !target || source === target || !nodeById.has(source) || !nodeById.has(target)) return;

    const normalizedEdge = {
      ...edge,
      source,
      target,
      type: String(edge?.type || 'related').trim() || 'related',
      scope: edge?.scope === 'cross_category' ? 'cross_category' : 'same_category',
    };
    validEdges.push(normalizedEdge);

    if (!adjacency.has(source)) adjacency.set(source, new Set());
    if (!adjacency.has(target)) adjacency.set(target, new Set());
    adjacency.get(source).add(target);
    adjacency.get(target).add(source);

    if (!edgesByNodeId.has(source)) edgesByNodeId.set(source, []);
    if (!edgesByNodeId.has(target)) edgesByNodeId.set(target, []);
    edgesByNodeId.get(source).push(normalizedEdge);
    edgesByNodeId.get(target).push(normalizedEdge);
  });

  return {
    nodes,
    nodeById,
    nodeByLookupKey,
    adjacency,
    edgesByNodeId,
    edges: validEdges,
  };
};

const collectRelationComponentNodeIds = (graphIndex, focusNodeId) => {
  const visited = new Set([focusNodeId]);
  const queue = [focusNodeId];
  let cursor = 0;

  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    const neighbors = graphIndex.adjacency.get(current) || [];
    neighbors.forEach((neighborId) => {
      if (visited.has(neighborId)) return;
      visited.add(neighborId);
      queue.push(neighborId);
    });
  }

  return visited;
};

const compareRelationNodesStable = (left, right) => (
  String(left?.category || '').localeCompare(String(right?.category || ''), undefined, { sensitivity: 'base' })
  || String(left?.word || left?.file || '').localeCompare(String(right?.word || right?.file || ''), undefined, { sensitivity: 'base' })
  || String(left?.id || '').localeCompare(String(right?.id || ''), undefined, { sensitivity: 'base' })
);

const buildFocusedRelationGraph = (graphIndex, entry, fallbackCategory = '', fullComponent = false) => {
  const nodes = Array.isArray(graphIndex?.nodes) ? graphIndex.nodes : [];
  if (!entry || !nodes.length) return null;

  const entryCategory = String(entry?.category || fallbackCategory || '').trim();
  const candidateKeys = new Set([
    entry?.file,
    entry?.key,
    entry?.word,
    normalizeVocabularyLaunchWord(entry?.file || entry?.key || entry?.word),
  ].map((value) => buildRelationNodeLookupKey(entryCategory, value)).filter(Boolean));

  let focusNode = null;
  for (const key of candidateKeys) {
    focusNode = graphIndex.nodeByLookupKey.get(key);
    if (focusNode) break;
  }

  if (!focusNode && entryCategory) {
    const wordKey = buildVocabularyWordKey(entry?.word || entry?.key || entry?.file);
    focusNode = nodes.find((node) => (
      String(node?.category || '').trim() === entryCategory
      && buildVocabularyWordKey(node?.word || node?.file) === wordKey
    ));
  }

  const focusNodeId = String(focusNode?.id || '').trim();
  if (!focusNodeId) return null;

  const directEdges = graphIndex.edgesByNodeId.get(focusNodeId) || [];
  const includedIds = fullComponent
    ? collectRelationComponentNodeIds(graphIndex, focusNodeId)
    : new Set([focusNodeId]);

  if (!fullComponent) {
    directEdges.forEach((edge) => {
      if (edge.source) includedIds.add(edge.source);
      if (edge.target) includedIds.add(edge.target);
    });
  }

  const componentNodes = [...includedIds]
    .map((id) => graphIndex.nodeById.get(id))
    .filter(Boolean)
    .sort(fullComponent ? compareRelationNodesStable : sortRelationNodesForFocus(focusNodeId));
  const liveIds = new Set(componentNodes.map((node) => String(node?.id || '').trim()).filter(Boolean));
  const componentEdges = graphIndex.edges.filter((edge) => (
    liveIds.has(edge.source)
    && liveIds.has(edge.target)
  ));
  if (!componentNodes.length) return null;
  const componentKey = fullComponent
    ? [...liveIds].sort().join('|')
    : focusNodeId;
  const componentId = `${fullComponent ? 'component' : 'focus'}-${componentKey || focusNodeId}`;

  return {
    focusNodeId,
    hasEdges: componentEdges.length > 0,
    fullComponent,
    componentKey,
    graph: {
      scope: {
        category: entryCategory || String(focusNode?.category || '').trim(),
        label: fullComponent
          ? `${componentNodes.length}词连通块`
          : `${focusNode.word || entry.word || '当前词'} 关联`,
      },
      nodes: componentNodes,
      edges: componentEdges,
      components: [
        {
          id: componentId,
          nodes: componentNodes,
          edges: componentEdges,
          node_count: componentNodes.length,
          edge_count: componentEdges.length,
          categories: [...new Set(componentNodes
            .map((node) => String(node?.category || '').trim())
            .filter(Boolean))].sort(),
        },
      ],
      component_count: 1,
      connected_node_count: componentNodes.length,
    },
  };
};

const buildPendingRelationGraph = (entry, fallbackCategory = '', pending = false) => {
  if (!entry) return null;
  const entryCategory = String(entry?.category || fallbackCategory || '').trim();
  const rawFile = String(entry?.file || entry?.key || entry?.word || '').trim();
  const file = rawFile.endsWith('.json') ? rawFile : `${rawFile || 'current'}.json`;
  const word = String(entry?.word || normalizeVocabularyLaunchWord(file) || rawFile || '当前词').trim();
  const focusNodeId = `${entryCategory || 'current'}:${file}`;
  const node = {
    id: focusNodeId,
    category: entryCategory,
    file,
    word,
  };
  return {
    focusNodeId,
    hasEdges: false,
    pending,
    graph: {
      scope: {
        category: entryCategory,
        label: `${word} 关联`,
      },
      nodes: [node],
      edges: [],
      components: [
        {
          id: `pending-${focusNodeId}`,
          nodes: [node],
          edges: [],
          node_count: 1,
          edge_count: 0,
          categories: entryCategory ? [entryCategory] : [],
        },
      ],
      component_count: 1,
      connected_node_count: 1,
    },
  };
};

const getEntryCreatedAt = (entry) => String(entry?.createdAt || entry?.created_at || '').trim();

const compareEntriesByName = (left, right) => (
  String(left?.word || '').localeCompare(String(right?.word || ''), undefined, { sensitivity: 'base' })
  || String(left?.category || '').localeCompare(String(right?.category || ''), undefined, { sensitivity: 'base' })
  || String(left?.file || '').localeCompare(String(right?.file || ''), undefined, { sensitivity: 'base' })
);

const sortManualEntries = (items, sortOrder = 'name') => {
  const sorted = [...items];
  if (sortOrder === 'recent' || sortOrder === 'oldest') {
    sorted.sort((left, right) => {
      const leftDate = getEntryCreatedAt(left);
      const rightDate = getEntryCreatedAt(right);
      if (leftDate || rightDate) {
        if (!leftDate) return 1;
        if (!rightDate) return -1;
        const dateCompare = leftDate.localeCompare(rightDate);
        if (dateCompare) return sortOrder === 'recent' ? -dateCompare : dateCompare;
      }
      return compareEntriesByName(left, right);
    });
    return sorted;
  }

  sorted.sort(compareEntriesByName);
  return sorted;
};

const getRecommendationFileName = (item) => {
  const explicitFile = String(item?.file || '').trim();
  if (explicitFile) return explicitFile;
  const key = String(item?.key || '').trim();
  return key.split('/').filter(Boolean).pop() || key;
};

const getRecommendationCategory = (item) => {
  const explicitCategory = String(item?.category || '').trim();
  if (explicitCategory) return explicitCategory;
  const key = String(item?.key || '').trim();
  return key.includes('/') ? key.split('/')[0] : '';
};

const buildRecommendationQueue = (res, pool = [], limit = 8) => {
  const poolMap = new Map((Array.isArray(pool) ? pool : [])
    .filter(Boolean)
    .map((item) => [item.id, item]));
  const candidates = [
    res?.recommended,
    ...(Array.isArray(res?.alternatives) ? res.alternatives : []),
  ].filter(Boolean);
  const seen = new Set();

  return candidates.map((item) => {
    const category = getRecommendationCategory(item);
    const file = getRecommendationFileName(item);
    const targetEntry = normalizeVocabularyEntry({
      key: file,
      file,
      word: item.word,
      marked: Boolean(item.marked),
      category,
    }, category);
    const poolEntry = poolMap.get(targetEntry.id);
    if (!poolEntry) return null;

    const uniqueKey = String(item.key || `${targetEntry.category}/${targetEntry.file}`).trim();
    if (seen.has(uniqueKey)) return null;
    seen.add(uniqueKey);

    return {
      ...item,
      id: targetEntry.id,
      key: uniqueKey,
      category: targetEntry.category,
      file: targetEntry.file,
      word: targetEntry.word,
      marked: Boolean(poolEntry.marked || item.marked),
      needsProcessing: Boolean(poolEntry.needsProcessing || item.needsProcessing || item.needs_processing),
      needs_processing: Boolean(poolEntry.needsProcessing || item.needsProcessing || item.needs_processing),
      refineCached: Boolean(poolEntry.refineCached || item.refineCached || item.refine_cached),
      refine_cached: Boolean(poolEntry.refineCached || item.refineCached || item.refine_cached),
      relationCached: Boolean(poolEntry.relationCached || item.relationCached || item.relation_cached),
      relation_cached: Boolean(poolEntry.relationCached || item.relationCached || item.relation_cached),
    };
  }).filter(Boolean).slice(0, limit);
};

const pickRandomEntry = (items, currentId = '') => {
  const pool = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!pool.length) return null;
  if (pool.length === 1) return pool[0];

  const nextPool = pool.filter((item) => item.id !== currentId);
  const finalPool = nextPool.length ? nextPool : pool;
  return finalPool[Math.floor(Math.random() * finalPool.length)] || null;
};

const coerceInt = (value) => {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

const tokenizeFocusText = (text) => {
  return (String(text || '').match(FOCUS_RENDER_TOKEN_REGEX) || []).filter((chunk) => !/^\s+$/.test(chunk));
};

const normalizeFocusPositions = (rawFocus, tokenCount = null) => {
  if (!Array.isArray(rawFocus)) return [];

  const values = [];
  const seen = new Set();

  const addIndex = (idx) => {
    if (idx === null || idx < 0) return;
    if (tokenCount !== null && idx >= tokenCount) return;
    if (seen.has(idx)) return;
    seen.add(idx);
    values.push(idx);
  };

  rawFocus.forEach((item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      let idx = null;
      ['index', 'idx', 'position', 'pos', 'tokenIndex', 'token_index', 'focusIndex', 'focus_index', 'i'].some((key) => {
        if (key in item) {
          idx = coerceInt(item[key]);
          return true;
        }
        return false;
      });

      if (idx !== null) {
        addIndex(idx);
        return;
      }

      let start = null;
      let end = null;
      ['start', 'local_start', 'from', 'begin'].some((key) => {
        if (key in item) {
          start = coerceInt(item[key]);
          return true;
        }
        return false;
      });
      ['end', 'local_end', 'to', 'finish'].some((key) => {
        if (key in item) {
          end = coerceInt(item[key]);
          return true;
        }
        return false;
      });

      if (start !== null) {
        const finalEnd = end === null ? start : end;
        const [from, to] = finalEnd < start ? [finalEnd, start] : [start, finalEnd];
        for (let i = from; i <= to; i += 1) addIndex(i);
        return;
      }
    }

    addIndex(coerceInt(item));
  });

  values.sort((a, b) => a - b);
  return values;
};

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const renderTextWithFocusPositions = (text, rawFocus) => {
  const chunks = String(text || '').match(FOCUS_RENDER_TOKEN_REGEX) || [];
  const focusPositions = normalizeFocusPositions(rawFocus, tokenizeFocusText(text).length);
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
};

const renderTextWithFocusWords = (text, focusWords) => {
  let rendered = escapeHtml(text);

  (Array.isArray(focusWords) ? focusWords : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .forEach((focusWord) => {
      const pattern = new RegExp(`(${escapeRegExp(focusWord)})`, 'gi');
      rendered = rendered.replace(pattern, '<strong>$1</strong>');
    });

  return rendered;
};

const formatCategoryLabel = (category) => {
  const normalized = String(category || '').trim();
  if (!normalized) return '根目录';
  return CATEGORY_LABELS[normalized] || normalized;
};

const formatCategoryChoiceLabel = (category) => (
  isAllCategoriesValue(category) ? '全部目录' : formatCategoryLabel(category)
);

const normalizeVocabularyListResponse = (data, normalizedCategory) => {
  const rawEntries = Array.isArray(data?.entries) && data.entries.length
    ? data.entries
    : (Array.isArray(data?.words)
        ? data.words.map((word) => ({
            key: word,
            file: `${normalizeVocabularyLaunchWord(word)}.json`,
            word,
            marked: false,
          }))
        : []);

  return rawEntries.map((entry) => normalizeVocabularyEntry(entry, normalizedCategory));
};

const recommendationMarkFilterFromEntryFilter = (value) => (
  value === 'marked' || value === 'unmarked' || value === 'needs_processing' ? value : 'all'
);

const formatYouTubeLabel = (timestamp) => {
  const totalSeconds = Math.max(0, parseInt(timestamp, 10) || 0);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
};

const buildYouTubeLink = (url, timestamp) => {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) return '';
  const finalTimestamp = Math.max(0, parseInt(timestamp, 10) || 0);
  return `${normalizedUrl}${normalizedUrl.includes('?') ? '&' : '?'}t=${finalTimestamp}s`;
};

const normalizeReviewScore = (score) => Math.max(0, Math.min(5, parseInt(score, 10) || 0));

const normalizeRecommendationPreferences = (value) => {
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
};

const recommendationPreferencesToRatios = (preferences) => {
  const normalized = normalizeRecommendationPreferences(preferences);
  const due = Math.max(0, normalized.due_weight);
  const created = Math.max(0, normalized.created_weight);
  const score = Math.max(0, normalized.score_weight);
  const total = due + created + score;
  if (total <= 0) {
    return {
      due: DEFAULT_RECOMMENDATION_PREFERENCES.due_weight / RECOMMENDATION_TOTAL_WEIGHT,
      created: DEFAULT_RECOMMENDATION_PREFERENCES.created_weight / RECOMMENDATION_TOTAL_WEIGHT,
      score: DEFAULT_RECOMMENDATION_PREFERENCES.score_weight / RECOMMENDATION_TOTAL_WEIGHT,
    };
  }
  return {
    due: due / total,
    created: created / total,
    score: score / total,
  };
};

const recommendationRatiosToPreferences = (ratios, base = {}) => {
  const normalizedBase = normalizeRecommendationPreferences(base);
  return normalizeRecommendationPreferences({
    ...normalizedBase,
    due_weight: (Number(ratios?.due) || 0) * RECOMMENDATION_TOTAL_WEIGHT,
    created_weight: (Number(ratios?.created) || 0) * RECOMMENDATION_TOTAL_WEIGHT,
    score_weight: (Number(ratios?.score) || 0) * RECOMMENDATION_TOTAL_WEIGHT,
  });
};

const recommendationRatiosToTrianglePoint = (ratios) => ({
  x: RECOMMENDATION_TRIANGLE_POINTS.due.x * ratios.due
    + RECOMMENDATION_TRIANGLE_POINTS.created.x * ratios.created
    + RECOMMENDATION_TRIANGLE_POINTS.score.x * ratios.score,
  y: RECOMMENDATION_TRIANGLE_POINTS.due.y * ratios.due
    + RECOMMENDATION_TRIANGLE_POINTS.created.y * ratios.created
    + RECOMMENDATION_TRIANGLE_POINTS.score.y * ratios.score,
});

const recommendationTrianglePointToRatios = (point) => {
  const a = RECOMMENDATION_TRIANGLE_POINTS.due;
  const b = RECOMMENDATION_TRIANGLE_POINTS.created;
  const c = RECOMMENDATION_TRIANGLE_POINTS.score;
  const denominator = ((b.y - c.y) * (a.x - c.x)) + ((c.x - b.x) * (a.y - c.y));
  const due = (((b.y - c.y) * (point.x - c.x)) + ((c.x - b.x) * (point.y - c.y))) / denominator;
  const created = (((c.y - a.y) * (point.x - c.x)) + ((a.x - c.x) * (point.y - c.y))) / denominator;
  const score = 1 - due - created;
  const clamped = {
    due: Math.max(0, due),
    created: Math.max(0, created),
    score: Math.max(0, score),
  };
  const total = clamped.due + clamped.created + clamped.score || 1;
  return {
    due: clamped.due / total,
    created: clamped.created / total,
    score: clamped.score / total,
  };
};

const recommendationPreferencesToTrianglePoint = (preferences) => (
  recommendationRatiosToTrianglePoint(recommendationPreferencesToRatios(preferences))
);

const randomRecommendationTrianglePoint = () => {
  const raw = [Math.random(), Math.random(), Math.random()];
  const total = raw.reduce((sum, value) => sum + value, 0) || 1;
  return recommendationRatiosToTrianglePoint({
    due: raw[0] / total,
    created: raw[1] / total,
    score: raw[2] / total,
  });
};

const formatRecommendationWeightValue = (value) => Number(value || 0).toFixed(2);

const recommendationPreferencesFromConfig = (config) => normalizeRecommendationPreferences({
  due_weight: config?.review_recommend_due_weight,
  created_weight: config?.review_recommend_created_weight,
  score_weight: config?.review_recommend_score_weight,
  created_order: config?.review_recommend_created_order,
  score_order: config?.review_recommend_score_order,
});

const recommendationPreferencesToConfig = (preferences) => {
  const normalized = normalizeRecommendationPreferences(preferences);
  return {
    review_recommend_due_weight: normalized.due_weight,
    review_recommend_created_weight: normalized.created_weight,
    review_recommend_score_weight: normalized.score_weight,
    review_recommend_created_order: normalized.created_order,
    review_recommend_score_order: normalized.score_order,
  };
};

const recommendationPreferencesKey = (preferences) => {
  const normalized = normalizeRecommendationPreferences(preferences);
  return [
    normalized.due_weight.toFixed(2),
    normalized.created_weight.toFixed(2),
    normalized.score_weight.toFixed(2),
    normalized.created_order,
    normalized.score_order,
  ].join('|');
};

const formatRecommendationPreferenceSummary = (preferences) => {
  const normalized = normalizeRecommendationPreferences(preferences);
  const created = normalized.created_order === 'oldest' ? '最早加入' : '最近加入';
  const score = normalized.score_order === 'high' ? '高分优先' : '低分优先';
  return `${created} · ${score}`;
};

function RecommendationSegmentControl({ label, value, options, onChange }) {
  return (
    <label className="vocab-recommend-segment-field">
      <span>{label}</span>
      <span className="vocab-recommend-segment" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? 'active' : ''}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </span>
    </label>
  );
}

function RecommendationDirectionControls({ preferences, onChange }) {
  const normalized = normalizeRecommendationPreferences(preferences);
  return (
    <div className="vocab-recommend-direction-grid">
      <RecommendationSegmentControl
        label="创建时间"
        value={normalized.created_order}
        options={[
          { value: 'recent', label: '最近' },
          { value: 'oldest', label: '最早' },
        ]}
        onChange={(created_order) => onChange({ created_order })}
      />
      <RecommendationSegmentControl
        label="熟练度"
        value={normalized.score_order}
        options={[
          { value: 'low', label: '低分' },
          { value: 'high', label: '高分' },
        ]}
        onChange={(score_order) => onChange({ score_order })}
      />
    </div>
  );
}

function RecommendationStrategyPresets({ preferences, onChange }) {
  const currentKey = recommendationPreferencesKey(preferences);
  return (
    <div className="vocab-recommend-preset-grid">
      {RECOMMENDATION_STRATEGY_PRESETS.map((preset) => {
        const active = recommendationPreferencesKey(preset.preferences) === currentKey;
        return (
          <button
            key={preset.key}
            type="button"
            className={`vocab-recommend-preset${active ? ' is-active' : ''}`}
            onClick={() => onChange(preset.preferences)}
          >
            <strong>{preset.title}</strong>
          </button>
        );
      })}
    </div>
  );
}

function RecommendationTriangleTuner({
  preferences,
  point,
  onChange,
  onPointChange,
}) {
  const svgRef = useRef(null);
  const draggingRef = useRef(false);
  const normalized = normalizeRecommendationPreferences(preferences);
  const ratios = recommendationPreferencesToRatios(normalized);
  const activePoint = point || recommendationPreferencesToTrianglePoint(normalized);
  const polygonPoints = `${RECOMMENDATION_TRIANGLE_POINTS.due.x},${RECOMMENDATION_TRIANGLE_POINTS.due.y} ${RECOMMENDATION_TRIANGLE_POINTS.created.x},${RECOMMENDATION_TRIANGLE_POINTS.created.y} ${RECOMMENDATION_TRIANGLE_POINTS.score.x},${RECOMMENDATION_TRIANGLE_POINTS.score.y}`;

  const commitPoint = useCallback((nextPoint) => {
    const ratiosFromPoint = recommendationTrianglePointToRatios(nextPoint);
    const normalizedPoint = recommendationRatiosToTrianglePoint(ratiosFromPoint);
    onPointChange?.(normalizedPoint);
    onChange?.(recommendationRatiosToPreferences(ratiosFromPoint, normalized));
  }, [normalized, onChange, onPointChange]);

  const pointFromEvent = useCallback((event) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM?.();
    if (!svg || !matrix) return null;
    const svgPoint = svg.createSVGPoint();
    svgPoint.x = event.clientX;
    svgPoint.y = event.clientY;
    return svgPoint.matrixTransform(matrix.inverse());
  }, []);

  const handlePointerDown = useCallback((event) => {
    event.preventDefault();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const nextPoint = pointFromEvent(event);
    if (nextPoint) commitPoint(nextPoint);
  }, [commitPoint, pointFromEvent]);

  const handlePointerMove = useCallback((event) => {
    if (!draggingRef.current && !(event.buttons & 1)) return;
    event.preventDefault();
    const nextPoint = pointFromEvent(event);
    if (nextPoint) commitPoint(nextPoint);
  }, [commitPoint, pointFromEvent]);

  const handlePointerEnd = useCallback((event) => {
    draggingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  const handleKeyDown = useCallback((event) => {
    const step = event.shiftKey ? 18 : 9;
    const nextPoint = { ...activePoint };
    if (event.key === 'ArrowLeft') nextPoint.x -= step;
    else if (event.key === 'ArrowRight') nextPoint.x += step;
    else if (event.key === 'ArrowUp') nextPoint.y -= step;
    else if (event.key === 'ArrowDown') nextPoint.y += step;
    else return;
    event.preventDefault();
    commitPoint(nextPoint);
  }, [activePoint, commitPoint]);

  return (
    <div className="vocab-recommend-triangle-card">
      <svg
        ref={svgRef}
        className="vocab-recommend-triangle"
        viewBox={`0 0 ${RECOMMENDATION_TRIANGLE_SIZE} ${RECOMMENDATION_TRIANGLE_SIZE}`}
        role="slider"
        tabIndex={0}
        aria-label="随机推荐策略重心"
        aria-valuetext={`到期 ${formatRecommendationWeightValue(normalized.due_weight)}，创建 ${formatRecommendationWeightValue(normalized.created_weight)}，评分 ${formatRecommendationWeightValue(normalized.score_weight)}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onKeyDown={handleKeyDown}
      >
        <polygon className="vocab-recommend-triangle-bg" points={polygonPoints} />
        {Object.entries(RECOMMENDATION_TRIANGLE_POINTS).map(([key, vertex]) => (
          <g key={key}>
            <line
              className="vocab-recommend-triangle-axis"
              x1={activePoint.x}
              y1={activePoint.y}
              x2={vertex.x}
              y2={vertex.y}
            />
            <circle className="vocab-recommend-triangle-node" cx={vertex.x} cy={vertex.y} r="5" />
            <text
              className="vocab-recommend-triangle-label"
              x={vertex.x}
              y={vertex.y + (key === 'due' ? -12 : 18)}
              textAnchor="middle"
            >
              {vertex.label}
            </text>
          </g>
        ))}
        <circle className="vocab-recommend-triangle-pointer-shadow" cx={activePoint.x} cy={activePoint.y} r="13" />
        <circle className="vocab-recommend-triangle-pointer" cx={activePoint.x} cy={activePoint.y} r="8" />
      </svg>
      <div className="vocab-recommend-ratio-row">
        <span>到期 {Math.round(ratios.due * 100)}%</span>
        <span>创建 {Math.round(ratios.created * 100)}%</span>
        <span>熟练 {Math.round(ratios.score * 100)}%</span>
      </div>
    </div>
  );
}

function RecommendationHybridTuner({
  preferences,
  point,
  fineTuneOpen,
  onChange,
  onPointChange,
  onFineTuneOpenChange,
}) {
  const normalized = normalizeRecommendationPreferences(preferences);
  const finePanelRef = useRef(null);
  const handlePresetChange = useCallback((nextPreferences) => {
    const next = normalizeRecommendationPreferences(nextPreferences);
    onPointChange?.(recommendationPreferencesToTrianglePoint(next));
    onChange?.(next);
  }, [onChange, onPointChange]);

  useEffect(() => {
    if (!fineTuneOpen) return undefined;
    const frame = requestAnimationFrame(() => {
      finePanelRef.current?.scrollIntoView?.({
        block: 'center',
        inline: 'nearest',
        behavior: 'auto',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [fineTuneOpen]);

  return (
    <div className="vocab-recommend-hybrid-card">
      <div className="vocab-recommend-hybrid-head">
        <div>
          <strong>推荐策略</strong>
          <span>{formatRecommendationPreferenceSummary(normalized)}</span>
        </div>
      </div>
      <RecommendationStrategyPresets preferences={normalized} onChange={handlePresetChange} />
      <button
        type="button"
        className={`vocab-recommend-fine-toggle${fineTuneOpen ? ' is-active' : ''}`}
        onClick={() => onFineTuneOpenChange(!fineTuneOpen)}
        aria-expanded={fineTuneOpen}
      >
        <UiIcon name={fineTuneOpen ? 'chevron-up' : 'chevron-down'} size={16} />
        <span>精调</span>
      </button>
      {fineTuneOpen ? (
        <div className="vocab-recommend-fine-panel" ref={finePanelRef}>
          <RecommendationTriangleTuner
            preferences={normalized}
            point={point}
            onChange={onChange}
            onPointChange={onPointChange}
          />
          <RecommendationDirectionControls preferences={normalized} onChange={onChange} />
        </div>
      ) : null}
      <div className="vocab-recommend-values">
        <span><strong>到期</strong>{formatRecommendationWeightValue(normalized.due_weight)}</span>
        <span><strong>{normalized.created_order === 'oldest' ? '最早' : '最近'}</strong>{formatRecommendationWeightValue(normalized.created_weight)}</span>
        <span><strong>{normalized.score_order === 'high' ? '高分' : '低分'}</strong>{formatRecommendationWeightValue(normalized.score_weight)}</span>
      </div>
    </div>
  );
}

const buildYoudaoUrl = (word) => {
  const normalized = String(word || '').trim();
  if (!normalized) return '';
  return `https://www.youdao.com/result?word=${encodeURIComponent(normalized)}&lang=en`;
};

const chipStyle = () => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '6px 10px',
  borderRadius: '4px',
  background: 'var(--ms-surface-strong)',
  color: 'var(--ms-text-muted)',
  border: '1px solid var(--ms-border)',
  fontSize: '12px',
  fontWeight: '600',
});

const sectionTitleStyle = {
  borderBottom: '1px solid var(--ms-border)',
  paddingBottom: '10px',
  margin: 0,
  fontSize: '13px',
  color: 'var(--ms-text-muted)',
  fontWeight: 700,
};

const metaCardStyle = {
  background: 'var(--ms-surface-strong)',
  border: '1px solid var(--ms-border)',
  borderRadius: '6px',
  padding: '20px',
};

const getReviewToneStyle = (score) => {
  const normalizedScore = normalizeReviewScore(score);

  if (normalizedScore >= 4) {
    return {
      color: 'var(--ms-success)',
      background: 'var(--ms-success-soft)',
      border: '1px solid rgba(15, 118, 110, 0.16)',
    };
  }

  if (normalizedScore <= 1) {
    return {
      color: 'var(--ms-danger)',
      background: 'var(--ms-danger-soft)',
      border: '1px solid rgba(180, 35, 24, 0.14)',
    };
  }

  return {
    color: 'var(--ms-text)',
    background: 'var(--ms-surface-muted)',
    border: '1px solid var(--ms-border)',
  };
};

export default function VocabularyReview({
  onSelectionChange = null,
  onVisibleScopeChange = null,
  prefetchedRefineRequest = null,
  launchRequest = null,
  entryUpdateRequest = null,
  mobileSimple = false,
  compactDesktop = false,
  compactViewport = false,
  selectionMode = 'random',
  workspaceToolbarControlsHost = null,
}) {
  const randomSelectionMode = selectionMode === 'random';
  const [entries, setEntries] = useState([]);
  const [entriesCategory, setEntriesCategory] = useState('');
  const [selectedEntryId, setSelectedEntryId] = useState('');
  const [selectedEntrySnapshot, setSelectedEntrySnapshot] = useState(null);
  const [detailData, setDetailData] = useState(null);
  const [detailCategory, setDetailCategory] = useState('');
  const [categories, setCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(() => (
    (mobileSimple || compactDesktop || randomSelectionMode)
      ? ALL_CATEGORIES_VALUE
      : (getStoredReviewCategory() || ALL_CATEGORIES_VALUE)
  ));
  const [wordQuery, setWordQuery] = useState('');
  const [entryFilter, setEntryFilter] = useState(() => ((mobileSimple || compactDesktop || randomSelectionMode) ? 'all' : 'marked'));
  const [manualSortOrder, setManualSortOrder] = useState('name');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [mobileInfoOpen, setMobileInfoOpen] = useState(false);
  const [desktopContentDefaultCollapsed, setDesktopContentDefaultCollapsed] = useState(() => getStoredDesktopContentDefaultCollapsed());
  const [desktopDefinitionsCollapsed, setDesktopDefinitionsCollapsed] = useState(() => getStoredDesktopContentDefaultCollapsed());
  const [desktopExampleNoteCollapsedOverrides, setDesktopExampleNoteCollapsedOverrides] = useState({});
  const [mobileDefinitionsCollapsed, setMobileDefinitionsCollapsed] = useState(true);
  const [relationGraphFullComponent, setRelationGraphFullComponent] = useState(getStoredRelationGraphFullComponent);
  const [recommendSettingsOpen, setRecommendSettingsOpen] = useState(false);
  const [savingMarked, setSavingMarked] = useState(false);
  const [savingReviewScore, setSavingReviewScore] = useState(false);
  const [loadingRecommendation, setLoadingRecommendation] = useState(false);
  const [loadingRecommendationQueue, setLoadingRecommendationQueue] = useState(false);
  const [savingRecommendPreferences, setSavingRecommendPreferences] = useState(false);
  const [recommendation, setRecommendation] = useState(null);
  const [recommendationQueue, setRecommendationQueue] = useState([]);
  const [recommendExcludeKeys, setRecommendExcludeKeys] = useState([]);
  const [recommendScope, setRecommendScope] = useState(ALL_RECOMMEND_SCOPE);
  const [relationGraphData, setRelationGraphData] = useState(null);
  const [relationGraphLoading, setRelationGraphLoading] = useState(false);
  const [recommendPreferences, setRecommendPreferences] = useState(() => (
    normalizeRecommendationPreferences(DEFAULT_RECOMMENDATION_PREFERENCES)
  ));
  const [recommendationTrianglePoint, setRecommendationTrianglePoint] = useState(() => (
    recommendationPreferencesToTrianglePoint(DEFAULT_RECOMMENDATION_PREFERENCES)
  ));
  const [recommendFineTuneOpen, setRecommendFineTuneOpen] = useState(false);
  const [recommendPreferenceHydrated, setRecommendPreferenceHydrated] = useState(false);
  const [recommendPreferenceDirty, setRecommendPreferenceDirty] = useState(false);
  const pendingLaunchRef = useRef(null);
  const selectedCategoryRef = useRef(selectedCategory);
  const entriesRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const handledEntryUpdateTokenRef = useRef('');
  const handledPrefetchedRefineTokenRef = useRef('');
  const handledLaunchRequestKeyRef = useRef('');
  const recommendPreferenceHydratedRef = useRef(false);
  const recommendPreferenceDirtyRef = useRef(false);
  const recommendPreferencesRef = useRef(normalizeRecommendationPreferences(DEFAULT_RECOMMENDATION_PREFERENCES));
  const savedRecommendPreferenceKeyRef = useRef(recommendationPreferencesKey(DEFAULT_RECOMMENDATION_PREFERENCES));
  const recommendPreferenceSaveRequestRef = useRef(0);
  const recommendationQueueRequestRef = useRef(0);
  const recommendationRefreshRequestRef = useRef(0);
  const relationGraphRequestRef = useRef(0);
  const fullComponentGraphCacheRef = useRef(null);
  const autoRecommendationPoolKeyRef = useRef('');
  const randomSelectionModeRef = useRef(randomSelectionMode);
  const infoButtonRef = useRef(null);
  const sidebarWordListRef = useRef(null);
  const [mobileInfoPanelPosition, setMobileInfoPanelPosition] = useState(null);
  const desktopOverviewLeftRef = useRef(null);
  const [desktopOverviewLeftHeight, setDesktopOverviewLeftHeight] = useState(0);

  randomSelectionModeRef.current = randomSelectionMode;

  const updateMobileInfoPanelPosition = useCallback(() => {
    if (typeof window === 'undefined') return;
    const button = infoButtonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const margin = 8;
    const panelWidth = Math.min(300, Math.max(180, viewportWidth - margin * 2));
    const minPanelHeight = Math.min(180, Math.max(120, viewportHeight - margin * 2));
    const leftLimit = Math.max(margin, viewportWidth - panelWidth - margin);
    const topLimit = Math.max(margin, viewportHeight - minPanelHeight - margin);
    const nextLeft = Math.min(
      Math.max(rect.left + rect.width / 2 - panelWidth / 2, margin),
      leftLimit,
    );
    const nextTop = Math.min(Math.max(rect.bottom + margin, margin), topLimit);
    const nextMaxHeight = Math.max(120, Math.min(420, viewportHeight - nextTop - margin));

    setMobileInfoPanelPosition((current) => {
      if (
        current
        && current.left === nextLeft
        && current.top === nextTop
        && current.maxHeight === nextMaxHeight
      ) {
        return current;
      }
      return {
        left: nextLeft,
        top: nextTop,
        maxHeight: nextMaxHeight,
      };
    });
  }, []);

  const handleDesktopContentDefaultCollapsedChange = useCallback((collapsed) => {
    setDesktopContentDefaultCollapsed(collapsed);
    setDesktopDefinitionsCollapsed(collapsed);
    setDesktopExampleNoteCollapsedOverrides({});
    localStorage.setItem(DESKTOP_CONTENT_COLLAPSED_KEY, collapsed ? '1' : '0');
  }, []);

  const handleDesktopExampleNoteToggle = useCallback((index) => {
    const key = String(index);
    setDesktopExampleNoteCollapsedOverrides((current) => {
      const currentCollapsed = Object.prototype.hasOwnProperty.call(current, key)
        ? Boolean(current[key])
        : desktopContentDefaultCollapsed;
      return {
        ...current,
        [key]: !currentCollapsed,
      };
    });
  }, [desktopContentDefaultCollapsed]);

  const handleRelationGraphFullComponentChange = useCallback((enabled) => {
    const nextEnabled = Boolean(enabled);
    setRelationGraphFullComponent(nextEnabled);
    localStorage.setItem(RELATION_GRAPH_FULL_COMPONENT_KEY, nextEnabled ? '1' : '0');
  }, []);

  useEffect(() => {
    recommendPreferencesRef.current = normalizeRecommendationPreferences(recommendPreferences);
  }, [recommendPreferences]);

  const resetCurrentEntry = useCallback((nextEntries = []) => {
    detailRequestRef.current += 1;
    setEntries(nextEntries);
    setEntriesCategory('');
    setSelectedEntryId('');
    setSelectedEntrySnapshot(null);
    setDetailData(null);
    setDetailCategory('');
  }, []);

  const applySelectedCategory = useCallback((nextCategory, { resetQuery = true } = {}) => {
    const normalizedCategory = String(nextCategory || '').trim();
    setSelectedCategory(normalizedCategory);
    setRecommendScope(
      normalizedCategory && !isAllCategoriesValue(normalizedCategory)
        ? normalizedCategory
        : ALL_RECOMMEND_SCOPE,
    );
    setRecommendExcludeKeys([]);
    setRecommendation(null);
    setRecommendationQueue([]);
    autoRecommendationPoolKeyRef.current = '';
    resetCurrentEntry([]);
    if (resetQuery) setWordQuery('');
  }, [resetCurrentEntry]);

  const resolveEntryCandidate = useCallback((entryLike, categoryOverride = selectedCategory, pool = entries) => {
    if (entryLike && typeof entryLike === 'object' && !Array.isArray(entryLike)) {
      return normalizeVocabularyEntry(entryLike, categoryOverride);
    }

    const lookup = normalizeVocabularyLaunchWord(entryLike);
    if (!lookup) return null;

    return pool.find((item) => (
      buildVocabularyWordKey(item.file) === buildVocabularyWordKey(lookup)
      || buildVocabularyWordKey(item.key) === buildVocabularyWordKey(lookup)
      || buildVocabularyWordKey(item.word) === buildVocabularyWordKey(lookup)
    )) || normalizeVocabularyEntry({
      key: lookup,
      file: `${lookup}.json`,
      word: lookup,
      marked: false,
    }, categoryOverride);
  }, [entries, selectedCategory]);

  const resolveEntryCategory = useCallback((entryLike, categoryOverride = selectedCategory) => {
    const normalizedCategory = String(categoryOverride || '').trim();
    if (!isAllCategoriesValue(normalizedCategory)) return normalizedCategory;

    const entryCategory = String(entryLike?.category || '').trim();
    return isAllCategoriesValue(entryCategory) ? '' : entryCategory;
  }, [selectedCategory]);

  const loadCategories = useCallback(async () => {
    try {
      const data = await getVocabularyCategories();
      if (data.categories) setCategories(data.categories);
    } catch (e) {
      console.error('加载目录失败', e);
    }
  }, []);

  const loadEntries = useCallback(async (categoryStr) => {
    const normalizedCategory = String(categoryStr || '').trim();
    const requestId = entriesRequestRef.current + 1;
    entriesRequestRef.current = requestId;

    if (!normalizedCategory) {
      setEntriesCategory('');
      return;
    }

    try {
      if (isAllCategoriesValue(normalizedCategory)) {
        const loadedCategories = Array.isArray(categories) && categories.length
          ? categories
          : (await getVocabularyCategories())?.categories || [];
        const normalizedCategories = [...new Set(loadedCategories
          .map((item) => String(item || '').trim())
          .filter(Boolean))];

        if (!normalizedCategories.length) {
          if (entriesRequestRef.current !== requestId) return;
          setEntries([]);
          setEntriesCategory(normalizedCategory);
          return;
        }

        const groupedEntries = await Promise.all(normalizedCategories.map(async (categoryName) => {
          try {
            const data = await getVocabularyList(categoryName);
            return normalizeVocabularyListResponse(data, categoryName);
          } catch (error) {
            console.error(`加载目录 ${categoryName} 单词列表失败`, error);
            return [];
          }
        }));

        if (entriesRequestRef.current !== requestId) return;
        const mergedEntries = groupedEntries
          .flat()
          .sort(compareEntriesByName);
        setEntries(mergedEntries);
        setEntriesCategory(normalizedCategory);
        return;
      }

      const data = await getVocabularyList(normalizedCategory);
      if (entriesRequestRef.current !== requestId) return;
      setEntries(normalizeVocabularyListResponse(data, normalizedCategory));
      setEntriesCategory(normalizedCategory);
    } catch (e) {
      if (entriesRequestRef.current !== requestId) return;
      console.error('加载单词列表失败', e);
      setEntries([]);
      setEntriesCategory(normalizedCategory);
    }
  }, [categories]);

  const handleSelectEntry = useCallback(async (
    entryLike,
    categoryOverride = selectedCategory,
    pool = entries,
    options = {},
  ) => {
    const resolvedEntry = resolveEntryCandidate(entryLike, categoryOverride, pool);
    if (!resolvedEntry) return;

    const normalizedCategory = String(categoryOverride || '').trim();
    const requestCategory = resolveEntryCategory(resolvedEntry, normalizedCategory);
    if (!requestCategory) return;
    const keepDetailWhileLoading = Boolean(options?.keepDetailWhileLoading);
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setSelectedEntryId(resolvedEntry.id);
    setSelectedEntrySnapshot(resolvedEntry);
    if (!keepDetailWhileLoading) {
      setDetailData(null);
    }
    setDetailCategory(requestCategory);
    if (typeof onSelectionChange === 'function') {
      onSelectionChange({
        category: requestCategory,
        word: resolvedEntry.key || resolvedEntry.file || resolvedEntry.word,
        fileKey: resolvedEntry.file || resolvedEntry.key || resolvedEntry.word,
      });
    }
    try {
      const res = await getVocabularyDetail(resolvedEntry.key || resolvedEntry.file || resolvedEntry.word, requestCategory);
      if (detailRequestRef.current !== requestId) return;
      if (res.data) setDetailData(res.data);
    } catch (error) {
      if (detailRequestRef.current !== requestId) return;
      if (selectedCategoryRef.current !== normalizedCategory) return;
      setDetailCategory('');
      setDetailData(null);
      console.error('加载详情失败', error);
      alert('加载详情失败');
    }
  }, [entries, onSelectionChange, resolveEntryCandidate, resolveEntryCategory, selectedCategory]);

  useEffect(() => {
    selectedCategoryRef.current = selectedCategory;
  }, [selectedCategory]);

  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((config) => {
        if (cancelled) return;
        const nextPreferences = recommendationPreferencesFromConfig(config || {});
        const nextKey = recommendationPreferencesKey(nextPreferences);
        savedRecommendPreferenceKeyRef.current = nextKey;
        if (!recommendPreferenceDirtyRef.current) {
          recommendPreferencesRef.current = nextPreferences;
          recommendPreferenceDirtyRef.current = false;
          setRecommendPreferenceDirty(false);
          setRecommendPreferences(nextPreferences);
          setRecommendationTrianglePoint(recommendationPreferencesToTrianglePoint(nextPreferences));
        }
      })
      .catch((error) => {
        console.error('读取推荐偏好失败', error);
      })
      .finally(() => {
        if (!cancelled) {
          recommendPreferenceHydratedRef.current = true;
          setRecommendPreferenceHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!mobileInfoOpen) {
      setMobileInfoPanelPosition(null);
      return undefined;
    }

    updateMobileInfoPanelPosition();
    let frame = 0;
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateMobileInfoPanelPosition);
    };

    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
    };
  }, [mobileInfoOpen, updateMobileInfoPanelPosition]);

  useEffect(() => {
    if (mobileSimple) {
      setDesktopOverviewLeftHeight(0);
      return undefined;
    }

    const node = desktopOverviewLeftRef.current;
    if (!node) return undefined;

    let frame = 0;
    const updateHeight = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        const nextHeight = Math.max(0, Math.round(rect.height || 0));
        setDesktopOverviewLeftHeight((current) => (
          Math.abs(current - nextHeight) > 1 ? nextHeight : current
        ));
      });
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);
    window.addEventListener('resize', updateHeight);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', updateHeight);
    };
  }, [detailData, desktopDefinitionsCollapsed, mobileSimple]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadCategories();
    });

    const handleConfigUpdate = () => {
      if (isAllCategoriesValue(selectedCategoryRef.current)) {
        return;
      }
      const nextCategory = getStoredReviewCategory() || ALL_CATEGORIES_VALUE;
      if (nextCategory === selectedCategoryRef.current) return;
      applySelectedCategory(nextCategory);
    };

    window.addEventListener('config-updated', handleConfigUpdate);
    window.addEventListener('default-category-updated', handleConfigUpdate);

    return () => {
      window.removeEventListener('config-updated', handleConfigUpdate);
      window.removeEventListener('default-category-updated', handleConfigUpdate);
    };
  }, [applySelectedCategory, loadCategories]);

  useEffect(() => {
    if (isAllCategoriesValue(selectedCategory)) return;
    localStorage.setItem(REVIEW_CATEGORY_KEY, selectedCategory || '');
  }, [selectedCategory]);

  useEffect(() => {
    const normalizedCategory = String(selectedCategory || '').trim();
    const nextScope = normalizedCategory && !isAllCategoriesValue(normalizedCategory)
      ? normalizedCategory
      : ALL_RECOMMEND_SCOPE;
    if (recommendScope === nextScope) return;
    setRecommendScope(nextScope);
    setRecommendExcludeKeys([]);
    setRecommendation(null);
    setRecommendationQueue([]);
  }, [recommendScope, selectedCategory]);

  useEffect(() => {
    if (!String(selectedCategory || '').trim()) {
      resetCurrentEntry([]);
      setWordQuery('');
      return;
    }

    queueMicrotask(() => {
      void loadEntries(selectedCategory);
    });
  }, [loadEntries, resetCurrentEntry, selectedCategory]);

  useEffect(() => {
    if (!launchRequest?.word && !launchRequest?.filename && !launchRequest?.fileKey) return;

    const launchRequestKey = buildLaunchRequestKey(launchRequest);
    if (!launchRequestKey || handledLaunchRequestKeyRef.current === launchRequestKey) return;
    handledLaunchRequestKeyRef.current = launchRequestKey;

    const targetCategory = String(launchRequest.category || '').trim();
    const targetWord = normalizeVocabularyLaunchWord(launchRequest.word || launchRequest.filename || launchRequest.fileKey);
    const targetFileKey = normalizeVocabularyLaunchWord(launchRequest.fileKey || launchRequest.filename || launchRequest.word);
    const browsingAllCategories = isAllCategoriesValue(selectedCategory);
    if (!targetWord && !targetFileKey) return;

    const currentEntry = entries.find((item) => item.id === selectedEntryId) || null;
    const currentEntryCategory = detailCategory || resolveEntryCategory(currentEntry, selectedCategory);
    const currentEntryKey = normalizeVocabularyLaunchWord(currentEntry?.file || currentEntry?.key || currentEntry?.word);
    const sameEntry = currentEntryKey
      && (buildVocabularyWordKey(currentEntryKey) === buildVocabularyWordKey(targetFileKey || targetWord))
      && (!targetCategory || targetCategory === currentEntryCategory);
    if (sameEntry) return;

    pendingLaunchRef.current = {
      category: targetCategory,
      word: targetWord,
      fileKey: targetFileKey,
    };

    if (targetCategory && !browsingAllCategories && targetCategory !== selectedCategory) {
      queueMicrotask(() => {
        applySelectedCategory(targetCategory);
      });
      return;
    }

    const fallbackCategory = browsingAllCategories ? (targetCategory || selectedCategory) : targetCategory;
    const matchedEntry = resolveEntryCandidate(targetFileKey || targetWord, fallbackCategory, entries)
      || resolveEntryCandidate(targetWord, fallbackCategory, entries);
    pendingLaunchRef.current = null;
    queueMicrotask(() => {
      void handleSelectEntry(
        matchedEntry || targetFileKey || targetWord,
        browsingAllCategories ? selectedCategory : targetCategory,
        entries,
      );
    });
  }, [applySelectedCategory, detailCategory, entries, handleSelectEntry, launchRequest, resolveEntryCandidate, resolveEntryCategory, selectedCategory, selectedEntryId]);

  useEffect(() => {
    const pendingLaunch = pendingLaunchRef.current;
    if (!pendingLaunch) return;
    if (pendingLaunch.category !== selectedCategory && !isAllCategoriesValue(selectedCategory)) return;
    if (entriesCategory !== selectedCategory) return;

    const fallbackCategory = isAllCategoriesValue(selectedCategory)
      ? (pendingLaunch.category || selectedCategory)
      : pendingLaunch.category;
    const matchedEntry = resolveEntryCandidate(pendingLaunch.fileKey || pendingLaunch.word, fallbackCategory, entries)
      || resolveEntryCandidate(pendingLaunch.word, fallbackCategory, entries);
    pendingLaunchRef.current = null;
    queueMicrotask(() => {
      void handleSelectEntry(
        matchedEntry || pendingLaunch.fileKey || pendingLaunch.word,
        isAllCategoriesValue(selectedCategory) ? selectedCategory : pendingLaunch.category,
        entries,
      );
    });
  }, [entries, entriesCategory, handleSelectEntry, resolveEntryCandidate, selectedCategory]);

  useEffect(() => {
    const updateToken = String(entryUpdateRequest?.token || '');
    if (!updateToken || handledEntryUpdateTokenRef.current === updateToken) return;
    handledEntryUpdateTokenRef.current = updateToken;

    const targetCategory = String(entryUpdateRequest.category || '').trim();
    const targetFile = normalizeVocabularyLaunchWord(
      entryUpdateRequest.file
      || entryUpdateRequest.target_file
      || entryUpdateRequest.filename
      || entryUpdateRequest.fileKey
      || entryUpdateRequest.word,
    );
    if (!targetCategory || !targetFile) return;

    const nextEntry = normalizeVocabularyEntry({
      key: targetFile,
      file: targetFile.endsWith('.json') ? targetFile : `${targetFile}.json`,
      word: entryUpdateRequest.data?.word || entryUpdateRequest.word || targetFile,
      marked: Boolean(entryUpdateRequest.data?.marked),
      refineCached: false,
      refine_cached: false,
      relationCached: false,
      relation_cached: false,
      category: targetCategory,
    }, targetCategory);
    const browsingAllCategories = isAllCategoriesValue(selectedCategory);
    const shouldSelectUpdatedEntry = browsingAllCategories || selectedCategory === targetCategory;

    if (shouldSelectUpdatedEntry) {
      setEntries((prev) => {
        const sourceFile = normalizeVocabularyLaunchWord(entryUpdateRequest.source_file || '');
        const filtered = sourceFile
          ? prev.filter((item) => !(
              item.category === targetCategory
              && buildVocabularyWordKey(item.file || item.key || item.word) === buildVocabularyWordKey(sourceFile)
            ))
          : prev;
        const existingIndex = filtered.findIndex((item) => item.id === nextEntry.id);
        if (existingIndex >= 0) {
          const next = [...filtered];
          next[existingIndex] = {
            ...next[existingIndex],
            ...nextEntry,
          };
          return next;
        }
        return [...filtered, nextEntry].sort(compareEntriesByName);
      });

      setSelectedEntryId(nextEntry.id);
      setSelectedEntrySnapshot(nextEntry);
      setDetailCategory(targetCategory);
      if (entryUpdateRequest.data) {
        setDetailData(entryUpdateRequest.data);
      }
    }

    queueMicrotask(() => {
      void loadEntries(selectedCategory);
    });
  }, [entryUpdateRequest, loadEntries, selectedCategory]);

  useEffect(() => {
    const updateToken = String(prefetchedRefineRequest?.token || '');
    if (!updateToken || handledPrefetchedRefineTokenRef.current === updateToken) return;
    handledPrefetchedRefineTokenRef.current = updateToken;

    const targetCategory = String(prefetchedRefineRequest.category || '').trim();
    const files = new Set((Array.isArray(prefetchedRefineRequest.files) ? prefetchedRefineRequest.files : [])
      .map((file) => String(file || '').trim())
      .filter(Boolean));
    if (!targetCategory || !files.size) return;

    setEntries((prev) => prev.map((item) => (
      String(item.category || '').trim() === targetCategory && files.has(String(item.file || '').trim())
        ? { ...item, refineCached: true, refine_cached: true }
        : item
    )));
    setSelectedEntrySnapshot((prev) => (
      prev
      && String(prev.category || '').trim() === targetCategory
      && files.has(String(prev.file || '').trim())
        ? { ...prev, refineCached: true, refine_cached: true }
        : prev
    ));
  }, [prefetchedRefineRequest]);

  const playAudio = (text, type = 2) => {
    if (!('speechSynthesis' in window)) {
      alert('您的浏览器不支持语音朗读功能');
      return;
    }

    try {
      window.speechSynthesis.cancel();
      const formattedText = String(text || '').replace(/-/g, ' ');
      const utterance = new SpeechSynthesisUtterance(formattedText);
      utterance.lang = type === 2 ? 'en-US' : 'en-GB';
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      console.error('本地语音播放失败:', error);
    }
  };

  const selectedEntry = entries.find((item) => item.id === selectedEntryId)
    || (selectedEntrySnapshot?.id === selectedEntryId ? selectedEntrySnapshot : null);
  const relationGraphRefreshToken = String(entryUpdateRequest?.token || '');
  const relationGraphFetchScope = useMemo(() => {
    if (!selectedEntry && !detailCategory) return null;
    if (relationGraphFullComponent || isAllCategoriesValue(selectedCategory)) return '';
    return String(detailCategory || selectedEntry?.category || selectedCategory || '').trim();
  }, [detailCategory, relationGraphFullComponent, selectedCategory, selectedEntry]);
  const relationGraphIndex = useMemo(() => (
    buildRelationGraphIndex(relationGraphData?.graph)
  ), [relationGraphData?.graph]);
  const focusedRelationGraph = useMemo(() => {
    const nextGraph = buildFocusedRelationGraph(
      relationGraphIndex,
      selectedEntry,
      detailCategory,
      relationGraphFullComponent,
    );

    if (!relationGraphFullComponent || !nextGraph) {
      fullComponentGraphCacheRef.current = null;
      return nextGraph;
    }

    const cached = fullComponentGraphCacheRef.current;
    if (
      cached
      && cached.componentKey === nextGraph.componentKey
      && cached.sourceGraph === relationGraphData?.graph
      && cached.graph
      && !cached.pending
    ) {
      const reusedGraph = {
        ...nextGraph,
        graph: cached.graph,
        sourceGraph: relationGraphData?.graph,
      };
      fullComponentGraphCacheRef.current = reusedGraph;
      return reusedGraph;
    }

    const cachedGraph = {
      ...nextGraph,
      sourceGraph: relationGraphData?.graph,
    };
    fullComponentGraphCacheRef.current = cachedGraph;
    return cachedGraph;
  }, [detailCategory, relationGraphData?.graph, relationGraphFullComponent, relationGraphIndex, selectedEntry]);

  useEffect(() => {
    if (relationGraphFetchScope === null) {
      relationGraphRequestRef.current += 1;
      setRelationGraphData(null);
      setRelationGraphLoading(false);
      return undefined;
    }

    const requestId = relationGraphRequestRef.current + 1;
    relationGraphRequestRef.current = requestId;
    setRelationGraphLoading(true);

    getReviewVisualization(relationGraphFetchScope)
      .then((data) => {
        if (relationGraphRequestRef.current !== requestId) return;
        setRelationGraphData(data);
        setRelationGraphLoading(false);
      })
      .catch((error) => {
        if (relationGraphRequestRef.current !== requestId) return;
        console.error('加载词条关系图失败', error);
        setRelationGraphData(null);
        setRelationGraphLoading(false);
      });

    return undefined;
  }, [relationGraphFetchScope, relationGraphRefreshToken]);

  const normalizedWordQuery = String(wordQuery || '').trim().toLowerCase();
  const filterCounts = {
    marked: entries.filter((item) => item.marked).length,
    needs_processing: entries.filter((item) => item.needsProcessing).length,
    all: entries.length,
    unmarked: entries.filter((item) => !item.marked).length,
  };
  const filteredEntries = useMemo(() => entries.filter((entry) => {
    if (entryFilter === 'marked') return entry.marked;
    if (entryFilter === 'needs_processing') return entry.needsProcessing;
    if (entryFilter === 'unmarked') return !entry.marked;
    return true;
  }), [entries, entryFilter]);
  const visibleEntries = useMemo(() => {
    const searchedEntries = filteredEntries.filter((entry) => {
      if (!normalizedWordQuery) return true;
      return [entry.word, entry.key, entry.file]
      .map((item) => String(item || '').toLowerCase())
      .some((item) => item.includes(normalizedWordQuery));
    });

    return randomSelectionMode
      ? searchedEntries
      : sortManualEntries(searchedEntries, manualSortOrder);
  }, [filteredEntries, manualSortOrder, normalizedWordQuery, randomSelectionMode]);

  useEffect(() => {
    if (typeof onVisibleScopeChange !== 'function') return;
    onVisibleScopeChange({
      entries: visibleEntries,
      selectedEntry,
      selectedCategory,
      entryFilter,
      wordQuery,
      totalCount: entries.length,
    });
  }, [entries.length, entryFilter, onVisibleScopeChange, selectedCategory, selectedEntry, visibleEntries, wordQuery]);

  const handleDrawRandomEntry = useCallback((pool = visibleEntries) => {
    const picked = pickRandomEntry(pool, selectedEntryId);
    if (!picked) return;
    void handleSelectEntry(picked, selectedCategory, entries);
  }, [entries, handleSelectEntry, selectedCategory, selectedEntryId, visibleEntries]);

  const applyRecommendationResult = useCallback((res, pool) => {
    const queue = buildRecommendationQueue(res, pool, 8);
    const recommended = queue[0] || null;
    setRecommendationQueue(queue);
    setRecommendation(recommended);
    return recommended;
  }, []);

  const handleUseRecommendation = useCallback((item) => {
    if (!item?.file) return;
    const targetCategory = String(item.category || selectedCategory || '').trim();
    if (!targetCategory) return;
    const targetEntry = normalizeVocabularyEntry({
      key: item.file,
      file: item.file,
      word: item.word,
      marked: Boolean(item.marked),
      category: targetCategory,
    }, targetCategory);
    void handleSelectEntry(targetEntry, isAllCategoriesValue(selectedCategory) ? selectedCategory : targetCategory, entries);
  }, [entries, handleSelectEntry, selectedCategory]);

  const handleOpenRelationEntry = useCallback((request) => {
    const targetCategory = String(request?.category || '').trim();
    const targetFile = normalizeVocabularyLaunchWord(
      request?.fileKey || request?.filename || request?.file || request?.word,
    );
    if (!targetCategory || !targetFile) return;

    const targetEntry = normalizeVocabularyEntry({
      key: targetFile,
      file: targetFile.endsWith('.json') ? targetFile : `${targetFile}.json`,
      word: request?.word || targetFile,
      category: targetCategory,
    }, targetCategory);

    void handleSelectEntry(
      targetEntry,
      isAllCategoriesValue(selectedCategory) ? selectedCategory : targetCategory,
      entries,
      {
        keepDetailWhileLoading: relationGraphFullComponent,
      },
    );
  }, [entries, handleSelectEntry, relationGraphFullComponent, selectedCategory]);

  const handleRecommendPreferencesChange = useCallback((patch) => {
    const next = normalizeRecommendationPreferences({
      ...recommendPreferencesRef.current,
      ...(patch || {}),
    });
    const dirty = recommendationPreferencesKey(next) !== savedRecommendPreferenceKeyRef.current;
    recommendPreferencesRef.current = next;
    recommendPreferenceDirtyRef.current = dirty;
    setRecommendPreferenceDirty(dirty);
    setRecommendPreferences(next);
    setRecommendExcludeKeys([]);
    setRecommendation(null);
    setRecommendationQueue([]);
  }, []);

  const handleRecommendPreferencesReset = useCallback(() => {
    setRecommendationTrianglePoint(recommendationPreferencesToTrianglePoint(DEFAULT_RECOMMENDATION_PREFERENCES));
    handleRecommendPreferencesChange(DEFAULT_RECOMMENDATION_PREFERENCES);
  }, [handleRecommendPreferencesChange]);

  const handleRecommendPreferencesRandomize = useCallback(() => {
    const nextPoint = randomRecommendationTrianglePoint();
    setRecommendationTrianglePoint(nextPoint);
    handleRecommendPreferencesChange(recommendationRatiosToPreferences(
      recommendationTrianglePointToRatios(nextPoint),
      recommendPreferencesRef.current,
    ));
    setRecommendFineTuneOpen(true);
  }, [handleRecommendPreferencesChange]);

  const handleRecommendPreferencesSave = useCallback(async () => {
    if (!recommendPreferenceHydratedRef.current || savingRecommendPreferences) return;

    const requestPreferences = normalizeRecommendationPreferences(recommendPreferencesRef.current);
    const requestKey = recommendationPreferencesKey(requestPreferences);
    if (requestKey === savedRecommendPreferenceKeyRef.current) {
      recommendPreferenceDirtyRef.current = false;
      setRecommendPreferenceDirty(false);
      return;
    }

    const requestId = recommendPreferenceSaveRequestRef.current + 1;
    recommendPreferenceSaveRequestRef.current = requestId;
    setSavingRecommendPreferences(true);

    try {
      const res = await saveConfig(recommendationPreferencesToConfig(requestPreferences));
      if (recommendPreferenceSaveRequestRef.current !== requestId) return;

      const nextPreferences = recommendationPreferencesFromConfig(res?.data || {});
      const savedKey = recommendationPreferencesKey(nextPreferences);
      const currentKey = recommendationPreferencesKey(recommendPreferencesRef.current);
      const dirty = currentKey !== savedKey;

      savedRecommendPreferenceKeyRef.current = savedKey;
      recommendPreferenceDirtyRef.current = dirty;
      if (currentKey === requestKey) {
        recommendPreferencesRef.current = nextPreferences;
        recommendPreferenceDirtyRef.current = false;
        setRecommendPreferences(nextPreferences);
        setRecommendationTrianglePoint(recommendationPreferencesToTrianglePoint(nextPreferences));
        setRecommendPreferenceDirty(false);
      } else {
        setRecommendPreferenceDirty(dirty);
      }
      window.dispatchEvent(new Event('config-updated'));
    } catch (error) {
      console.error('保存推荐偏好失败', error);
      alert('保存推荐偏好失败');
    } finally {
      if (recommendPreferenceSaveRequestRef.current === requestId) {
        setSavingRecommendPreferences(false);
      }
    }
  }, [savingRecommendPreferences]);

  const runRecommendationRefresh = useCallback(async (excludeKeys = [], options = {}) => {
    if (!recommendPreferenceHydratedRef.current) return null;

    const fallbackPool = Array.isArray(options?.fallbackPool) ? options.fallbackPool : visibleEntries;
    const fallbackOnEmpty = Boolean(options?.fallbackOnEmpty);
    const requestId = recommendationRefreshRequestRef.current + 1;
    recommendationRefreshRequestRef.current = requestId;
    const requestPreferences = normalizeRecommendationPreferences(recommendPreferencesRef.current);
    setLoadingRecommendation(true);
    try {
      const scopeCategory = recommendScope === ALL_RECOMMEND_SCOPE ? '' : recommendScope;
      const res = await fetchRecommendedWord(
        scopeCategory,
        excludeKeys,
        20,
        requestPreferences,
        recommendationMarkFilterFromEntryFilter(entryFilter),
      );
      if (recommendationRefreshRequestRef.current !== requestId) return null;
      recommendationQueueRequestRef.current += 1;
      setLoadingRecommendationQueue(false);
      const recommended = applyRecommendationResult(res, fallbackPool);
      if (recommended) {
        handleUseRecommendation(recommended);
        return recommended;
      }
      if (fallbackOnEmpty) {
        handleDrawRandomEntry(fallbackPool);
      }
      return null;
    } catch (error) {
      if (recommendationRefreshRequestRef.current !== requestId) return null;
      console.error('推荐词条失败', error);
      if (fallbackOnEmpty) {
        handleDrawRandomEntry(fallbackPool);
      }
      return null;
    } finally {
      if (recommendationRefreshRequestRef.current === requestId) {
        setLoadingRecommendation(false);
      }
    }
  }, [applyRecommendationResult, entryFilter, handleDrawRandomEntry, handleUseRecommendation, recommendScope, visibleEntries]);

  useEffect(() => {
    if (!randomSelectionMode || !visibleEntries.length || !recommendPreferenceHydrated) {
      recommendationQueueRequestRef.current += 1;
      setLoadingRecommendationQueue(false);
      setRecommendationQueue([]);
      return undefined;
    }

    const requestId = recommendationQueueRequestRef.current + 1;
    recommendationQueueRequestRef.current = requestId;
    const scopeCategory = recommendScope === ALL_RECOMMEND_SCOPE ? '' : recommendScope;
    const requestPreferences = normalizeRecommendationPreferences(recommendPreferencesRef.current);
    setLoadingRecommendationQueue(true);

    fetchRecommendedWord(
      scopeCategory,
      [],
      8,
      requestPreferences,
      recommendationMarkFilterFromEntryFilter(entryFilter),
    )
      .then((res) => {
        if (recommendationQueueRequestRef.current !== requestId) return;
        setRecommendationQueue(buildRecommendationQueue(res, visibleEntries, 8));
      })
      .catch((error) => {
        if (recommendationQueueRequestRef.current !== requestId) return;
        console.error('加载推荐队列失败', error);
        setRecommendationQueue([]);
      })
      .finally(() => {
        if (recommendationQueueRequestRef.current === requestId) {
          setLoadingRecommendationQueue(false);
        }
      });

    return undefined;
  }, [entryFilter, randomSelectionMode, recommendPreferenceHydrated, recommendPreferences, recommendScope, visibleEntries]);

  const handleRecommendationNext = useCallback((poolArg = null) => {
    const fallbackPool = Array.isArray(poolArg) ? poolArg : visibleEntries;
    if (!fallbackPool.length) return;
    const selectedFile = String(selectedEntry?.file || '').trim();
    const selectedCategoryForKey = String(selectedEntry?.category || detailCategory || '').trim();
    const currentKey = selectedFile && selectedCategoryForKey
      ? `${selectedCategoryForKey}/${selectedFile}`
      : (recommendation?.key || '');
    const nextExcluded = [...new Set([...recommendExcludeKeys, currentKey].filter(Boolean))];
    const excludeUnchanged = nextExcluded.length === recommendExcludeKeys.length
      && nextExcluded.every((item, index) => item === recommendExcludeKeys[index]);
    if (!excludeUnchanged) {
      setRecommendExcludeKeys(nextExcluded);
    }
    void runRecommendationRefresh(nextExcluded, { fallbackPool, fallbackOnEmpty: true });
  }, [detailCategory, recommendExcludeKeys, recommendation?.key, runRecommendationRefresh, selectedEntry?.category, selectedEntry?.file, visibleEntries]);

  const handleSubmitReviewScore = useCallback(async (score) => {
    const currentEntry = selectedEntry || resolveEntryCandidate(detailData?.word, selectedCategory, entries);
    const currentEntryCategory = detailCategory || resolveEntryCategory(currentEntry, selectedCategory);
    if (!detailData || !currentEntry?.file || !currentEntryCategory) return;

    const shouldAdvanceForThisScore = randomSelectionModeRef.current;
    setSavingReviewScore(true);
    let shouldAdvance = false;
    try {
      await submitReviewScore(currentEntryCategory, currentEntry.file, score, getTodayLocalDateString());
      const res = await getVocabularyDetail(currentEntry.key || currentEntry.file || currentEntry.word, currentEntryCategory);
      if (res?.data) setDetailData(res.data);
      shouldAdvance = shouldAdvanceForThisScore && randomSelectionModeRef.current;
    } catch (error) {
      console.error('记录熟练度失败', error);
      alert('记录熟练度失败');
    } finally {
      setSavingReviewScore(false);
      if (shouldAdvance && visibleEntries.length > 1) {
        queueMicrotask(() => handleRecommendationNext(visibleEntries));
      }
    }
  }, [detailCategory, detailData, entries, handleRecommendationNext, resolveEntryCandidate, resolveEntryCategory, selectedCategory, selectedEntry, visibleEntries]);

  useEffect(() => {
    if (!mobileSimple || !randomSelectionMode || !recommendPreferenceHydrated) return;
    if (loadingRecommendation) return;
    if (!selectedCategory) return;
    if (entriesCategory !== selectedCategory) return;
    if (!visibleEntries.length) {
      autoRecommendationPoolKeyRef.current = '';
      detailRequestRef.current += 1;
      setSelectedEntryId('');
      setSelectedEntrySnapshot(null);
      setDetailData(null);
      setDetailCategory('');
      return;
    }

    const stillVisible = visibleEntries.some((item) => item.id === selectedEntryId);
    if (stillVisible) {
      autoRecommendationPoolKeyRef.current = '';
      return;
    }

    const firstVisibleId = visibleEntries[0]?.id || '';
    const lastVisibleId = visibleEntries[visibleEntries.length - 1]?.id || '';
    const poolKey = [
      selectedCategory,
      entriesCategory,
      entryFilter,
      normalizedWordQuery,
      visibleEntries.length,
      firstVisibleId,
      lastVisibleId,
    ].join('\u0001');
    if (autoRecommendationPoolKeyRef.current === poolKey) return;
    autoRecommendationPoolKeyRef.current = poolKey;

    queueMicrotask(() => {
      handleRecommendationNext(visibleEntries);
    });
  }, [entriesCategory, entryFilter, handleRecommendationNext, loadingRecommendation, mobileSimple, normalizedWordQuery, randomSelectionMode, recommendPreferenceHydrated, selectedCategory, selectedEntryId, visibleEntries]);

  useEffect(() => {
    if (!randomSelectionMode) {
      setRecommendSettingsOpen(false);
      recommendationRefreshRequestRef.current += 1;
      recommendationQueueRequestRef.current += 1;
      setLoadingRecommendation(false);
      setLoadingRecommendationQueue(false);
    }
    setRecommendExcludeKeys([]);
    setRecommendation(null);
    setRecommendationQueue([]);
  }, [randomSelectionMode, recommendPreferences, recommendScope]);

  useEffect(() => {
    if (randomSelectionMode || !selectedEntryId) return;
    const listNode = sidebarWordListRef.current;
    if (!listNode) return;
    const selectedNode = listNode.querySelector('[data-selected-entry="true"]');
    if (!selectedNode) return;

    const listRect = listNode.getBoundingClientRect();
    const selectedRect = selectedNode.getBoundingClientRect();
    const viewportPadding = 12;
    const isFullyVisible = (
      selectedRect.top >= listRect.top + viewportPadding
      && selectedRect.bottom <= listRect.bottom - viewportPadding
    );
    if (isFullyVisible) return;

    const targetTop = listNode.scrollTop
      + (selectedRect.top - listRect.top)
      - Math.max(0, (listRect.height - selectedRect.height) / 2);
    listNode.scrollTop = Math.max(0, targetTop);
  }, [randomSelectionMode, selectedEntryId, visibleEntries]);

  useEffect(() => {
    if (!mobileSimple || compactDesktop) return;
    setMobileDefinitionsCollapsed(true);
  }, [compactDesktop, mobileSimple, selectedEntryId]);

  useEffect(() => {
    if (!detailData || (mobileSimple && !compactDesktop)) return;
    setDesktopDefinitionsCollapsed(desktopContentDefaultCollapsed);
    setDesktopExampleNoteCollapsedOverrides({});
  }, [compactDesktop, desktopContentDefaultCollapsed, detailData, mobileSimple]);

  const handleToggleMarked = useCallback(async () => {
    const currentEntry = selectedEntry || resolveEntryCandidate(detailData?.word, selectedCategory, entries);
    const currentEntryCategory = detailCategory || resolveEntryCategory(currentEntry, selectedCategory);
    if (!detailData || !currentEntry?.file || !currentEntryCategory) return;

    setSavingMarked(true);
    try {
      const payload = {
        ...detailData,
        marked: !detailData?.marked,
      };
      const res = await saveVocabularyDetail(currentEntryCategory, currentEntry.file, payload);
      const nextData = res?.data || payload;
      setDetailData(nextData);
      setEntries((prev) => prev.map((item) => (
        item.id === currentEntry.id
          ? {
              ...item,
              word: String(nextData?.word || item.word || '').trim() || item.word,
              marked: Boolean(nextData?.marked),
            }
          : item
      )));
      setSelectedEntrySnapshot((prev) => (
        prev?.id === currentEntry.id
          ? {
              ...prev,
              word: String(nextData?.word || prev.word || '').trim() || prev.word,
              marked: Boolean(nextData?.marked),
            }
          : prev
      ));
    } catch (error) {
      console.error('更新词条标记失败', error);
      alert('更新词条标记失败');
    } finally {
      setSavingMarked(false);
    }
  }, [detailCategory, detailData, entries, resolveEntryCandidate, resolveEntryCategory, selectedCategory, selectedEntry]);

  const reviews = Array.isArray(detailData?.reviews) ? detailData.reviews : [];
  const definitions = Array.isArray(detailData?.definitions) ? detailData.definitions : [];
  const examples = Array.isArray(detailData?.examples) ? detailData.examples : [];
  const mergedFrom = Array.isArray(detailData?.mergedFrom)
    ? detailData.mergedFrom.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const rawTags = Array.isArray(detailData?.tags)
    ? detailData.tags.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const compactDesktopSurface = compactDesktop && !mobileSimple;
  const selectedCategoryLabel = formatCategoryChoiceLabel(selectedCategory);
  const detailCategoryLabel = detailCategory ? formatCategoryLabel(detailCategory) : selectedCategoryLabel;
  const categoryTag = detailCategory
    ? formatCategoryLabel(detailCategory)
    : (!isAllCategoriesValue(selectedCategory) && selectedCategory ? formatCategoryChoiceLabel(selectedCategory) : '');
  const displayTags = [...new Set([
    ...rawTags,
    ...(detailData?.marked ? ['已标记'] : []),
    ...[categoryTag].filter(Boolean),
  ])];
  const latestReview = reviews.length ? reviews[reviews.length - 1] : null;
  const latestReviewTone = latestReview ? getReviewToneStyle(latestReview.score) : null;
  const activeFilterOption = ENTRY_FILTER_OPTIONS.find((item) => item.value === entryFilter) || ENTRY_FILTER_OPTIONS[0];
  const youdaoUrl = buildYoudaoUrl(detailData?.word || selectedEntry?.word || '');
  const selectedRecommendationKey = selectedEntry
    ? `${selectedEntry.category}/${selectedEntry.file}`
    : '';
  const compactCategoryOptions = [{ value: ALL_CATEGORIES_VALUE, label: '全部目录' }, ...categories.map((item) => ({ value: item, label: item }))];
  const recommendScopeOptions = [{ value: ALL_RECOMMEND_SCOPE, label: '全部目录' }, ...categories.map((item) => ({ value: item, label: item }))];
  const mobileSimpleRootStyle = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    background: compactDesktop ? 'var(--ms-bg)' : 'transparent',
    overflow: 'hidden',
    padding: compactDesktop ? '0' : '0',
    gap: compactDesktop ? '10px' : '0',
  };
  const mobileSimpleToolbarStyle = {
    width: '100%',
    maxWidth: compactDesktop ? '1040px' : 'none',
    margin: compactDesktop ? '0 auto' : '0',
    padding: compactDesktop ? '10px' : '12px',
    border: compactDesktop ? '1px solid var(--ms-border)' : 'none',
    borderBottom: compactDesktop ? 'none' : '1px solid var(--ms-border)',
    borderRadius: compactDesktop ? '8px' : '0',
    background: 'rgba(255, 255, 255, 0.94)',
    display: 'grid',
    gap: '10px',
  };
  const mobileSimpleContentStyle = {
    flex: '0 1 auto',
    position: 'relative',
    width: '100%',
    maxWidth: compactDesktop ? '1040px' : 'none',
    margin: compactDesktop ? '0 auto' : '0',
    padding: compactDesktop ? '0' : '12px 12px 8px',
    overflowY: 'auto',
    overflowX: 'hidden',
  };

  const mobileScoreControls = mobileSimple ? (
    <div className="vocab-review-bottom-bar" style={{
      width: '100%',
      maxWidth: compactDesktop ? '1040px' : 'none',
      margin: compactDesktop ? '0 auto' : '0',
    }}>
      <div className="vocab-review-bottom-meta">
        <div className="vocab-review-bottom-title">{detailData ? '本次打分' : '开始刷题'}</div>
        <div className="vocab-review-bottom-status">
          {detailData
            ? (
              savingReviewScore
                ? '正在保存...'
                : latestReview
                  ? `最近 ${normalizeReviewScore(latestReview.score)}/5`
                  : '记录今天熟练度'
            )
            : `当前词池 ${visibleEntries.length} / ${entries.length}`}
        </div>
      </div>

      {detailData ? (
        <div className="score-grid vocab-review-bottom-score-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: '6px' }}>
          {[0, 1, 2, 3, 4, 5].map((score) => (
            <button
              key={score}
              type="button"
              className="score-btn"
              onClick={() => void handleSubmitReviewScore(score)}
              disabled={savingReviewScore}
              style={{
                padding: '8px 4px',
                borderRadius: '6px',
                border: '1px solid var(--ms-border)',
                background: '#fff',
                color: 'var(--ms-text)',
                fontSize: '11px',
                fontWeight: 650,
                lineHeight: 1.35,
                cursor: savingReviewScore ? 'not-allowed' : 'pointer',
              }}
            >
              <strong style={{ display: 'block', fontSize: '16px' }}>{score}</strong>
              <span>{SCORE_SHORT_LABELS[score]}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className={`vocab-review-bottom-actions${detailData ? '' : ' is-single'}`}>
        {detailData ? (
          <button
            type="button"
            className="vocab-review-mark-button"
            onClick={() => void handleToggleMarked()}
            disabled={savingMarked}
          >
            {savingMarked ? '保存中' : (detailData?.marked ? '已标记' : '标记')}
          </button>
        ) : null}
        <button
          type="button"
          className="master-primary-button vocab-review-draw-button"
          onClick={randomSelectionMode ? (() => handleRecommendationNext()) : (() => handleDrawRandomEntry())}
          disabled={randomSelectionMode ? (loadingRecommendation || !visibleEntries.length) : !visibleEntries.length}
        >
          {loadingRecommendation && randomSelectionMode ? '抽取中' : (detailData ? '下一个词' : '随机抽词')}
        </button>
      </div>
    </div>
  ) : null;

  const emptyTitle = visibleEntries.length
    ? (randomSelectionMode ? '随机抽词' : '选择词条')
    : '词池为空';
  const emptyStatusItems = [
    selectedCategory ? selectedCategoryLabel : '全部目录',
    `${visibleEntries.length} / ${entries.length}`,
    activeFilterOption.label,
  ];

  const closeMobileTools = () => setMobileFiltersOpen(false);
  const closeMobileInfo = () => {
    setMobileInfoOpen(false);
    setMobileInfoPanelPosition(null);
  };
  const openYoudao = () => {
    if (!youdaoUrl) return;
    window.open(youdaoUrl, '_blank', 'noopener,noreferrer');
  };
  const toggleMobileInfo = () => {
    if (!mobileInfoOpen) updateMobileInfoPanelPosition();
    setMobileInfoOpen((open) => !open);
  };
  const mobileInfoPanelStyle = mobileInfoPanelPosition ? {
    '--vocab-info-panel-left': `${mobileInfoPanelPosition.left}px`,
    '--vocab-info-panel-top': `${mobileInfoPanelPosition.top}px`,
    '--vocab-info-panel-max-height': `${mobileInfoPanelPosition.maxHeight}px`,
  } : undefined;
  const renderManualSortPill = (option) => {
    const selected = manualSortOrder === option.value;
    return (
      <button
        key={option.value}
        type="button"
        className={`vocab-review-filter-pill${selected ? ' is-active' : ''}`}
        onClick={() => setManualSortOrder(option.value)}
        aria-pressed={selected}
        aria-label={`按${option.label}排序`}
        title={`按${option.label}排序`}
      >
        <span className="vocab-review-filter-pill-check">
          <UiIcon name="check" size={11} />
        </span>
        <span className="vocab-review-filter-pill-label">{option.label}</span>
      </button>
    );
  };

  const reviewFilterControlsNode = (
    <>
      <div className="vocab-review-filter-stack">
        <label className="vocab-review-filter-row vocab-review-category-filter-row vocab-review-sidebar-category-field">
          <span className="vocab-review-filter-row-control">
            <select
              className="vocab-review-select vocab-review-filter-select vocab-review-category-select"
              value={selectedCategory}
              onChange={(e) => applySelectedCategory(e.target.value)}
              aria-label="目录"
            >
              {compactCategoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </span>
        </label>

        <label className="vocab-review-filter-row vocab-review-entry-filter-row">
          <span className="vocab-review-filter-row-control">
            <select
              className="vocab-review-select vocab-review-filter-select vocab-review-status-select"
              value={entryFilter}
              onChange={(event) => setEntryFilter(event.target.value)}
              aria-label="状态"
            >
              {ENTRY_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.compactLabel} {filterCounts[option.value] || 0}
                </option>
              ))}
            </select>
          </span>
        </label>
      </div>
    </>
  );

  const movePrimaryControlsToWorkspaceToolbar = Boolean(workspaceToolbarControlsHost) && !compactViewport && (!mobileSimple || compactDesktop);

  const manualSortControlsNode = !randomSelectionMode ? (
    <div className="vocab-review-floating-field vocab-review-manual-sort-field">
      <span className="vocab-review-field-label">排序</span>
      <div className="vocab-review-floating-filter-grid" role="group" aria-label="手动词池排序">
        {MANUAL_SORT_OPTIONS.map(renderManualSortPill)}
      </div>
    </div>
  ) : null;

  const desktopPoolControlsNode = (!movePrimaryControlsToWorkspaceToolbar || !randomSelectionMode) ? (
    <div
      className="vocab-review-sidebar-pool-controls"
      style={{
        padding: '8px 14px',
        borderBottom: '1px solid var(--ms-border)',
        background: 'rgba(255, 255, 255, 0.94)',
        display: 'grid',
        gap: '7px',
      }}
    >
      {movePrimaryControlsToWorkspaceToolbar ? null : reviewFilterControlsNode}
      {!randomSelectionMode ? (
        <>
          {manualSortControlsNode}
          <label className="vocab-review-floating-field">
            <span className="vocab-review-field-label">搜索</span>
            <input
              className="vocab-review-search-input"
              type="search"
              placeholder="筛选单词或文件名"
              value={wordQuery}
              onChange={(e) => setWordQuery(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', fontSize: '13px', outline: 'none', background: '#fff', color: 'var(--ms-text)' }}
            />
          </label>
        </>
      ) : null}
    </div>
  ) : null;

  const desktopReviewControlsNode = !mobileSimple ? (
    <div className="vocab-review-desktop-review-controls">
      <div className="vocab-review-desktop-review-head">
        <div>
          <div className="vocab-review-desktop-review-title">{detailData ? '本次打分' : '开始刷题'}</div>
          <div className="vocab-review-desktop-review-status">
            {detailData
              ? (
                savingReviewScore
                  ? '正在保存...'
                  : latestReview
                    ? `最近 ${normalizeReviewScore(latestReview.score)}/5`
                    : '记录今天熟练度'
              )
              : `当前词池 ${visibleEntries.length} / ${entries.length}`}
          </div>
        </div>
      </div>

      {detailData ? (
        <div className="score-grid vocab-review-desktop-score-grid" role="group" aria-label="本次打分">
          {[0, 1, 2, 3, 4, 5].map((score) => (
            <button
              key={score}
              type="button"
              className="score-btn vocab-review-desktop-score-button"
              onClick={() => void handleSubmitReviewScore(score)}
              disabled={savingReviewScore}
            >
              <strong>{score}</strong>
              <span>{SCORE_SHORT_LABELS[score]}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className={`vocab-review-desktop-review-actions${detailData ? '' : ' is-single'}`}>
        {detailData ? (
          <button
            type="button"
            className={`vocab-review-mark-button${detailData?.marked ? ' is-active' : ''}`}
            onClick={() => void handleToggleMarked()}
            disabled={savingMarked}
          >
            <UiIcon name="star" size={14} />
            <span>{savingMarked ? '保存中' : (detailData?.marked ? '已标记' : '标记')}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="master-primary-button vocab-review-draw-button"
          onClick={randomSelectionMode ? (() => handleRecommendationNext()) : (() => handleDrawRandomEntry())}
          disabled={randomSelectionMode ? (loadingRecommendation || !visibleEntries.length) : !visibleEntries.length}
        >
          <UiIcon name="shuffle" size={14} />
          <span>{loadingRecommendation && randomSelectionMode ? '抽取中' : (detailData ? '下一个词' : '随机抽词')}</span>
        </button>
      </div>
    </div>
  ) : null;

  const desktopContentPreferenceNode = (!mobileSimple || compactDesktop) ? (
    <div className="vocab-review-desktop-preference-panel">
      <button
        type="button"
        className={`vocab-review-desktop-toggle-row${desktopContentDefaultCollapsed ? ' is-active' : ''}`}
        onClick={() => handleDesktopContentDefaultCollapsedChange(!desktopContentDefaultCollapsed)}
        aria-pressed={desktopContentDefaultCollapsed}
      >
        <span className="vocab-review-desktop-toggle-copy">
          <strong>默认折叠</strong>
        </span>
        <span className="vocab-review-desktop-toggle-switch" aria-hidden="true">
          <span />
        </span>
      </button>
    </div>
  ) : null;

  const workspaceToolbarControlsNode = movePrimaryControlsToWorkspaceToolbar
    ? createPortal(
      <div
        className={`vocab-workspace-review-tools${compactDesktop ? ' is-compact-desktop' : ''}`}
        role="group"
        aria-label="生词本筛选和显示设置"
      >
        {reviewFilterControlsNode}
        {desktopContentPreferenceNode}
      </div>,
      workspaceToolbarControlsHost,
    )
    : null;

  const recommendationSettingsControlsNode = (
    <>
      <label className="vocab-review-floating-field vocab-recommend-scope-field">
        推荐范围
        <select
          className="vocab-review-select"
          value={recommendScope}
          onChange={(event) => applySelectedCategory(
            event.target.value === ALL_RECOMMEND_SCOPE ? ALL_CATEGORIES_VALUE : event.target.value,
          )}
        >
          {recommendScopeOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <RecommendationHybridTuner
        preferences={recommendPreferences}
        point={recommendationTrianglePoint}
        fineTuneOpen={recommendFineTuneOpen}
        onChange={handleRecommendPreferencesChange}
        onPointChange={setRecommendationTrianglePoint}
        onFineTuneOpenChange={setRecommendFineTuneOpen}
      />

      <div className="vocab-recommend-panel-actions">
        <button
          type="button"
          className="vocab-review-filter-pill"
          onClick={handleRecommendPreferencesReset}
        >
          重置
        </button>
        <button
          type="button"
          className="vocab-review-filter-pill"
          onClick={handleRecommendPreferencesRandomize}
        >
          随机调参
        </button>
        <button
          type="button"
          className="master-primary-button"
          onClick={handleRecommendPreferencesSave}
          disabled={!recommendPreferenceHydrated || !recommendPreferenceDirty || savingRecommendPreferences}
        >
          {savingRecommendPreferences ? '保存中' : '保存到后台'}
        </button>
      </div>
    </>
  );

  const mobileManualPoolNode = (
    <div className="vocab-review-mobile-manual-pool">
      <label className="vocab-review-floating-field">
        搜索
        <input
          className="vocab-review-search-input"
          type="search"
          placeholder="筛选单词或文件名"
          value={wordQuery}
          onChange={(e) => setWordQuery(e.target.value)}
          style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', fontSize: '13px', outline: 'none', background: '#fff', color: 'var(--ms-text)' }}
        />
      </label>

      {manualSortControlsNode}

      <div className="vocab-review-mobile-pool-summary">
        <span>{selectedCategoryLabel}</span>
        <strong>{visibleEntries.length}{normalizedWordQuery ? ` / ${filteredEntries.length}` : ''}</strong>
      </div>

      <div className="vocab-review-mobile-pool-list" role="listbox" aria-label="手动词池">
        {visibleEntries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="option"
            aria-selected={selectedEntryId === entry.id}
            className={`vocab-review-word-item${selectedEntryId === entry.id ? ' is-selected' : ''}`}
            onClick={() => {
              closeMobileTools();
              void handleSelectEntry(entry);
            }}
          >
            <span className="vocab-review-mobile-pool-word">{entry.word}</span>
            <span className="vocab-review-mobile-pool-meta">
              {formatCategoryLabel(entry.category)} / {entry.file}
              {getEntryCreatedAt(entry) ? ` / ${getEntryCreatedAt(entry)}` : ''}
              {entry.marked ? ' / 标记' : ''}
              {entry.refineCached ? ' / 已预处理' : ''}
            </span>
          </button>
        ))}
        {!visibleEntries.length ? (
          <div className="vocab-review-empty vocab-review-mobile-pool-empty">
            {normalizedWordQuery ? '没有匹配的词条' : `${activeFilterOption.label}为空`}
          </div>
        ) : null}
      </div>
    </div>
  );

  const sidebarWordListNode = (
    <ul ref={sidebarWordListRef} className="vocab-review-word-list" style={{ listStyle: 'none', padding: 0, margin: 0, overflowY: 'auto', flex: 1, minHeight: 0 }}>
      {visibleEntries.map((entry) => (
        <li
          key={entry.id}
          className={`vocab-review-word-item${selectedEntryId === entry.id ? ' is-selected' : ''}`}
          data-selected-entry={selectedEntryId === entry.id ? 'true' : undefined}
          onClick={() => void handleSelectEntry(entry)}
          style={{
            padding: '13px 16px',
            cursor: 'pointer',
            borderBottom: '1px solid rgba(213, 221, 208, 0.66)',
            background: selectedEntryId === entry.id ? 'var(--ms-surface-muted)' : 'transparent',
            color: 'var(--ms-text)',
          }}
        >
          <div style={{ display: 'grid', gap: '6px', minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
              <span
                className="vocab-review-word-label"
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '14px',
                  fontWeight: selectedEntryId === entry.id ? '600' : '500',
                }}
              >
                {entry.word}
              </span>
              {entry.marked ? (
                <span style={{ fontSize: '11px', color: 'var(--ms-text-muted)', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--ms-border)', background: '#fff', flexShrink: 0 }}>
                  已标记
                </span>
              ) : null}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--ms-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {formatCategoryLabel(entry.category)} / {entry.file}
              {getEntryCreatedAt(entry) ? ` / ${getEntryCreatedAt(entry)}` : ''}
              {entry.refineCached ? ' / 已预处理' : ''}
            </div>
          </div>
        </li>
      ))}
      {visibleEntries.length === 0 ? (
        <div className="vocab-review-empty" style={{ padding: '20px', textAlign: 'center', color: '#a1a1aa', fontSize: '13px' }}>
          {normalizedWordQuery ? '没有匹配的词条' : `${activeFilterOption.label}为空`}
        </div>
      ) : null}
    </ul>
  );

  const sidebarRandomPreviewNode = (
    <div className="vocab-review-random-preview">
      <div className="vocab-review-random-preview-header">
        <strong>推荐队列</strong>
        {loadingRecommendationQueue ? (
          <span className="vocab-review-random-preview-count">
            更新中
          </span>
        ) : recommendationQueue.length ? (
          <span className="vocab-review-random-preview-count">
            {recommendationQueue.length}
          </span>
        ) : null}
      </div>
      {recommendationQueue.length ? (
        <ul className="vocab-review-random-preview-list">
          {recommendationQueue.map((entry, index) => {
            const active = selectedEntryId === entry.id || selectedRecommendationKey === entry.key;
            const score = Number(entry.priority_score);
            return (
              <li key={entry.key || entry.id}>
                <button
                  type="button"
                  className={`vocab-review-random-preview-item${active ? ' is-selected' : ''}`}
                  onClick={() => handleUseRecommendation(entry)}
                  aria-pressed={active}
                >
                  <span className="vocab-review-random-preview-rank">{index + 1}</span>
                  <span className="vocab-review-random-preview-main">
                    <span className="vocab-review-random-preview-word">{entry.word}</span>
                    <span className="vocab-review-random-preview-meta">{formatCategoryLabel(entry.category)} / {entry.file}</span>
                  </span>
                  {Number.isFinite(score) ? (
                    <span className="vocab-review-random-preview-score">{score.toFixed(2)}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="vocab-review-empty" style={{ padding: '18px 16px', textAlign: 'center', color: '#a1a1aa', fontSize: '13px' }}>
          {loadingRecommendationQueue ? '正在更新推荐队列' : (normalizedWordQuery ? '没有匹配的推荐词条' : `${activeFilterOption.label}为空`)}
        </div>
      )}
    </div>
  );

  const mobileToolsTitle = randomSelectionMode ? '随机设置' : '手动词池';
  const mobileToolsCaption = randomSelectionMode
    ? `${selectedCategoryLabel} · ${activeFilterOption.label} · ${visibleEntries.length} / ${entries.length}`
    : `${activeFilterOption.label} · ${visibleEntries.length}${normalizedWordQuery ? ` / ${filteredEntries.length}` : ''}`;
  const mobileUnifiedToolsNode = mobileFiltersOpen ? (
    <div className="vocab-review-floating-layer vocab-review-mobile-tools-layer" role="presentation">
      <button
        type="button"
        className="vocab-review-floating-backdrop"
        aria-label={`关闭${mobileToolsTitle}`}
        onClick={closeMobileTools}
      />
      <section
        className={`vocab-review-floating-panel vocab-review-mobile-tools-panel${randomSelectionMode ? ' is-random-tools' : ' is-manual-tools'}`}
        role="dialog"
        aria-modal="false"
        aria-label={mobileToolsTitle}
      >
        <div className="vocab-review-floating-header">
          <div>
            <div className="vocab-review-floating-title">{mobileToolsTitle}</div>
            <div className="vocab-review-floating-caption">{mobileToolsCaption}</div>
          </div>
          <button
            type="button"
            className="vocab-review-mobile-tools-button"
            aria-label={`关闭${mobileToolsTitle}`}
            onClick={closeMobileTools}
          >
            <UiIcon name="close" size={16} />
          </button>
        </div>

        {!movePrimaryControlsToWorkspaceToolbar ? (
          <div className="vocab-review-mobile-tools-section">
            <div className="vocab-review-mobile-tools-section-title">词池</div>
            {reviewFilterControlsNode}
          </div>
        ) : null}

        {randomSelectionMode ? (
          <div className="vocab-review-mobile-tools-section">
            <div className="vocab-review-mobile-tools-section-title">随机策略</div>
            {recommendationSettingsControlsNode}
          </div>
        ) : mobileManualPoolNode}
      </section>
    </div>
  ) : null;

  const recommendationSettingsNode = recommendSettingsOpen ? (
    <div className="vocab-review-floating-layer vocab-review-recommend-floating-layer" role="presentation">
      <button
        type="button"
        className="vocab-review-floating-backdrop"
        aria-label="关闭随机设置"
        onClick={() => setRecommendSettingsOpen(false)}
      />
      <section className="vocab-review-floating-panel vocab-review-recommend-panel" role="dialog" aria-modal="false" aria-label="随机设置">
        {recommendationSettingsControlsNode}
      </section>
    </div>
  ) : null;

  const pendingRelationGraph = useMemo(() => (
    buildPendingRelationGraph(selectedEntry, detailCategory, relationGraphLoading)
  ), [detailCategory, relationGraphLoading, selectedEntry]);
  const visibleRelationGraph = focusedRelationGraph || (!mobileSimple ? pendingRelationGraph : null);
  const shouldShowRelationGraph = Boolean(
    detailData
    && visibleRelationGraph
  );
  const definitionsMasked = (mobileSimple && !compactDesktop) ? mobileDefinitionsCollapsed : desktopDefinitionsCollapsed;
  const definitionMaskActionLabel = definitionsMasked ? '显示释义' : '遮蔽释义';
  const toggleDefinitionsMask = () => {
    if (mobileSimple && !compactDesktop) {
      setMobileDefinitionsCollapsed((collapsed) => !collapsed);
      return;
    }
    setDesktopDefinitionsCollapsed((collapsed) => !collapsed);
  };
  const relationGraphModeTitle = relationGraphFullComponent ? '完整块已开启，点击后只显示直接邻接' : '完整块已关闭，点击后显示完整连通块';
  const relationGraphNode = shouldShowRelationGraph ? (
    <div className={`vocab-review-relation-graph-frame${visibleRelationGraph.pending ? ' is-pending' : ''}${visibleRelationGraph.fullComponent ? ' is-full-component' : ''}`}>
      {!visibleRelationGraph.pending ? (
        <button
          type="button"
          className={`vocab-review-relation-graph-mode-toggle${relationGraphFullComponent ? ' is-active' : ''}`}
          onClick={() => handleRelationGraphFullComponentChange(!relationGraphFullComponent)}
          aria-pressed={relationGraphFullComponent}
          aria-label={relationGraphModeTitle}
          title={relationGraphModeTitle}
        >
          <span className="vocab-review-relation-graph-switch" aria-hidden="true">
            <span className="vocab-review-relation-graph-switch-thumb" />
          </span>
          <span>完整块</span>
        </button>
      ) : null}
      <RelationGraphPanel
        graph={visibleRelationGraph.graph}
        title="连线"
        compact={!visibleRelationGraph.fullComponent}
        className="vocab-review-relation-graph"
        focusNodeId={visibleRelationGraph.focusNodeId}
        currentNodeId={visibleRelationGraph.focusNodeId}
        onOpenVocabularyEntry={handleOpenRelationEntry}
        openNodeOnClick={!visibleRelationGraph.pending}
        fitContainerHeight={!mobileSimple}
      />
      {visibleRelationGraph.pending ? (
        <div className="vocab-review-relation-graph-loading" aria-hidden="true" />
      ) : null}
    </div>
  ) : null;

  const desktopDefinitionCard = !mobileSimple ? (
    <div className={`vocab-review-sections vocab-review-card vocab-review-definition-card vocab-review-desktop-disclosure-card${definitionsMasked ? ' is-masked' : ''}`} style={{ ...metaCardStyle, padding: '0', gap: '0' }}>
      <div className="vocab-review-desktop-disclosure-toggle">
        <strong>释义</strong>
        <span className="vocab-review-desktop-disclosure-meta">{definitions.length}</span>
        <button
          type="button"
          className="vocab-review-definition-mask-toggle"
          onClick={toggleDefinitionsMask}
          aria-pressed={definitionsMasked}
          aria-label={definitionMaskActionLabel}
          title={definitionMaskActionLabel}
        >
          <UiIcon name={definitionsMasked ? 'lock' : 'unlock'} size={13} />
          <span>{definitionsMasked ? '显示' : '遮蔽'}</span>
        </button>
      </div>
      <div className={`vocab-review-desktop-disclosure-body vocab-review-definition-maskable${definitionsMasked ? ' is-masked' : ''}`}>
        {definitions.length ? (
          <ul className="vocab-review-definition-list" style={{ paddingLeft: '20px', margin: 0, fontSize: '15px', lineHeight: '1.8' }}>
            {definitions.map((definition, index) => (
              <li key={`${definition}-${index}`} className="vocab-review-definition-item" style={{ marginBottom: '8px' }}>{definition}</li>
            ))}
          </ul>
        ) : (
          <div style={{ color: '#a1a1aa', fontSize: '14px' }}>暂无释义</div>
        )}
      </div>
    </div>
  ) : null;

  const detailNode = detailData ? (
    <div className="vocab-review-shell">
      {!mobileSimple ? (
        <div className="vocab-review-desktop-overview">
          <div className="vocab-review-desktop-overview-left" ref={desktopOverviewLeftRef}>
            <div className="vocab-review-hero" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
              <div className="vocab-review-hero-body">
                <div className="vocab-review-word-line" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <h1 className="vocab-review-hero-title" style={{ fontSize: 'clamp(28px, 4vw, 34px)', margin: 0, color: 'var(--ms-text)', lineHeight: 1.04, wordBreak: 'break-word' }}>{detailData.word}</h1>
                  <button
                    className="vocab-review-audio-button"
                    onClick={() => playAudio(detailData.word, 2)}
                    title="朗读单词"
                    style={{ cursor: 'pointer', color: 'var(--ms-text)' }}
                  >
                    <UiIcon name="volume" size={18} />
                  </button>
                  <button
                    type="button"
                    className="vocab-review-audio-button"
                    onClick={openYoudao}
                    disabled={!youdaoUrl}
                    title="打开有道词典"
                    aria-label="打开有道词典"
                    style={{ cursor: youdaoUrl ? 'pointer' : 'not-allowed', color: 'var(--ms-text)' }}
                  >
                    <UiIcon name="dictionary-link" size={17} />
                  </button>
                </div>
                <div className="vocab-review-hero-meta" style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <span className="vocab-review-chip vocab-review-category-chip" style={chipStyle()}>
                    <UiIcon name="folder" size={12} />
                    <span>{detailCategoryLabel}</span>
                  </span>
                  <span className="vocab-review-chip" style={chipStyle()}>
                    <UiIcon name="file" size={12} />
                    <span>释义 {definitions.length}</span>
                  </span>
                  <span className="vocab-review-chip" style={chipStyle()}>
                    <UiIcon name="list" size={12} />
                    <span>例句 {examples.length}</span>
                  </span>
                  <span className="vocab-review-chip" style={chipStyle()}>
                    <UiIcon name="history" size={12} />
                    <span>复习 {reviews.length}</span>
                  </span>
                  {latestReview ? (
                    <span className="vocab-review-chip vocab-review-chip-tone" style={{ ...chipStyle(), ...latestReviewTone }}>
                      <UiIcon name="star" size={12} />
                      <span>{normalizeReviewScore(latestReview.score)}/5</span>
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
            {desktopDefinitionCard}
          </div>
          <div
            className={`vocab-review-desktop-overview-graph${visibleRelationGraph?.fullComponent ? ' is-full-component' : ''}`}
            style={desktopOverviewLeftHeight ? { '--vocab-review-overview-left-height': `${desktopOverviewLeftHeight}px` } : undefined}
          >
            {relationGraphNode}
          </div>
        </div>
      ) : (
        <div className="vocab-review-hero" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
          <div className="vocab-review-hero-body">
            <div className="vocab-review-word-line" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <h1 className="vocab-review-hero-title" style={{ fontSize: 'clamp(28px, 4vw, 34px)', margin: 0, color: 'var(--ms-text)', lineHeight: 1.04, wordBreak: 'break-word' }}>{detailData.word}</h1>
              <button
                className="vocab-review-audio-button"
                onClick={() => playAudio(detailData.word, 2)}
                title="朗读单词"
                style={{ cursor: 'pointer', color: 'var(--ms-text)' }}
              >
                <UiIcon name="volume" size={18} />
              </button>
              <button
                type="button"
                className="vocab-review-audio-button"
                onClick={openYoudao}
                disabled={!youdaoUrl}
                title="打开有道词典"
                aria-label="打开有道词典"
                style={{ cursor: youdaoUrl ? 'pointer' : 'not-allowed', color: 'var(--ms-text)' }}
              >
                <UiIcon name="dictionary-link" size={17} />
              </button>
              {mobileSimple ? (
                <button
                  ref={infoButtonRef}
                  type="button"
                  className={`vocab-review-info-button${mobileInfoOpen ? ' is-active' : ''}`}
                  onClick={toggleMobileInfo}
                  aria-label="查看详情"
                  aria-expanded={mobileInfoOpen}
                  title="查看详情"
                >
                  <UiIcon name="info" size={15} />
                  <span>查看详情</span>
                </button>
              ) : null}
            </div>
            <div className="vocab-review-hero-meta" style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <span className="vocab-review-chip vocab-review-category-chip" style={chipStyle()}>
                <UiIcon name="folder" size={12} />
                <span>{detailCategoryLabel}</span>
              </span>
              <span className="vocab-review-chip" style={chipStyle()}>
                <UiIcon name="file" size={12} />
                <span>释义 {definitions.length}</span>
              </span>
              <span className="vocab-review-chip" style={chipStyle()}>
                <UiIcon name="list" size={12} />
                <span>例句 {examples.length}</span>
              </span>
              <span className="vocab-review-chip" style={chipStyle()}>
                <UiIcon name="history" size={12} />
                <span>复习 {reviews.length}</span>
              </span>
              {latestReview ? (
                <span className="vocab-review-chip vocab-review-chip-tone" style={{ ...chipStyle(), ...latestReviewTone }}>
                  <UiIcon name="star" size={12} />
                  <span>{normalizeReviewScore(latestReview.score)}/5</span>
                </span>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {mobileSimple ? (
        <div className="vocab-review-card vocab-review-score-card" style={{ ...metaCardStyle, display: 'grid', gap: '14px' }}>
          <div className="vocab-review-score-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ ...sectionTitleStyle, borderBottom: 'none', paddingBottom: 0, fontSize: '16px', marginBottom: '6px' }}>本次打分</h3>
              <div style={{ fontSize: '13px', color: 'var(--ms-text-muted)' }}>默认按今天日期记录熟练度</div>
            </div>
            <div className="vocab-review-score-head-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {latestReview ? (
                <span className="vocab-review-chip vocab-review-chip-tone" style={{ ...chipStyle(), ...latestReviewTone }}>
                  最近 {normalizeReviewScore(latestReview.score)}/5
                </span>
              ) : null}
            </div>
          </div>

          <div className="score-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px' }}>
            {[0, 1, 2, 3, 4, 5].map((score) => (
              <button
                key={score}
                type="button"
                className="score-btn"
                onClick={() => void handleSubmitReviewScore(score)}
                disabled={savingReviewScore}
                style={{
                  padding: '12px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--ms-border)',
                  background: '#fff',
                  color: 'var(--ms-text)',
                  fontSize: '12px',
                  fontWeight: 600,
                  lineHeight: 1.5,
                  cursor: savingReviewScore ? 'not-allowed' : 'pointer',
                }}
              >
                <strong style={{ display: 'block', fontSize: '16px' }}>{score}</strong>
                <span>{mobileSimple ? SCORE_SHORT_LABELS[score] : SCORE_LABELS[score]}</span>
              </button>
            ))}
          </div>

          {savingReviewScore ? (
            <div style={{ fontSize: '13px', color: 'var(--ms-text-muted)' }}>正在保存本次熟练度...</div>
          ) : null}
        </div>
      ) : null}

      {!mobileSimple ? (
        <div className="vocab-review-desktop-main-column vocab-review-desktop-detail-stack">
          <div className="vocab-review-sections vocab-review-examples-section vocab-review-desktop-examples-card" style={{ gap: '0' }}>
            <div className="vocab-review-desktop-examples-header">
              <span>例句</span>
              <span className="vocab-review-desktop-disclosure-meta">{examples.length}</span>
            </div>
            <div className="vocab-review-desktop-example-stack">
              {examples.length ? examples.map((example, index) => {
                const rawFocus = example.focusPositions ?? example.focusPosition ?? example.fp ?? example.fps ?? [];
                const normalizedFocus = normalizeFocusPositions(rawFocus, tokenizeFocusText(example.text).length);
                const exampleNoteKey = String(index);
                const noteCollapsed = Object.prototype.hasOwnProperty.call(desktopExampleNoteCollapsedOverrides, exampleNoteKey)
                  ? Boolean(desktopExampleNoteCollapsedOverrides[exampleNoteKey])
                  : desktopContentDefaultCollapsed;

                const renderedText = renderTextWithFocusPositions(example.text, rawFocus)
                  || renderTextWithFocusWords(example.text, example.focusWords);

                return (
                  <div
                    key={`example-${index}`}
                    className="vocab-review-example-card"
                    style={{
                      background: 'var(--ms-surface-strong)',
                      padding: '16px 18px',
                      borderRadius: '6px',
                      border: '1px solid var(--ms-border)',
                      borderLeft: '1px solid var(--ms-border)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px',
                    }}
                  >
                    <div className="vocab-review-example-header" style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <div className="vocab-review-example-index" style={{ fontSize: '12px', color: 'var(--ms-text-muted)', fontWeight: '600' }}>例句 {index + 1}</div>
                    </div>

                    <div className="vocab-review-example-main" style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                      <div
                        className="vocab-review-example-text"
                        style={{ fontSize: '15px', color: 'var(--ms-text)', lineHeight: '1.65', flex: 1 }}
                        dangerouslySetInnerHTML={{ __html: renderedText || escapeHtml(example.text) }}
                      />
                      <button
                        className="vocab-review-audio-button"
                        onClick={() => playAudio(example.text, 2)}
                        title="朗读完整例句"
                        style={{ cursor: 'pointer', flexShrink: 0, color: 'var(--ms-text)' }}
                      >
                        <UiIcon name="volume" size={16} />
                      </button>
                    </div>

                    {example.explanation ? (
                      <div className={`vocab-review-example-note vocab-review-desktop-example-note${noteCollapsed ? ' is-collapsed' : ''}`} style={{ fontSize: '13px', color: 'var(--ms-text-muted)', background: 'rgba(255, 255, 255, 0.9)', borderRadius: '6px', padding: '9px 10px', border: '1px solid rgba(213, 221, 208, 0.72)' }}>
                        <button
                          type="button"
                          className="vocab-review-desktop-note-toggle"
                          onClick={() => handleDesktopExampleNoteToggle(index)}
                          aria-expanded={!noteCollapsed}
                        >
                          <span>解析</span>
                          <UiIcon name={noteCollapsed ? 'chevron-down' : 'chevron-up'} size={13} />
                        </button>
                        {!noteCollapsed ? (
                          <div className="vocab-review-desktop-note-body">{example.explanation}</div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="vocab-review-chip-list" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {example.source?.text ? (
                        example.source?.url ? (
                          <a
                            href={example.source.url}
                            target="_blank"
                            rel="noreferrer"
                            className="vocab-review-chip vocab-review-chip-link"
                            style={{ ...chipStyle(), textDecoration: 'none' }}
                          >
                            来源: {example.source.text}
                          </a>
                        ) : (
                          <span className="vocab-review-chip" style={chipStyle()}>来源: {example.source.text}</span>
                        )
                      ) : null}

                      {example.youtube?.url ? (
                        <a
                          href={buildYouTubeLink(example.youtube.url, example.youtube.timestamp)}
                          target="_blank"
                          rel="noreferrer"
                          className="vocab-review-chip vocab-review-chip-link"
                          style={{ ...chipStyle(), textDecoration: 'none' }}
                        >
                          YouTube {formatYouTubeLabel(example.youtube.timestamp)}
                        </a>
                      ) : null}

                      {(Array.isArray(example.focusWords) ? example.focusWords : []).filter(Boolean).map((focusWord) => (
                        <span key={`${focusWord}-${index}`} className="vocab-review-chip" style={chipStyle()}>
                          focus: {focusWord}
                        </span>
                      ))}

                      {normalizedFocus.length ? (
                        <span className="vocab-review-chip" style={chipStyle()}>
                          positions: {normalizedFocus.join(', ')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              }) : (
                <div className="vocab-review-desktop-disclosure-body" style={{ color: '#a1a1aa', fontSize: '14px' }}>暂无例句</div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          {relationGraphNode}

          <div className="vocab-review-sections vocab-review-card vocab-review-definition-card" style={{ ...metaCardStyle, gap: '12px' }}>
            <div className="vocab-review-disclosure-summary">
              <span>释义 {definitions.length}</span>
              <button
                type="button"
                className="vocab-review-definition-mask-toggle"
                onClick={toggleDefinitionsMask}
                aria-pressed={definitionsMasked}
                aria-label={definitionMaskActionLabel}
                title={definitionMaskActionLabel}
              >
                <UiIcon name={definitionsMasked ? 'lock' : 'unlock'} size={13} />
                <span>{definitionsMasked ? '显示' : '遮蔽'}</span>
              </button>
            </div>
            <div className={`vocab-review-definition-maskable${definitionsMasked ? ' is-masked' : ''}`}>
              {definitions.length ? (
                <ul className="vocab-review-definition-list" style={{ paddingLeft: '20px', margin: 0, fontSize: '15px', lineHeight: '1.8' }}>
                  {definitions.map((definition, index) => (
                    <li key={`${definition}-${index}`} className="vocab-review-definition-item" style={{ marginBottom: '8px' }}>{definition}</li>
                  ))}
                </ul>
              ) : (
                <div style={{ color: '#a1a1aa', fontSize: '14px' }}>暂无释义</div>
              )}
            </div>
          </div>

          <div className="vocab-review-sections vocab-review-examples-section" style={{ gap: '16px' }}>
            <h3 style={sectionTitleStyle}>例句</h3>
            {examples.length ? examples.map((example, index) => {
              const rawFocus = example.focusPositions ?? example.focusPosition ?? example.fp ?? example.fps ?? [];
              const normalizedFocus = normalizeFocusPositions(rawFocus, tokenizeFocusText(example.text).length);

              const renderedText = renderTextWithFocusPositions(example.text, rawFocus)
                || renderTextWithFocusWords(example.text, example.focusWords);

              return (
                <div
                  key={`example-${index}`}
                  className="vocab-review-example-card"
                  style={{
                    background: 'var(--ms-surface-strong)',
                    padding: '20px',
                    borderRadius: '6px',
                    border: '1px solid var(--ms-border)',
                    borderLeft: '1px solid var(--ms-border)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                  }}
                >
                  <div className="vocab-review-example-header" style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <div className="vocab-review-example-index" style={{ fontSize: '13px', color: 'var(--ms-text-muted)', fontWeight: '600' }}>例句 {index + 1}</div>
                  </div>

                  <div className="vocab-review-example-main" style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                    <div
                      className="vocab-review-example-text"
                      style={{ fontSize: '16px', color: 'var(--ms-text)', lineHeight: '1.7', flex: 1 }}
                      dangerouslySetInnerHTML={{ __html: renderedText || escapeHtml(example.text) }}
                    />
                    <button
                      className="vocab-review-audio-button"
                      onClick={() => playAudio(example.text, 2)}
                      title="朗读完整例句"
                      style={{ cursor: 'pointer', flexShrink: 0, color: 'var(--ms-text)' }}
                    >
                      <UiIcon name="volume" size={16} />
                    </button>
                  </div>

                  {example.explanation ? (
                    <details className="vocab-review-example-note" style={{ background: 'rgba(255, 255, 255, 0.9)', borderRadius: '6px', padding: '10px 12px', border: '1px solid rgba(213, 221, 208, 0.72)' }}>
                      <summary className="vocab-review-disclosure-summary vocab-review-disclosure-summary-compact">
                        <span>解析</span>
                        <span className="vocab-review-disclosure-hint">点按展开</span>
                      </summary>
                      <div style={{ marginTop: '10px', fontSize: '14px', color: 'var(--ms-text-muted)' }}>{example.explanation}</div>
                    </details>
                  ) : null}

                  <div className="vocab-review-chip-list" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {example.source?.text ? (
                      example.source?.url ? (
                        <a
                          href={example.source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="vocab-review-chip vocab-review-chip-link"
                          style={{ ...chipStyle(), textDecoration: 'none' }}
                        >
                          来源: {example.source.text}
                        </a>
                      ) : (
                        <span className="vocab-review-chip" style={chipStyle()}>来源: {example.source.text}</span>
                      )
                    ) : null}

                    {example.youtube?.url ? (
                      <a
                        href={buildYouTubeLink(example.youtube.url, example.youtube.timestamp)}
                        target="_blank"
                        rel="noreferrer"
                        className="vocab-review-chip vocab-review-chip-link"
                        style={{ ...chipStyle(), textDecoration: 'none' }}
                      >
                        YouTube {formatYouTubeLabel(example.youtube.timestamp)}
                      </a>
                    ) : null}

                    {(Array.isArray(example.focusWords) ? example.focusWords : []).filter(Boolean).map((focusWord) => (
                      <span key={`${focusWord}-${index}`} className="vocab-review-chip" style={chipStyle()}>
                        focus: {focusWord}
                      </span>
                    ))}

                    {normalizedFocus.length ? (
                      <span className="vocab-review-chip" style={chipStyle()}>
                        positions: {normalizedFocus.join(', ')}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            }) : (
              <div style={{ color: '#a1a1aa', fontSize: '14px' }}>暂无例句</div>
            )}
          </div>
        </>
      )}
    </div>
  ) : (
    <div className="vocab-review-empty vocab-review-empty-state" style={{ display: 'flex', minHeight: compactDesktop && !mobileSimple ? '0' : '100%', alignItems: compactDesktop && !mobileSimple ? 'flex-start' : 'center', justifyContent: compactDesktop && !mobileSimple ? 'flex-start' : 'center', color: '#a1a1aa' }}>
      <div className="vocab-review-empty-card" style={{ width: '100%', maxWidth: compactDesktop && !mobileSimple ? '520px' : '560px', display: 'grid', gap: compactDesktop && !mobileSimple ? '10px' : '12px', padding: compactDesktop && !mobileSimple ? '16px 18px' : '20px', border: '1px dashed var(--ms-border)', borderRadius: '6px', background: 'rgba(255,255,255,0.96)' }}>
        <div className="vocab-review-empty-title" style={{ fontSize: compactDesktop && !mobileSimple ? '18px' : '20px', lineHeight: 1.15, fontWeight: 720, color: 'var(--ms-text)' }}>
          {emptyTitle}
        </div>
        <div className="vocab-review-empty-status" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', color: 'var(--ms-text-muted)', fontSize: '12px' }}>
          {emptyStatusItems.map((item) => (
            <span key={item} className="vocab-review-empty-status-item">{item}</span>
          ))}
          {!mobileSimple && normalizedWordQuery ? <span className="vocab-review-empty-status-item">{wordQuery.trim()}</span> : null}
        </div>
        {compactDesktopSurface ? (
          <div className="vocab-review-empty-actions">
            {randomSelectionMode && visibleEntries.length ? (
              <button
                type="button"
                className="master-primary-button vocab-review-empty-primary-action"
                onClick={() => handleRecommendationNext()}
                disabled={loadingRecommendation || !visibleEntries.length}
              >
                <UiIcon name="shuffle" size={14} />
                <span>{loadingRecommendation ? '抽取中' : '随机抽词'}</span>
              </button>
            ) : null}
            {!randomSelectionMode && visibleEntries.length ? (
              <div className="vocab-review-empty-hint-pill">
                <UiIcon name="list" size={14} />
                <span>右侧点选</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (compactDesktop && !mobileSimple) {
    const randomMode = selectionMode === 'random';
    return (
      <div
        className="vocab-review vocab-review-compact-desktop"
        style={{
          display: 'flex',
          gap: '14px',
          height: '100%',
          width: '100%',
          minWidth: 0,
          padding: '16px 18px 18px',
          background: 'transparent',
          overflow: 'hidden',
        }}
      >
        {workspaceToolbarControlsNode}
        <div
          className="vocab-review-sidebar"
          style={{
            width: '320px',
            minWidth: '280px',
            maxWidth: '340px',
            border: '1px solid var(--ms-border)',
            borderRadius: '6px',
            background: 'rgba(255, 255, 255, 0.94)',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            overflow: 'hidden',
          }}
        >
          <div
            className="vocab-review-sidebar-header"
            style={{
              padding: '14px 16px',
              borderBottom: '1px solid var(--ms-border)',
              background: 'rgba(255, 255, 255, 0.98)',
              display: 'grid',
              gap: '10px',
            }}
          >
            {!movePrimaryControlsToWorkspaceToolbar ? (
              <select
                className="vocab-review-select"
                value={selectedCategory}
                onChange={(e) => applySelectedCategory(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', fontSize: '13px', outline: 'none', background: '#fff', color: 'var(--ms-text)' }}
              >
                {compactCategoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            ) : null}

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <span className="vocab-review-chip" style={chipStyle()}>范围: {selectedCategoryLabel}</span>
              <span className="vocab-review-chip" style={chipStyle()}>词池 {visibleEntries.length}</span>
              <span className="vocab-review-chip" style={chipStyle()}>
                {randomMode ? '随机跳词' : '手动选词'}
              </span>
            </div>
          </div>

          {desktopPoolControlsNode}

          <div
            className="vocab-review-sidebar-meta"
            style={{
              padding: '13px 16px',
              borderBottom: '1px solid var(--ms-border)',
              background: 'rgba(255, 255, 255, 0.98)',
              display: 'grid',
              gap: '8px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
              <strong className="vocab-review-sidebar-title" style={{ fontSize: '14px', color: 'var(--ms-text)' }}>
                {randomMode
                  ? `推荐范围 (${visibleEntries.length}${normalizedWordQuery ? ` / ${filteredEntries.length}` : ''})`
                  : `生词本 (${visibleEntries.length}${normalizedWordQuery ? ` / ${filteredEntries.length}` : ''})`}
              </strong>
              <button
                className="vocab-review-icon-button"
                onClick={() => { void loadCategories(); void loadEntries(selectedCategory); }}
                disabled={!String(selectedCategory || '').trim()}
                title="刷新词池"
                style={{ cursor: String(selectedCategory || '').trim() ? 'pointer' : 'not-allowed', opacity: String(selectedCategory || '').trim() ? 1 : 0.4 }}
              >
                <UiIcon name="refresh" size={14} />
              </button>
            </div>
            <div className="vocab-review-sidebar-caption">
              {randomMode
                ? '点击词条可直接展开，主操作会继续随机跳词。'
                : '支持筛选、点选和快速定位。'}
            </div>
            {randomMode ? (
              <div className="vocab-recommend-sidebar-actions">
                <button
                  type="button"
                  className="master-primary-button"
                  onClick={() => handleRecommendationNext()}
                  disabled={loadingRecommendation || !visibleEntries.length}
                >
                  {loadingRecommendation ? '抽取中' : '随机抽词'}
                </button>
                <button
                  type="button"
                  className={`vocab-review-filter-pill${recommendSettingsOpen ? ' is-active' : ''}`}
                  onClick={() => setRecommendSettingsOpen((open) => !open)}
                  aria-label="打开随机设置"
                  aria-expanded={recommendSettingsOpen}
                >
                  设置
                </button>
              </div>
            ) : null}
          </div>

          {randomMode ? sidebarRandomPreviewNode : sidebarWordListNode}
        </div>

        <div
          className="vocab-review-content"
          style={{
            flex: 1,
            minWidth: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '0',
          }}
        >
          {recommendationSettingsNode}
          {detailNode}
        </div>
      </div>
    );
  }

  if (mobileSimple) {
    return (
      <div
        className={`vocab-review vocab-review-mobile-simple${compactDesktop ? ' is-compact-desktop' : ''}${randomSelectionMode ? ' is-random-mode' : ''}`}
        style={mobileSimpleRootStyle}
      >
        {workspaceToolbarControlsNode}
        <div className={`vocab-review-mobile-toolbar${compactDesktop ? ' is-compact-desktop' : ''}`} style={mobileSimpleToolbarStyle}>
          <div className="vocab-review-mobile-compact-row">
            <div className="vocab-review-mobile-compact-meta">
              <div className="vocab-review-mobile-compact-title">生词本</div>
              <div className="vocab-review-mobile-compact-caption">
                {`${selectedCategoryLabel} · ${activeFilterOption.label} · ${visibleEntries.length} / ${entries.length}`}
              </div>
            </div>
            <button
              type="button"
              className={`vocab-review-mobile-tools-button vocab-review-mode-tools-button${mobileFiltersOpen ? ' is-active' : ''}`}
              onClick={() => setMobileFiltersOpen((open) => !open)}
              aria-label={`打开${mobileToolsTitle}`}
              aria-expanded={mobileFiltersOpen}
              title={mobileToolsTitle}
            >
              <UiIcon name={randomSelectionMode ? 'tune' : 'list'} size={17} />
            </button>
          </div>

          {mobileUnifiedToolsNode}
        </div>

        <div className="vocab-review-content" style={mobileSimpleContentStyle}>
          {detailNode}
        </div>
        {mobileInfoOpen && detailData ? (
          <div className="vocab-review-floating-layer vocab-review-info-floating-layer" role="presentation">
            <button type="button" className="vocab-review-floating-backdrop" aria-label="关闭复习记录" onClick={closeMobileInfo} />
            <section
              className={`vocab-review-floating-panel vocab-review-info-floating-panel${mobileInfoPanelPosition ? ' is-anchor-positioned' : ''}`}
              style={mobileInfoPanelStyle}
              role="dialog"
              aria-modal="false"
              aria-label="复习记录"
            >
              <div className="vocab-review-floating-header">
                  <div>
                    <div className="vocab-review-floating-title">复习记录</div>
                  <div className="vocab-review-floating-caption">{detailData.word || detailData.key || selectedEntry?.word || ''}</div>
                </div>
                <button type="button" className="vocab-review-mobile-tools-button" aria-label="关闭复习记录" onClick={closeMobileInfo}>
                  <UiIcon name="close" size={16} />
                </button>
              </div>
              <div className="vocab-review-info-floating-stack">
                <div className="vocab-review-info-summary">
                  <div>
                    <span>首次</span>
                    <strong>{detailData.createdAt || '未知'}</strong>
                  </div>
                  <div>
                    <span>最近</span>
                    <strong>{latestReview ? `${latestReview.date} · ${normalizeReviewScore(latestReview.score)}/5` : '暂无'}</strong>
                  </div>
                  <div>
                    <span>累计</span>
                    <strong>{reviews.length} 次</strong>
                  </div>
                  <div>
                    <span>来源</span>
                    <strong>{mergedFrom.length ? mergedFrom.join(', ') : '无'}</strong>
                  </div>
                </div>

                {displayTags.length ? (
                  <div className="vocab-review-info-tag-row">
                    {displayTags.map((tag) => (
                      <span key={tag} className="vocab-review-chip" style={chipStyle()}>{tag}</span>
                    ))}
                  </div>
                ) : null}

                <div className="vocab-review-info-record-list">
                  {reviews.length ? reviews.map((review, index) => (
                    <div
                      key={`${review.date || 'unknown'}-${index}`}
                      className="vocab-review-info-record-row"
                      style={getReviewToneStyle(review.score)}
                    >
                      <span>{review.date || '未知时间'}</span>
                      <strong>{normalizeReviewScore(review.score)}/5 · {SCORE_SHORT_LABELS[normalizeReviewScore(review.score)]}</strong>
                    </div>
                  )) : (
                    <div className="vocab-review-info-empty">暂无复习记录</div>
                  )}
                </div>
              </div>
            </section>
          </div>
        ) : null}
        {mobileScoreControls}
      </div>
    );
  }

  return (
    <div className={`vocab-review vocab-review-desktop-split${randomSelectionMode ? ' is-random-mode' : ''}`} style={{ display: 'flex', height: '100%', width: '100%', background: 'transparent' }}>
      {workspaceToolbarControlsNode}
      {recommendationSettingsNode}
      <div className="vocab-review-content" style={{ flex: 1, padding: '30px 32px', overflowY: 'auto' }}>
        {detailNode}
      </div>

      <aside className="vocab-review-sidebar vocab-review-control-sidebar" style={{ width: '312px', borderLeft: '1px solid var(--ms-border)', background: 'rgba(255, 255, 255, 0.92)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        {desktopReviewControlsNode}
        {movePrimaryControlsToWorkspaceToolbar ? null : desktopContentPreferenceNode}
        {desktopPoolControlsNode}

        <div className="vocab-review-sidebar-meta" style={{ padding: '10px 14px', borderBottom: '1px solid var(--ms-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
          <strong className="vocab-review-sidebar-title" style={{ fontSize: '14px', color: 'var(--ms-text)' }}>
            {randomSelectionMode ? '推荐范围' : '生词本'} ({visibleEntries.length}{normalizedWordQuery ? ` / ${filteredEntries.length}` : ''})
          </strong>
          {randomSelectionMode ? (
            <button
              className="vocab-review-refresh-button"
              onClick={() => setRecommendSettingsOpen((open) => !open)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ms-text)', fontSize: '12px' }}
              aria-label="打开随机设置"
              aria-expanded={recommendSettingsOpen}
            >
              设置
            </button>
          ) : (
            <button className="vocab-review-refresh-button" onClick={() => { void loadCategories(); void loadEntries(selectedCategory); }} disabled={!String(selectedCategory || '').trim()} style={{ background: 'none', border: 'none', cursor: String(selectedCategory || '').trim() ? 'pointer' : 'not-allowed', color: 'var(--ms-text)', fontSize: '12px', opacity: String(selectedCategory || '').trim() ? 1 : 0.4 }}>刷新</button>
          )}
        </div>

        {randomSelectionMode ? sidebarRandomPreviewNode : sidebarWordListNode}
      </aside>
    </div>
  );
}
