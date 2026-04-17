import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  getVocabularyCategories,
  getVocabularyDetail,
  getVocabularyList,
  saveVocabularyDetail,
  submitReviewScore,
} from '../api/client';

const REVIEW_CATEGORY_KEY = 'vocabReviewCategory';
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
const ENTRY_FILTER_OPTIONS = [
  { value: 'marked', label: '标记词条' },
  { value: 'all', label: '全部词条' },
  { value: 'unmarked', label: '未标记' },
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

const normalizeVocabularyEntry = (entry, fallbackCategory = '') => {
  const key = normalizeVocabularyLaunchWord(entry?.key || entry?.file || entry?.word);
  const file = String(entry?.file || (key ? `${key}.json` : '')).trim();
  const word = String(entry?.word || key || '').trim();
  const category = String(entry?.category || fallbackCategory || '').trim();
  return {
    id: buildVocabularyEntryId(category, file || key || word),
    key,
    file,
    word: word || key,
    category,
    marked: Boolean(entry?.marked),
  };
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

const formatReviewStars = (score) => {
  const normalizedScore = normalizeReviewScore(score);
  return `${'★'.repeat(normalizedScore)}${'☆'.repeat(5 - normalizedScore)}`;
};

const formatReviewSummary = (score) => {
  const normalizedScore = normalizeReviewScore(score);
  return `${formatReviewStars(normalizedScore)} (${normalizedScore}/5, ${SCORE_LABELS[normalizedScore]})`;
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
  fontSize: '12px',
  color: 'var(--ms-text-faint)',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  fontWeight: 700,
};

const metaCardStyle = {
  background: 'var(--ms-surface-strong)',
  border: '1px solid var(--ms-border)',
  borderRadius: '6px',
  padding: '24px',
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
  onOpenReviewEntry = null,
  launchRequest = null,
  mobileSimple = false,
  compactDesktop = false,
}) {
  const [entries, setEntries] = useState([]);
  const [entriesCategory, setEntriesCategory] = useState('');
  const [selectedEntryId, setSelectedEntryId] = useState('');
  const [detailData, setDetailData] = useState(null);
  const [detailCategory, setDetailCategory] = useState('');
  const [categories, setCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(() => (
    mobileSimple ? ALL_CATEGORIES_VALUE : getStoredReviewCategory()
  ));
  const [wordQuery, setWordQuery] = useState('');
  const [entryFilter, setEntryFilter] = useState(() => (mobileSimple ? 'all' : 'marked'));
  const [savingMarked, setSavingMarked] = useState(false);
  const [savingReviewScore, setSavingReviewScore] = useState(false);
  const pendingLaunchRef = useRef(null);
  const selectedCategoryRef = useRef(selectedCategory);
  const entriesRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const previousMobileSimpleRef = useRef(mobileSimple);

  const resetCurrentEntry = useCallback((nextEntries = []) => {
    detailRequestRef.current += 1;
    setEntries(nextEntries);
    setEntriesCategory('');
    setSelectedEntryId('');
    setDetailData(null);
    setDetailCategory('');
  }, []);

  const applySelectedCategory = useCallback((nextCategory, { resetQuery = true } = {}) => {
    const normalizedCategory = String(nextCategory || '').trim();
    setSelectedCategory(normalizedCategory);
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
          .sort((a, b) => (
            String(a.word || '').localeCompare(String(b.word || ''), undefined, { sensitivity: 'base' })
            || String(a.category || '').localeCompare(String(b.category || ''), undefined, { sensitivity: 'base' })
          ));
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

  const handleSelectEntry = useCallback(async (entryLike, categoryOverride = selectedCategory, pool = entries) => {
    const resolvedEntry = resolveEntryCandidate(entryLike, categoryOverride, pool);
    if (!resolvedEntry) return;

    const normalizedCategory = String(categoryOverride || '').trim();
    const requestCategory = resolveEntryCategory(resolvedEntry, normalizedCategory);
    if (!requestCategory) return;
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setSelectedEntryId(resolvedEntry.id);
    setDetailData(null);
    setDetailCategory(requestCategory);
    try {
      const res = await getVocabularyDetail(resolvedEntry.key || resolvedEntry.file || resolvedEntry.word, requestCategory);
      if (detailRequestRef.current !== requestId) return;
      if (res.data) setDetailData(res.data);
    } catch (error) {
      if (detailRequestRef.current !== requestId) return;
      if (selectedCategoryRef.current !== normalizedCategory) return;
      setDetailCategory('');
      console.error('加载详情失败', error);
      alert('加载详情失败');
    }
  }, [entries, resolveEntryCandidate, resolveEntryCategory, selectedCategory]);

  useEffect(() => {
    selectedCategoryRef.current = selectedCategory;
  }, [selectedCategory]);

  useEffect(() => {
    const enteringMobileSimple = mobileSimple && !previousMobileSimpleRef.current;

    if (compactDesktop) {
      if (!isAllCategoriesValue(selectedCategoryRef.current)) {
        applySelectedCategory(ALL_CATEGORIES_VALUE, { resetQuery: true });
      }
      setEntryFilter('all');
      previousMobileSimpleRef.current = mobileSimple;
      return;
    }

    if (enteringMobileSimple) {
      applySelectedCategory(ALL_CATEGORIES_VALUE, { resetQuery: true });
      setEntryFilter('all');
      previousMobileSimpleRef.current = mobileSimple;
      return;
    }

    if (!mobileSimple && isAllCategoriesValue(selectedCategoryRef.current)) {
      applySelectedCategory(getStoredReviewCategory(), { resetQuery: true });
    }
    if (!mobileSimple) {
      setEntryFilter('marked');
    }
    previousMobileSimpleRef.current = mobileSimple;
  }, [applySelectedCategory, compactDesktop, mobileSimple]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadCategories();
    });

    const handleConfigUpdate = () => {
      if (mobileSimple && isAllCategoriesValue(selectedCategoryRef.current)) {
        return;
      }
      if (compactDesktop) {
        if (!isAllCategoriesValue(selectedCategoryRef.current)) {
          applySelectedCategory(ALL_CATEGORIES_VALUE);
        }
        return;
      }
      const nextCategory = getStoredReviewCategory();
      if (nextCategory === selectedCategoryRef.current) return;
      applySelectedCategory(nextCategory);
    };

    window.addEventListener('config-updated', handleConfigUpdate);
    window.addEventListener('default-category-updated', handleConfigUpdate);

    return () => {
      window.removeEventListener('config-updated', handleConfigUpdate);
      window.removeEventListener('default-category-updated', handleConfigUpdate);
    };
  }, [applySelectedCategory, compactDesktop, loadCategories, mobileSimple]);

  useEffect(() => {
    if (isAllCategoriesValue(selectedCategory)) return;
    localStorage.setItem(REVIEW_CATEGORY_KEY, selectedCategory || '');
  }, [selectedCategory]);

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
    if (!launchRequest?.word) return;

    const targetCategory = String(launchRequest.category || '').trim();
    const targetWord = normalizeVocabularyLaunchWord(launchRequest.word);
    const targetFileKey = normalizeVocabularyLaunchWord(launchRequest.fileKey || launchRequest.word);
    const browsingAllCategories = isAllCategoriesValue(selectedCategory);
    if (!targetWord) return;

    pendingLaunchRef.current = {
      category: targetCategory,
      word: targetWord,
      fileKey: targetFileKey,
    };

    if (!browsingAllCategories && targetCategory !== selectedCategory) {
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
  }, [applySelectedCategory, entries, handleSelectEntry, launchRequest, resolveEntryCandidate, selectedCategory]);

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

  const handleSubmitReviewScore = useCallback(async (score) => {
    const currentEntry = entries.find((item) => item.id === selectedEntryId)
      || resolveEntryCandidate(detailData?.word, selectedCategory, entries);
    const currentEntryCategory = detailCategory || resolveEntryCategory(currentEntry, selectedCategory);
    if (!detailData || !currentEntry?.file || !currentEntryCategory) return;

    setSavingReviewScore(true);
    try {
      await submitReviewScore(currentEntryCategory, currentEntry.file, score, getTodayLocalDateString());
      const res = await getVocabularyDetail(currentEntry.key || currentEntry.file || currentEntry.word, currentEntryCategory);
      if (res?.data) setDetailData(res.data);
    } catch (error) {
      console.error('记录熟练度失败', error);
      alert('记录熟练度失败');
    } finally {
      setSavingReviewScore(false);
    }
  }, [detailCategory, detailData, entries, resolveEntryCandidate, resolveEntryCategory, selectedCategory, selectedEntryId]);

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

  const selectedEntry = entries.find((item) => item.id === selectedEntryId) || null;
  const normalizedWordQuery = String(wordQuery || '').trim().toLowerCase();
  const filterCounts = {
    marked: entries.filter((item) => item.marked).length,
    all: entries.length,
    unmarked: entries.filter((item) => !item.marked).length,
  };
  const filteredEntries = entries.filter((entry) => {
    if (entryFilter === 'marked') return entry.marked;
    if (entryFilter === 'unmarked') return !entry.marked;
    return true;
  });
  const visibleEntries = filteredEntries.filter((entry) => {
    if (!normalizedWordQuery) return true;
    return [entry.word, entry.key, entry.file]
      .map((item) => String(item || '').toLowerCase())
      .some((item) => item.includes(normalizedWordQuery));
  });

  const handleDrawRandomEntry = useCallback((pool = visibleEntries) => {
    const picked = pickRandomEntry(pool, selectedEntryId);
    if (!picked) return;
    void handleSelectEntry(picked, selectedCategory, entries);
  }, [entries, handleSelectEntry, selectedCategory, selectedEntryId, visibleEntries]);

  useEffect(() => {
    if (!mobileSimple) return;
    if (!selectedCategory) return;
    if (entriesCategory !== selectedCategory) return;
    if (!visibleEntries.length) {
      detailRequestRef.current += 1;
      setSelectedEntryId('');
      setDetailData(null);
      setDetailCategory('');
      return;
    }

    const stillVisible = visibleEntries.some((item) => item.id === selectedEntryId);
    if (stillVisible) return;

    queueMicrotask(() => {
      handleDrawRandomEntry(visibleEntries);
    });
  }, [entriesCategory, handleDrawRandomEntry, mobileSimple, selectedCategory, selectedEntryId, visibleEntries]);

  const handleToggleMarked = useCallback(async () => {
    const currentEntry = selectedEntry || resolveEntryCandidate(detailData?.word, selectedCategory, entries);
    const currentEntryCategory = detailCategory || resolveEntryCategory(currentEntry, selectedCategory);
    if (!detailData || !currentEntry?.file || !currentEntryCategory) return;

    setSavingMarked(true);
    try {
      const payload = {
        ...detailData,
        marked: !Boolean(detailData?.marked),
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
    } catch (error) {
      console.error('更新词条标记失败', error);
      alert('更新词条标记失败');
    } finally {
      setSavingMarked(false);
    }
  }, [detailCategory, detailData, entries, resolveEntryCandidate, resolveEntryCategory, selectedCategory, selectedEntry]);

  const handleOpenReviewWorkspace = () => {
    const currentEntry = selectedEntry || resolveEntryCandidate(detailData?.word, selectedCategory, entries);
    const currentEntryCategory = detailCategory || resolveEntryCategory(currentEntry, selectedCategory);
    if (!detailData?.word || !currentEntryCategory || typeof onOpenReviewEntry !== 'function') return;
    onOpenReviewEntry({
      category: currentEntryCategory,
      word: detailData.word,
      focus: 'clean',
    });
  };

  const reviews = Array.isArray(detailData?.reviews) ? detailData.reviews : [];
  const definitions = Array.isArray(detailData?.definitions) ? detailData.definitions : [];
  const examples = Array.isArray(detailData?.examples) ? detailData.examples : [];
  const mergedFrom = Array.isArray(detailData?.mergedFrom)
    ? detailData.mergedFrom.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const rawTags = Array.isArray(detailData?.tags)
    ? detailData.tags.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
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
  const compactCategoryOptions = mobileSimple
    ? [{ value: ALL_CATEGORIES_VALUE, label: '全部目录' }, ...categories.map((item) => ({ value: item, label: item }))]
    : categories.map((item) => ({ value: item, label: item }));
  const mobileSimpleRootStyle = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    background: compactDesktop ? 'linear-gradient(180deg, rgba(250, 250, 250, 0.96), rgba(244, 244, 244, 0.92))' : 'transparent',
    overflowY: compactDesktop ? 'auto' : 'hidden',
    padding: compactDesktop ? '24px' : '0',
    gap: compactDesktop ? '18px' : '0',
  };
  const mobileSimpleToolbarStyle = {
    width: '100%',
    maxWidth: compactDesktop ? '1120px' : 'none',
    margin: compactDesktop ? '0 auto' : '0',
    padding: compactDesktop ? '18px 20px' : '16px',
    border: compactDesktop ? '1px solid var(--ms-border)' : 'none',
    borderBottom: compactDesktop ? 'none' : '1px solid var(--ms-border)',
    borderRadius: compactDesktop ? '12px' : '0',
    background: 'rgba(255, 255, 255, 0.94)',
    display: 'grid',
    gap: '12px',
  };
  const mobileSimpleToolbarGridStyle = {
    display: 'grid',
    gap: '12px 16px',
    gridTemplateColumns: compactDesktop ? 'repeat(auto-fit, minmax(280px, 1fr))' : '1fr',
    alignItems: 'start',
  };
  const mobileSimpleContentStyle = {
    flex: compactDesktop ? '0 0 auto' : 1,
    width: '100%',
    maxWidth: compactDesktop ? '1120px' : 'none',
    margin: compactDesktop ? '0 auto' : '0',
    padding: compactDesktop ? '0 0 24px' : '20px 16px 28px',
    overflowY: compactDesktop ? 'visible' : 'auto',
  };

  const detailNode = detailData ? (
    <div className="vocab-review-shell">
      <div className="vocab-review-hero" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <h1 className="vocab-review-hero-title" style={{ fontSize: 'clamp(28px, 5vw, 38px)', margin: 0, color: 'var(--ms-text)', lineHeight: 1.06, wordBreak: 'break-word' }}>{detailData.word}</h1>
            <button
              className="vocab-review-audio-button"
              onClick={() => playAudio(detailData.word, 2)}
              title="朗读单词"
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', padding: '0 4px' }}
            >
              🔊
            </button>
          </div>
          <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <span className="vocab-review-chip" style={chipStyle()}>目录: {detailCategoryLabel}</span>
            <span className="vocab-review-chip" style={chipStyle()}>释义 {definitions.length}</span>
            <span className="vocab-review-chip" style={chipStyle()}>例句 {examples.length}</span>
            <span className="vocab-review-chip" style={chipStyle()}>复习 {reviews.length}</span>
            {latestReview ? <span className="vocab-review-chip vocab-review-chip-tone" style={{ ...chipStyle(), ...latestReviewTone }}>最近熟练度 {normalizeReviewScore(latestReview.score)}/5</span> : null}
          </div>
        </div>

        <div className="vocab-review-hero-actions" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          {!mobileSimple ? (
            <button
              type="button"
              onClick={() => void handleToggleMarked()}
              disabled={savingMarked}
              style={{
                padding: '8px 16px',
                borderRadius: '6px',
                border: '1px solid var(--ms-border)',
                background: detailData?.marked ? 'var(--ms-surface-muted)' : '#fff',
                color: 'var(--ms-text)',
                fontSize: '13px',
                fontWeight: '600',
                cursor: savingMarked ? 'not-allowed' : 'pointer',
              }}
            >
              {savingMarked ? '保存中...' : (detailData?.marked ? '取消标记' : '标记词条')}
            </button>
          ) : null}
          {!mobileSimple && typeof onOpenReviewEntry === 'function' ? (
            <button
              onClick={handleOpenReviewWorkspace}
              className="master-primary-button"
              style={{
                padding: '8px 16px',
                color: '#fff',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: '600',
                cursor: 'pointer',
              }}
            >
              去精修与复习
            </button>
          ) : null}
        </div>
      </div>

      {mobileSimple ? (
        <div className="vocab-review-card" style={{ ...metaCardStyle, display: 'grid', gap: '14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ ...sectionTitleStyle, borderBottom: 'none', paddingBottom: 0, fontSize: '16px', marginBottom: '6px' }}>本次打分</h3>
              <div style={{ fontSize: '13px', color: 'var(--ms-text-muted)' }}>默认按今天日期记录熟练度</div>
            </div>
            {latestReview ? (
              <span className="vocab-review-chip vocab-review-chip-tone" style={{ ...chipStyle(), ...latestReviewTone }}>
                最近 {normalizeReviewScore(latestReview.score)}/5
              </span>
            ) : null}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px' }}>
            {[0, 1, 2, 3, 4, 5].map((score) => (
              <button
                key={score}
                type="button"
                onClick={() => void handleSubmitReviewScore(score)}
                disabled={savingReviewScore}
                style={{
                  padding: '12px 10px',
                  borderRadius: '8px',
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
                <span>{SCORE_LABELS[score]}</span>
              </button>
            ))}
          </div>

          {savingReviewScore ? (
            <div style={{ fontSize: '13px', color: 'var(--ms-text-muted)' }}>正在保存本次熟练度...</div>
          ) : null}
        </div>
      ) : null}

      <div className="vocab-review-card" style={{ ...metaCardStyle, display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <h3 style={{ ...sectionTitleStyle, borderBottom: 'none', paddingBottom: 0, fontSize: '16px' }}>词条属性</h3>

        <div className="vocab-review-info-grid">
          <div>
            <div className="vocab-review-meta-label" style={{ fontSize: '12px', color: 'var(--ms-text-muted)', marginBottom: '4px' }}>首次记录</div>
            <div className="vocab-review-meta-value" style={{ fontSize: '14px', color: 'var(--ms-text)', fontWeight: '600' }}>{detailData.createdAt || '未知'}</div>
          </div>
          <div>
            <div className="vocab-review-meta-label" style={{ fontSize: '12px', color: 'var(--ms-text-muted)', marginBottom: '4px' }}>最近复习</div>
            <div className="vocab-review-meta-value" style={{ fontSize: '14px', color: 'var(--ms-text)', fontWeight: '600' }}>
              {latestReview ? `${latestReview.date} / ${normalizeReviewScore(latestReview.score)}/5 ${SCORE_LABELS[normalizeReviewScore(latestReview.score)]}` : '暂无'}
            </div>
          </div>
          <div>
            <div className="vocab-review-meta-label" style={{ fontSize: '12px', color: 'var(--ms-text-muted)', marginBottom: '4px' }}>合并来源</div>
            <div className="vocab-review-meta-value" style={{ fontSize: '14px', color: 'var(--ms-text)', fontWeight: '600' }}>
              {mergedFrom.length ? mergedFrom.join(', ') : '无'}
            </div>
          </div>
        </div>

        {displayTags.length ? (
          <div>
            <div className="vocab-review-meta-label" style={{ fontSize: '12px', color: 'var(--ms-text-muted)', marginBottom: '8px' }}>标签</div>
            <div className="vocab-review-chip-list" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {displayTags.map((tag) => (
                <span key={tag} className="vocab-review-chip" style={chipStyle()}>{tag}</span>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="vocab-review-card" style={metaCardStyle}>
        <h3 style={{ ...sectionTitleStyle, borderBottom: 'none', paddingBottom: 0, fontSize: '16px', marginBottom: '14px' }}>学习数据</h3>
        <div style={{ display: 'grid', gap: '10px' }}>
          <div className="vocab-review-data-row" style={{ fontSize: '14px', color: 'var(--ms-text-muted)' }}>
            初次记录: <strong className="vocab-review-data-value" style={{ color: 'var(--ms-text)' }}>{detailData.createdAt || '未知'}</strong>
          </div>
          <div className="vocab-review-data-row" style={{ fontSize: '14px', color: 'var(--ms-text-muted)' }}>
            累计复习: <strong className="vocab-review-data-value" style={{ color: 'var(--ms-text)' }}>{reviews.length}</strong> 次
          </div>
          {reviews.length ? (
            <div className="vocab-review-review-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
              {reviews.map((review, index) => (
                <div
                  key={`${review.date || 'unknown'}-${index}`}
                  className="vocab-review-review-row"
                  style={{
                    ...getReviewToneStyle(review.score),
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '12px',
                    flexWrap: 'wrap',
                    padding: '10px 12px',
                    borderRadius: '6px',
                  }}
                >
                  <span className="vocab-review-review-date" style={{ fontSize: '13px', color: 'inherit', fontWeight: '600' }}>{review.date || '未知时间'}</span>
                  <span className="vocab-review-review-score" style={{ fontSize: '13px', color: 'inherit' }}>
                    熟练度: {formatReviewSummary(review.score)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: '13px', color: '#a1a1aa' }}>还没有复习记录。</div>
          )}
        </div>
      </div>

      <div className="vocab-review-sections vocab-review-card" style={{ ...metaCardStyle, gap: '12px' }}>
        {mobileSimple ? (
          <details>
            <summary className="vocab-review-disclosure-summary">
              <span>释义 {definitions.length}</span>
              <span className="vocab-review-disclosure-hint">点按展开</span>
            </summary>
            <div style={{ marginTop: '14px' }}>
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
          </details>
        ) : (
          <>
            <h3 style={sectionTitleStyle}>释义</h3>
            {definitions.length ? (
              <ul className="vocab-review-definition-list" style={{ paddingLeft: '20px', margin: 0, fontSize: '15px', lineHeight: '1.8' }}>
                {definitions.map((definition, index) => (
                  <li key={`${definition}-${index}`} className="vocab-review-definition-item" style={{ marginBottom: '8px' }}>{definition}</li>
                ))}
              </ul>
            ) : (
              <div style={{ color: '#a1a1aa', fontSize: '14px' }}>暂无释义</div>
            )}
          </>
        )}
      </div>

      <div className="vocab-review-sections" style={{ gap: '16px' }}>
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
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', padding: '0 4px', flexShrink: 0 }}
                >
                  🔊
                </button>
              </div>

              {example.explanation ? (
                mobileSimple ? (
                  <details className="vocab-review-example-note" style={{ background: 'rgba(255, 255, 255, 0.9)', borderRadius: '6px', padding: '10px 12px', border: '1px solid rgba(213, 221, 208, 0.72)' }}>
                    <summary className="vocab-review-disclosure-summary vocab-review-disclosure-summary-compact">
                      <span>解析</span>
                      <span className="vocab-review-disclosure-hint">点按展开</span>
                    </summary>
                    <div style={{ marginTop: '10px', fontSize: '14px', color: 'var(--ms-text-muted)' }}>{example.explanation}</div>
                  </details>
                ) : (
                  <div className="vocab-review-example-note" style={{ fontSize: '14px', color: 'var(--ms-text-muted)', background: 'rgba(255, 255, 255, 0.9)', borderRadius: '6px', padding: '10px 12px', border: '1px solid rgba(213, 221, 208, 0.72)' }}>
                    <strong className="vocab-review-note-label" style={{ color: 'var(--ms-text)' }}>解析:</strong> {example.explanation}
                  </div>
                )
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
    </div>
  ) : (
    <div className="vocab-review-empty vocab-review-empty-state" style={{ display: 'flex', minHeight: '100%', alignItems: 'center', justifyContent: 'center', color: '#a1a1aa' }}>
      <div className="vocab-review-empty-card" style={{ width: '100%', maxWidth: '720px', display: 'grid', gap: '14px', padding: '28px', border: '1px dashed var(--ms-border)', borderRadius: '10px', background: 'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,248,248,0.98))' }}>
        <div className="vocab-review-empty-kicker" style={{ fontSize: '12px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ms-text-faint)', fontWeight: 700 }}>
          Vocabulary Workspace
        </div>
        <div className="vocab-review-empty-title" style={{ fontSize: 'clamp(24px, 4vw, 36px)', lineHeight: 1.08, fontWeight: 760, color: 'var(--ms-text)' }}>
          {mobileSimple
            ? (
              compactDesktop
                ? (visibleEntries.length ? '从全部目录里随机抽一个单词' : '先载入全部目录词池')
                : (visibleEntries.length ? '从全部目录里随机抽一个单词' : '先载入全部目录词池')
            )
            : (visibleEntries.length ? '先从词条列表选择一个单词' : '先选目录，再开始复习')}
        </div>
        <div className="vocab-review-empty-copy" style={{ fontSize: '15px', lineHeight: '1.7', color: 'var(--ms-text-muted)' }}>
          {mobileSimple
            ? (
              compactDesktop
                ? (visibleEntries.length
                    ? '点“随机抽词”后，这里会展示释义、例句和复习记录。'
                    : '桌面极简模式默认会聚合全部目录和全部词条；如果仍为空，说明当前数据目录本身没有词条。')
                : (visibleEntries.length
                    ? '点“随机抽词”后，这里会展示释义、例句和复习记录。'
                    : '手机模式默认会聚合全部目录和全部词条；如果仍为空，说明当前数据目录本身没有词条。')
            )
            : (visibleEntries.length
                ? '选中后会在这里展示释义、例句、复习记录，并可一键跳转到精修与复习工作区。'
                : '可以先在右侧切换目录；如果目录里已有词条，也可以用筛选框快速定位。')}
        </div>
        <div className="vocab-review-empty-tips" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {selectedCategory ? <span className="vocab-review-chip" style={chipStyle()}>当前目录: {selectedCategoryLabel}</span> : null}
          <span className="vocab-review-chip" style={chipStyle()}>{entries.length ? `${entries.length} 个词条` : '还没有载入词条'}</span>
          <span className="vocab-review-chip" style={chipStyle()}>{activeFilterOption.label}: {filterCounts[entryFilter]}</span>
          {!mobileSimple && normalizedWordQuery ? <span className="vocab-review-chip" style={chipStyle()}>筛选: {wordQuery.trim()}</span> : null}
        </div>
      </div>
    </div>
  );

  if (compactDesktop) {
    return (
      <div
        className="vocab-review vocab-review-compact-desktop"
        style={{
          display: 'flex',
          gap: '18px',
          height: '100%',
          width: '100%',
          minWidth: 0,
          padding: '20px 24px',
          background: 'transparent',
          overflow: 'hidden',
        }}
      >
        <div
          className="vocab-review-sidebar"
          style={{
            width: '320px',
            minWidth: '280px',
            maxWidth: '340px',
            border: '1px solid var(--ms-border)',
            borderRadius: '10px',
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
            <select
              className="vocab-review-select"
              value={selectedCategory}
              onChange={(e) => applySelectedCategory(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', fontSize: '13px', outline: 'none', background: '#fff', color: 'var(--ms-text)' }}
            >
              {compactCategoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <span className="vocab-review-chip" style={chipStyle()}>范围: {selectedCategoryLabel}</span>
              <span className="vocab-review-chip" style={chipStyle()}>词池 {visibleEntries.length}</span>
            </div>
          </div>

          <div
            className="vocab-review-sidebar-search"
            style={{
              padding: '12px 16px',
              borderBottom: '1px solid var(--ms-border)',
              background: 'rgba(255, 255, 255, 0.96)',
              display: 'grid',
              gap: '10px',
            }}
          >
            <input
              className="vocab-review-search-input"
              type="search"
              placeholder="筛选单词或文件名"
              value={wordQuery}
              onChange={(e) => setWordQuery(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', fontSize: '13px', outline: 'none', background: '#fff', color: 'var(--ms-text)' }}
            />

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {ENTRY_FILTER_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setEntryFilter(option.value)}
                  style={{
                    padding: '6px 10px',
                    borderRadius: '999px',
                    border: '1px solid var(--ms-border)',
                    background: entryFilter === option.value ? 'var(--ms-surface-muted)' : '#fff',
                    color: 'var(--ms-text)',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {option.label} {filterCounts[option.value]}
                </button>
              ))}
            </div>
          </div>

          <div
            className="vocab-review-sidebar-meta"
            style={{
              padding: '14px 16px',
              borderBottom: '1px solid var(--ms-border)',
              background: 'rgba(255, 255, 255, 0.98)',
              display: 'grid',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
              <strong className="vocab-review-sidebar-title" style={{ fontSize: '14px', color: 'var(--ms-text)' }}>
                生词本 ({visibleEntries.length}{normalizedWordQuery ? ` / ${filteredEntries.length}` : ''})
              </strong>
              <button
                className="vocab-review-refresh-button"
                onClick={() => { void loadCategories(); void loadEntries(selectedCategory); }}
                disabled={!String(selectedCategory || '').trim()}
                style={{ background: 'none', border: 'none', cursor: String(selectedCategory || '').trim() ? 'pointer' : 'not-allowed', color: 'var(--ms-text)', fontSize: '12px', opacity: String(selectedCategory || '').trim() ? 1 : 0.4 }}
              >
                刷新
              </button>
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {detailData ? (
                <button
                  type="button"
                  onClick={() => void handleToggleMarked()}
                  disabled={savingMarked}
                  style={{
                    height: '34px',
                    padding: '0 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--ms-border)',
                    background: detailData?.marked ? 'var(--ms-surface-muted)' : '#fff',
                    color: 'var(--ms-text)',
                    fontSize: '12px',
                    fontWeight: '600',
                    whiteSpace: 'nowrap',
                    cursor: savingMarked ? 'not-allowed' : 'pointer',
                  }}
                >
                  {savingMarked ? '保存中' : (detailData?.marked ? '已标记' : '标记词条')}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => handleDrawRandomEntry()}
                disabled={!visibleEntries.length}
                className="master-primary-button"
                style={{
                  height: '34px',
                  padding: '0 12px',
                  color: '#fff',
                  borderRadius: '8px',
                  fontSize: '12px',
                  fontWeight: '600',
                  whiteSpace: 'nowrap',
                  cursor: visibleEntries.length ? 'pointer' : 'not-allowed',
                }}
              >
                {detailData ? '换一个单词' : '随机抽词'}
              </button>
            </div>
          </div>

          <ul className="vocab-review-word-list" style={{ listStyle: 'none', padding: 0, margin: 0, overflowY: 'auto', flex: 1, minHeight: 0 }}>
            {visibleEntries.map((entry) => (
              <li
                key={entry.id}
                className={`vocab-review-word-item${selectedEntryId === entry.id ? ' is-selected' : ''}`}
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
                      <span style={{ fontSize: '11px', color: 'var(--ms-text-muted)', padding: '2px 8px', borderRadius: '999px', border: '1px solid var(--ms-border)', background: '#fff', flexShrink: 0 }}>
                        已标记
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--ms-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {formatCategoryLabel(entry.category)} / {entry.file}
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
        </div>

        <div
          className="vocab-review-content"
          style={{
            flex: 1,
            minWidth: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '4px 0',
          }}
        >
          {detailNode}
        </div>
      </div>
    );
  }

  if (mobileSimple) {
    return (
      <div
        className={`vocab-review vocab-review-mobile-simple${compactDesktop ? ' is-compact-desktop' : ''}`}
        style={mobileSimpleRootStyle}
      >
        <div className={`vocab-review-mobile-toolbar${compactDesktop ? ' is-compact-desktop' : ''}`} style={mobileSimpleToolbarStyle}>
          <div style={mobileSimpleToolbarGridStyle}>
            <div style={{ display: 'grid', gap: '12px' }}>
              <select
                className="vocab-review-select"
                value={selectedCategory}
                onChange={(e) => applySelectedCategory(e.target.value)}
                style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--ms-border)', borderRadius: '8px', fontSize: '14px', outline: 'none', background: '#fff', color: 'var(--ms-text)' }}
              >
                {compactCategoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>

              {compactDesktop ? (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <span className="vocab-review-chip" style={chipStyle()}>范围: {selectedCategoryLabel}</span>
                  <span className="vocab-review-chip" style={chipStyle()}>词池 {visibleEntries.length} / {entries.length}</span>
                </div>
              ) : null}
            </div>

            <div style={{ display: 'grid', gap: '12px' }}>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {ENTRY_FILTER_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setEntryFilter(option.value)}
                    style={{
                      padding: '7px 12px',
                      borderRadius: '999px',
                      border: '1px solid var(--ms-border)',
                      background: entryFilter === option.value ? 'var(--ms-surface-muted)' : '#fff',
                      color: 'var(--ms-text)',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {option.label} {filterCounts[option.value]}
                  </button>
                ))}
              </div>

              <div
                style={{
                  display: 'grid',
                  gap: '8px',
                  alignItems: 'center',
                  gridTemplateColumns: compactDesktop ? 'minmax(0, 1fr) auto' : '1fr',
                }}
              >
                <div style={{ fontSize: '13px', color: 'var(--ms-text-muted)', minWidth: 0, whiteSpace: compactDesktop ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  当前词池: <strong style={{ color: 'var(--ms-text)' }}>{visibleEntries.length}</strong> / {entries.length}
                  {compactDesktop ? ' · 默认聚合全部目录' : ''}
                </div>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'nowrap', justifyContent: compactDesktop ? 'flex-end' : 'space-between' }}>
                  {detailData ? (
                    <button
                      type="button"
                      onClick={() => void handleToggleMarked()}
                      disabled={savingMarked}
                      style={{
                        height: '34px',
                        padding: '0 10px',
                        borderRadius: '8px',
                        border: '1px solid var(--ms-border)',
                        background: detailData?.marked ? 'var(--ms-surface-muted)' : '#fff',
                        color: 'var(--ms-text)',
                        fontSize: '12px',
                        fontWeight: '600',
                        whiteSpace: 'nowrap',
                        cursor: savingMarked ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {savingMarked ? '保存中' : (detailData?.marked ? '已标记' : '标记词条')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handleDrawRandomEntry()}
                    disabled={!visibleEntries.length}
                    className="master-primary-button"
                    style={{
                      height: '34px',
                      padding: '0 12px',
                      color: '#fff',
                      borderRadius: '8px',
                      fontSize: '12px',
                      fontWeight: '600',
                      whiteSpace: 'nowrap',
                      cursor: visibleEntries.length ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {detailData ? '换一个单词' : '随机抽词'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="vocab-review-content" style={mobileSimpleContentStyle}>
          {detailNode}
        </div>
      </div>
    );
  }

  return (
    <div className="vocab-review" style={{ display: 'flex', height: '100%', width: '100%', background: 'transparent' }}>
      <div className="vocab-review-sidebar" style={{ width: '296px', borderRight: '1px solid var(--ms-border)', background: 'rgba(255, 255, 255, 0.92)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div className="vocab-review-sidebar-header" style={{ padding: '14px 16px', borderBottom: '1px solid var(--ms-border)', background: 'rgba(255, 255, 255, 0.96)' }}>
          <select
            className="vocab-review-select"
            value={selectedCategory}
            onChange={(e) => applySelectedCategory(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', fontSize: '13px', outline: 'none', background: 'var(--ms-surface-muted)', color: 'var(--ms-text)' }}
          >
            <option value="">请选择目录</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="vocab-review-sidebar-search" style={{ padding: '12px 16px', borderBottom: '1px solid var(--ms-border)', background: 'rgba(255, 255, 255, 0.94)', display: 'grid', gap: '10px' }}>
          <input
            className="vocab-review-search-input"
            type="search"
            placeholder="筛选单词"
            value={wordQuery}
            onChange={(e) => setWordQuery(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', fontSize: '13px', outline: 'none', background: '#fff', color: 'var(--ms-text)' }}
          />

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {ENTRY_FILTER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setEntryFilter(option.value)}
                style={{
                  padding: '6px 10px',
                  borderRadius: '999px',
                  border: '1px solid var(--ms-border)',
                  background: entryFilter === option.value ? 'var(--ms-surface-muted)' : '#fff',
                  color: 'var(--ms-text)',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {option.label} {filterCounts[option.value]}
              </button>
            ))}
          </div>
        </div>

        <div className="vocab-review-sidebar-meta" style={{ padding: '16px', borderBottom: '1px solid var(--ms-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
          <strong className="vocab-review-sidebar-title" style={{ fontSize: '14px', color: 'var(--ms-text)' }}>
            生词本 ({visibleEntries.length}{normalizedWordQuery ? ` / ${filteredEntries.length}` : ''})
          </strong>
          <button className="vocab-review-refresh-button" onClick={() => { void loadCategories(); void loadEntries(selectedCategory); }} disabled={!String(selectedCategory || '').trim()} style={{ background: 'none', border: 'none', cursor: String(selectedCategory || '').trim() ? 'pointer' : 'not-allowed', color: 'var(--ms-text)', fontSize: '12px', opacity: String(selectedCategory || '').trim() ? 1 : 0.4 }}>刷新</button>
        </div>

        <ul className="vocab-review-word-list" style={{ listStyle: 'none', padding: 0, margin: 0, overflowY: 'auto', flex: 1 }}>
          {visibleEntries.map((entry) => (
            <li
              key={entry.id}
              className={`vocab-review-word-item${selectedEntryId === entry.id ? ' is-selected' : ''}`}
              onClick={() => void handleSelectEntry(entry)}
              style={{
                padding: '13px 16px',
                cursor: 'pointer',
                borderBottom: '1px solid rgba(213, 221, 208, 0.66)',
                background: selectedEntryId === entry.id ? 'var(--ms-surface-muted)' : 'transparent',
                fontSize: '14px',
                fontWeight: selectedEntryId === entry.id ? '600' : '400',
                color: 'var(--ms-text)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              <span className="vocab-review-word-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.word}</span>
              {entry.marked ? (
                <span style={{ fontSize: '11px', color: 'var(--ms-text-muted)', padding: '2px 8px', borderRadius: '999px', border: '1px solid var(--ms-border)', background: '#fff', flexShrink: 0 }}>
                  已标记
                </span>
              ) : null}
            </li>
          ))}
          {visibleEntries.length === 0 ? (
            <div className="vocab-review-empty" style={{ padding: '20px', textAlign: 'center', color: '#a1a1aa', fontSize: '13px' }}>
              {String(selectedCategory || '').trim()
                ? (normalizedWordQuery ? '没有匹配的词条' : `${activeFilterOption.label}为空`)
                : '先选择一个目录'}
            </div>
          ) : null}
        </ul>
      </div>

      <div className="vocab-review-content" style={{ flex: 1, padding: '30px 32px', overflowY: 'auto' }}>
        {detailNode}
      </div>
    </div>
  );
}
