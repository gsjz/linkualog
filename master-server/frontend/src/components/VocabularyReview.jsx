import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  getVocabularyCategories,
  getVocabularyDetail,
  getVocabularyList,
} from '../api/client';

const REVIEW_CATEGORY_KEY = 'vocabReviewCategory';
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

const getInitialReviewCategory = () => {
  const savedReviewCategory = localStorage.getItem(REVIEW_CATEGORY_KEY);
  if (savedReviewCategory !== null) return String(savedReviewCategory || '').trim();
  return String(localStorage.getItem('defaultCategory') || '').trim();
};

const normalizeVocabularyLaunchWord = (value) => String(value || '')
  .trim()
  .replace(/\.json$/i, '');

const buildVocabularyWordKey = (value) => normalizeVocabularyLaunchWord(value)
  .toLowerCase()
  .replace(/[\s_]+/g, '-');

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

export default function VocabularyReview({ onOpenReviewEntry = null, launchRequest = null }) {
  const [words, setWords] = useState([]);
  const [selectedWord, setSelectedWord] = useState(null);
  const [detailData, setDetailData] = useState(null);
  const [categories, setCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(getInitialReviewCategory);
  const [wordQuery, setWordQuery] = useState('');
  const pendingLaunchRef = useRef(null);

  const loadCategories = useCallback(async () => {
    try {
      const data = await getVocabularyCategories();
      if (data.categories) setCategories(data.categories);
    } catch (e) {
      console.error('加载目录失败', e);
    }
  }, []);

  const loadWords = useCallback(async (categoryStr) => {
    if (!String(categoryStr || '').trim()) {
      setWords([]);
      return;
    }

    try {
      const data = await getVocabularyList(categoryStr);
      setWords(data.words || []);
    } catch (e) {
      console.error('加载单词列表失败', e);
    }
  }, []);

  const handleSelectWord = useCallback(async (word, categoryOverride = selectedCategory) => {
    setSelectedWord(word);
    setDetailData(null);
    try {
      const res = await getVocabularyDetail(word, categoryOverride);
      if (res.data) setDetailData(res.data);
    } catch {
      alert('加载详情失败');
    }
  }, [selectedCategory]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadCategories();
    });

    const handleConfigUpdate = () => {
      const savedReviewCategory = localStorage.getItem(REVIEW_CATEGORY_KEY);
      if (savedReviewCategory !== null) {
        setSelectedCategory(String(savedReviewCategory || '').trim());
      } else {
        setSelectedCategory(String(localStorage.getItem('defaultCategory') || '').trim());
      }
    };

    window.addEventListener('config-updated', handleConfigUpdate);
    window.addEventListener('default-category-updated', handleConfigUpdate);

    return () => {
      window.removeEventListener('config-updated', handleConfigUpdate);
      window.removeEventListener('default-category-updated', handleConfigUpdate);
    };
  }, [loadCategories]);

  useEffect(() => {
    localStorage.setItem(REVIEW_CATEGORY_KEY, selectedCategory || '');
  }, [selectedCategory]);

  useEffect(() => {
    if (!String(selectedCategory || '').trim()) {
      queueMicrotask(() => {
        setWords([]);
        setSelectedWord(null);
        setDetailData(null);
        setWordQuery('');
      });
      return;
    }
    queueMicrotask(() => {
      void loadWords(selectedCategory);
      setSelectedWord(null);
      setDetailData(null);
      setWordQuery('');
    });
  }, [loadWords, selectedCategory]);

  useEffect(() => {
    if (!launchRequest?.word) return;

    const targetCategory = String(launchRequest.category || '').trim();
    const targetWord = normalizeVocabularyLaunchWord(launchRequest.word);
    const targetFileKey = normalizeVocabularyLaunchWord(launchRequest.fileKey || launchRequest.word);
    if (!targetWord) return;

    pendingLaunchRef.current = {
      category: targetCategory,
      word: targetWord,
      fileKey: targetFileKey,
    };

    if (targetCategory !== selectedCategory) {
      queueMicrotask(() => {
        setSelectedCategory(targetCategory);
      });
      return;
    }

    const matchedWord = words.find((item) => buildVocabularyWordKey(item) === buildVocabularyWordKey(targetFileKey))
      || words.find((item) => buildVocabularyWordKey(item) === buildVocabularyWordKey(targetWord))
      || targetFileKey
      || targetWord;
    pendingLaunchRef.current = null;
    queueMicrotask(() => {
      void handleSelectWord(matchedWord, targetCategory);
    });
  }, [handleSelectWord, launchRequest, selectedCategory, words]);

  useEffect(() => {
    const pendingLaunch = pendingLaunchRef.current;
    if (!pendingLaunch) return;
    if (pendingLaunch.category !== selectedCategory) return;

    const matchedWord = words.find((item) => buildVocabularyWordKey(item) === buildVocabularyWordKey(pendingLaunch.fileKey || pendingLaunch.word))
      || words.find((item) => buildVocabularyWordKey(item) === buildVocabularyWordKey(pendingLaunch.word))
      || pendingLaunch.fileKey
      || pendingLaunch.word;
    pendingLaunchRef.current = null;
    queueMicrotask(() => {
      void handleSelectWord(matchedWord, pendingLaunch.category);
    });
  }, [handleSelectWord, selectedCategory, words]);

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

  const handleOpenReviewWorkspace = () => {
    if (!detailData?.word || typeof onOpenReviewEntry !== 'function') return;
    onOpenReviewEntry({
      category: selectedCategory,
      word: detailData.word,
      focus: 'clean',
    });
  };
  const reviews = Array.isArray(detailData?.reviews) ? detailData.reviews : [];
  const definitions = Array.isArray(detailData?.definitions) ? detailData.definitions : [];
  const examples = Array.isArray(detailData?.examples) ? detailData.examples : [];
  const normalizedWordQuery = String(wordQuery || '').trim().toLowerCase();
  const visibleWords = normalizedWordQuery
    ? words.filter((word) => String(word || '').toLowerCase().includes(normalizedWordQuery))
    : words;
  const mergedFrom = Array.isArray(detailData?.mergedFrom)
    ? detailData.mergedFrom.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const rawTags = Array.isArray(detailData?.tags)
    ? detailData.tags.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const categoryTag = selectedCategory ? formatCategoryLabel(selectedCategory) : '';
  const displayTags = [...new Set([...rawTags, ...[categoryTag].filter(Boolean)])];
  const latestReview = reviews.length ? reviews[reviews.length - 1] : null;
  const latestReviewTone = latestReview ? getReviewToneStyle(latestReview.score) : null;

  return (
    <div className="vocab-review" style={{ display: 'flex', height: '100%', width: '100%', background: 'transparent' }}>
      <div className="vocab-review-sidebar" style={{ width: '296px', borderRight: '1px solid var(--ms-border)', background: 'rgba(255, 255, 255, 0.92)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div className="vocab-review-sidebar-header" style={{ padding: '14px 16px', borderBottom: '1px solid var(--ms-border)', background: 'rgba(255, 255, 255, 0.96)' }}>
          <select
            className="vocab-review-select"
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', fontSize: '13px', outline: 'none', background: 'var(--ms-surface-muted)', color: 'var(--ms-text)' }}
          >
            <option value="">请选择目录</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="vocab-review-sidebar-search" style={{ padding: '12px 16px', borderBottom: '1px solid var(--ms-border)', background: 'rgba(255, 255, 255, 0.94)' }}>
          <input
            className="vocab-review-search-input"
            type="search"
            placeholder="筛选单词"
            value={wordQuery}
            onChange={(e) => setWordQuery(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--ms-border)', borderRadius: '6px', fontSize: '13px', outline: 'none', background: '#fff', color: 'var(--ms-text)' }}
          />
        </div>

        <div className="vocab-review-sidebar-meta" style={{ padding: '16px', borderBottom: '1px solid var(--ms-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
          <strong className="vocab-review-sidebar-title" style={{ fontSize: '14px', color: 'var(--ms-text)' }}>
            生词本 ({visibleWords.length}{normalizedWordQuery ? ` / ${words.length}` : ''})
          </strong>
          <button className="vocab-review-refresh-button" onClick={() => { loadCategories(); loadWords(selectedCategory); }} disabled={!String(selectedCategory || '').trim()} style={{ background: 'none', border: 'none', cursor: String(selectedCategory || '').trim() ? 'pointer' : 'not-allowed', color: 'var(--ms-text)', fontSize: '12px', opacity: String(selectedCategory || '').trim() ? 1 : 0.4 }}>刷新</button>
        </div>

        <ul className="vocab-review-word-list" style={{ listStyle: 'none', padding: 0, margin: 0, overflowY: 'auto', flex: 1 }}>
          {visibleWords.map((word) => (
            <li
              key={word}
              className={`vocab-review-word-item${selectedWord === word ? ' is-selected' : ''}`}
              onClick={() => handleSelectWord(word)}
              style={{
                padding: '13px 16px',
                cursor: 'pointer',
                borderBottom: '1px solid rgba(213, 221, 208, 0.66)',
                background: selectedWord === word ? 'var(--ms-surface-muted)' : 'transparent',
                fontSize: '14px',
                fontWeight: selectedWord === word ? '600' : '400',
                color: 'var(--ms-text)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span className="vocab-review-word-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{word}</span>
            </li>
          ))}
          {visibleWords.length === 0 ? (
            <div className="vocab-review-empty" style={{ padding: '20px', textAlign: 'center', color: '#a1a1aa', fontSize: '13px' }}>
              {String(selectedCategory || '').trim()
                ? (normalizedWordQuery ? '没有匹配的词条' : '该目录下暂无生词')
                : '先选择一个目录'}
            </div>
          ) : null}
        </ul>
      </div>

      <div className="vocab-review-content" style={{ flex: 1, padding: '30px 32px', overflowY: 'auto' }}>
        {detailData ? (
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
                  <span className="vocab-review-chip" style={chipStyle()}>目录: {formatCategoryLabel(selectedCategory)}</span>
                  <span className="vocab-review-chip" style={chipStyle()}>释义 {definitions.length}</span>
                  <span className="vocab-review-chip" style={chipStyle()}>例句 {examples.length}</span>
                  <span className="vocab-review-chip" style={chipStyle()}>复习 {reviews.length}</span>
                  {latestReview ? <span className="vocab-review-chip vocab-review-chip-tone" style={{ ...chipStyle(), ...latestReviewTone }}>最近熟练度 {normalizeReviewScore(latestReview.score)}/5</span> : null}
                </div>
              </div>

              <div className="vocab-review-hero-actions" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                {typeof onOpenReviewEntry === 'function' ? (
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
                      <div className="vocab-review-example-note" style={{ fontSize: '14px', color: 'var(--ms-text-muted)', background: 'rgba(255, 255, 255, 0.9)', borderRadius: '6px', padding: '10px 12px', border: '1px solid rgba(213, 221, 208, 0.72)' }}>
                        <strong className="vocab-review-note-label" style={{ color: 'var(--ms-text)' }}>解析:</strong> {example.explanation}
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
                {visibleWords.length ? '先从词条列表选择一个单词' : '先选目录，再开始复习'}
              </div>
              <div className="vocab-review-empty-copy" style={{ fontSize: '15px', lineHeight: 1.7, color: 'var(--ms-text-muted)' }}>
                {visibleWords.length
                  ? '选中后会在这里展示释义、例句、复习记录，并可一键跳转到精修与复习工作区。'
                  : '可以先在右侧切换目录；如果目录里已有词条，也可以用筛选框快速定位。'}
              </div>
              <div className="vocab-review-empty-tips" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {selectedCategory ? <span className="vocab-review-chip" style={chipStyle()}>当前目录: {formatCategoryLabel(selectedCategory)}</span> : null}
                <span className="vocab-review-chip" style={chipStyle()}>{words.length ? `${words.length} 个词条待查看` : '还没有载入词条'}</span>
                {normalizedWordQuery ? <span className="vocab-review-chip" style={chipStyle()}>筛选: {wordQuery.trim()}</span> : null}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
