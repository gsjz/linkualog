import React, { useState, useEffect, useRef } from 'react';
import { getVocabularyList, getVocabularyDetail, addVocabulary, getVocabularyCategories } from '../api/client';

const REVIEW_CATEGORY_KEY = 'vocabReviewCategory';
const FOCUS_RENDER_TOKEN_REGEX = /\s+|[\p{L}\p{N}_]+|[^\s]/gu;

const getInitialReviewCategory = () => {
  const savedReviewCategory = localStorage.getItem(REVIEW_CATEGORY_KEY);
  if (savedReviewCategory !== null) return savedReviewCategory;
  return localStorage.getItem('defaultCategory') || '';
};

const normalizeFocusPositions = (rawFocus, tokenCount) => {
  if (!Array.isArray(rawFocus) || tokenCount <= 0) return [];
  return [...new Set(rawFocus
    .map((item) => parseInt(item, 10))
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < tokenCount))]
    .sort((a, b) => a - b);
};

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const renderTextWithFocusPositions = (text, rawFocus) => {
  const chunks = String(text || '').match(FOCUS_RENDER_TOKEN_REGEX) || [];
  const tokenCount = chunks.filter((chunk) => !/^\s+$/.test(chunk)).length;
  const focusPositions = normalizeFocusPositions(rawFocus, tokenCount);
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

export default function VocabularyReview() {
  const [words, setWords] = useState([]);
  const [selectedWord, setSelectedWord] = useState(null);
  const [detailData, setDetailData] = useState(null);
  
  const [categories, setCategories] = useState([]);
  
  const [selectedCategory, setSelectedCategory] = useState(getInitialReviewCategory);

  const [generatingWordMap, setGeneratingWordMap] = useState({});
  const [generatingContextMap, setGeneratingContextMap] = useState({});

  const selectedWordRef = useRef(selectedWord);
  useEffect(() => {
    selectedWordRef.current = selectedWord;
  }, [selectedWord]);

  useEffect(() => { 
    loadCategories(); 
    
    const handleConfigUpdate = () => {
      const savedReviewCategory = localStorage.getItem(REVIEW_CATEGORY_KEY);
      if (savedReviewCategory !== null) {
        setSelectedCategory(savedReviewCategory);
      } else {
        setSelectedCategory(localStorage.getItem('defaultCategory') || '');
      }
    };
    const handleDefaultCategoryUpdate = () => handleConfigUpdate();

    window.addEventListener('config-updated', handleConfigUpdate);
    window.addEventListener('default-category-updated', handleDefaultCategoryUpdate);
    return () => {
      window.removeEventListener('config-updated', handleConfigUpdate);
      window.removeEventListener('default-category-updated', handleDefaultCategoryUpdate);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(REVIEW_CATEGORY_KEY, selectedCategory || '');
  }, [selectedCategory]);

  useEffect(() => {
    loadWords(selectedCategory);
    setSelectedWord(null);
    setDetailData(null);
  }, [selectedCategory]);

  const loadCategories = async () => {
    try {
      const data = await getVocabularyCategories();
      if(data.categories) setCategories(data.categories);
    } catch (e) {
      console.error("加载目录失败", e);
    }
  };

  const loadWords = async (categoryStr) => {
    try {
      const data = await getVocabularyList(categoryStr);
      setWords(data.words || []);
    } catch (e) {
      console.error("加载单词列表失败", e);
    }
  };

  const handleSelectWord = async (word) => {
    setSelectedWord(word);
    setDetailData(null);
    try {
      const res = await getVocabularyDetail(word, selectedCategory);
      if (res.data) setDetailData(res.data);
    } catch { alert("加载详情失败"); }
  };

  const handleRegenerateDef = async () => {
    if (!detailData) return;
    const currentWord = detailData.word;
    
    setGeneratingWordMap(prev => ({ ...prev, [currentWord]: true }));
    try {
      await addVocabulary(currentWord, '', '', true, 'def', selectedCategory);
      
      if (selectedWordRef.current === currentWord) {
        const res = await getVocabularyDetail(currentWord, selectedCategory);
        if (res.data) {
          setDetailData(prev => (prev && prev.word === currentWord) ? res.data : prev);
        }
      }
    } catch (e) {
      alert("请求 LLM 基础释义失败: " + e.message);
    } finally {
      setGeneratingWordMap(prev => ({ ...prev, [currentWord]: false }));
    }
  };

  const handleRegenerateContext = async (exText, exSource) => {
    if (!detailData) return;
    const currentWord = detailData.word;
    const ctxKey = `${currentWord}-${exText}`; 
    
    setGeneratingContextMap(prev => ({ ...prev, [ctxKey]: true }));
    try {
      await addVocabulary(currentWord, exText, exSource || '', true, 'context', selectedCategory);
      
      if (selectedWordRef.current === currentWord) {
        const res = await getVocabularyDetail(currentWord, selectedCategory);
        if (res.data) {
          setDetailData(prev => (prev && prev.word === currentWord) ? res.data : prev);
        }
      }
    } catch (e) {
      alert("请求例句解析失败: " + e.message);
    } finally {
      setGeneratingContextMap(prev => ({ ...prev, [ctxKey]: false }));
    }
  };

  const playAudio = (text, type = 2) => {
    if (!('speechSynthesis' in window)) {
      alert("您的浏览器不支持语音朗读功能");
      return;
    }

    try {
      window.speechSynthesis.cancel();
      const formattedText = text.replace(/-/g, ' ');
      const utterance = new SpeechSynthesisUtterance(formattedText);
      utterance.lang = type === 2 ? 'en-US' : 'en-GB';
      utterance.rate = 0.9; 
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      console.error("本地语音播放失败:", error);
    }
  };

  const isDefRegenerating = detailData ? (generatingWordMap[detailData.word] || false) : false;

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', background: '#fff' }}>
      <div style={{ width: '280px', borderRight: '1px solid #e4e4e7', background: '#fafafa', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #e4e4e7', background: '#fff' }}>
          <select 
            value={selectedCategory} 
            onChange={e => setSelectedCategory(e.target.value)}
            style={{ width: '100%', padding: '6px', border: '1px solid #e4e4e7', borderRadius: '4px', fontSize: '13px', outline: 'none' }}
          >
            <option value="">根目录 (默认)</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div style={{ padding: '16px', borderBottom: '1px solid #e4e4e7', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: '14px', color: '#09090b' }}>生词本 ({words.length})</strong>
          <button onClick={() => { loadCategories(); loadWords(selectedCategory); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#3b82f6', fontSize: '12px' }}>刷新</button>
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, overflowY: 'auto', flex: 1 }}>
          {words.map(w => (
            <li 
              key={w}
              onClick={() => handleSelectWord(w)}
              style={{
                padding: '12px 16px', cursor: 'pointer', borderBottom: '1px solid #e4e4e7',
                background: selectedWord === w ? '#e4e4e7' : 'transparent',
                fontSize: '14px', fontWeight: selectedWord === w ? '600' : '400', color: '#09090b',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center'
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w}</span>
              {(generatingWordMap[w] || Object.keys(generatingContextMap).some(k => k.startsWith(w+'-') && generatingContextMap[k])) && (
                <span style={{ fontSize: '12px', color: '#3b82f6', flexShrink: 0 }}>更新中...</span>
              )}
            </li>
          ))}
          {words.length === 0 && <div style={{ padding: '20px', textAlign: 'center', color: '#a1a1aa', fontSize: '13px' }}>该目录下暂无生词</div>}
        </ul>
      </div>

      <div style={{ flex: 1, padding: '32px', overflowY: 'auto' }}>
        {detailData ? (
          <div style={{ maxWidth: '800px' }}>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '8px', flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: '32px', margin: 0, color: '#09090b' }}>{detailData.word}</h1>
              <button 
                onClick={handleRegenerateDef}
                disabled={isDefRegenerating}
                style={{
                  padding: '6px 12px', background: isDefRegenerating ? '#e4e4e7' : '#10b981',
                  color: isDefRegenerating ? '#a1a1aa' : '#fff', border: 'none', borderRadius: '6px',
                  fontSize: '13px', fontWeight: '500', cursor: isDefRegenerating ? 'not-allowed' : 'pointer',
                  transition: 'background 0.2s', display: 'flex', alignItems: 'center', gap: '4px'
                }}
              >
                {isDefRegenerating ? '获取中...' : '获取基础释义'}
              </button>
            </div>
            
            <div style={{ fontSize: '18px', color: '#71717a', marginBottom: '24px', fontFamily: 'serif', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button 
                onClick={() => playAudio(detailData.word, 2)}
                title="播放发音"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', 
                  fontSize: '18px', padding: '0 4px', display: 'flex', alignItems: 'center',
                  transition: 'transform 0.1s'
                }}
                onMouseDown={e => e.currentTarget.style.transform = 'scale(0.9)'}
                onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
              >
                🔊
              </button>

              {detailData.reviews && detailData.reviews.length > 0 && (
                <span style={{ fontSize: '12px', color: '#a1a1aa', marginLeft: '16px', background: '#f4f4f5', padding: '2px 8px', borderRadius: '12px' }}>
                  已复习 {detailData.reviews.length} 次
                </span>
              )}
            </div>

            <h3 style={{ borderBottom: '2px solid #e4e4e7', paddingBottom: '8px', marginTop: '32px' }}>释义</h3>
            <ul style={{ paddingLeft: '20px', fontSize: '15px', lineHeight: '1.8' }}>
              {detailData.definitions && detailData.definitions.length > 0 ? (
                detailData.definitions.map((def, idx) => (
                  <li key={idx} style={{ marginBottom: '8px' }}>{def}</li>
                ))
              ) : (
                <li style={{ color: '#a1a1aa', listStyle: 'none', marginLeft: '-20px' }}>暂无释义</li>
              )}
            </ul>

            <h3 style={{ borderBottom: '2px solid #e4e4e7', paddingBottom: '8px', marginTop: '32px' }}>例句</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {detailData.examples && detailData.examples.map((ex, idx) => {
                const isCtxRegenerating = generatingContextMap[`${detailData.word}-${ex.text}`] || false;
                
                const rawFocus = Array.isArray(ex.focusPositions)
                  ? ex.focusPositions
                  : Array.isArray(ex.focusPosition)
                    ? ex.focusPosition
                    : Array.isArray(ex.fp)
                      ? ex.fp
                      : (Array.isArray(ex.fps) ? ex.fps : []);

                let renderedText = renderTextWithFocusPositions(ex.text, rawFocus);
                if (!renderedText) {
                  renderedText = ex.text;
                  if (ex.focusWords && ex.focusWords.length > 0) {
                    ex.focusWords.forEach(fw => {
                      const regex = new RegExp(`(${fw})`, 'gi');
                      renderedText = renderedText.replace(regex, '<strong>$1</strong>');
                    });
                  }
                }
                
                return (
                  <div key={idx} style={{ background: '#f4f4f5', padding: '16px', borderRadius: '8px', borderLeft: '4px solid #3b82f6' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
                      
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px', flex: 1 }}>
                        <div 
                          style={{ fontSize: '16px', color: '#09090b', flex: 1 }}
                          dangerouslySetInnerHTML={{ __html: renderedText }}
                        />
                        <button 
                          onClick={() => playAudio(ex.text, 2)}
                          title="朗读完整例句"
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer', 
                            fontSize: '16px', padding: '0 4px', flexShrink: 0,
                            transition: 'transform 0.1s'
                          }}
                          onMouseDown={e => e.currentTarget.style.transform = 'scale(0.9)'}
                          onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
                        >
                          🔊
                        </button>
                      </div>

                      <button 
                        onClick={() => handleRegenerateContext(ex.text, ex.source?.text)}
                        disabled={isCtxRegenerating}
                        style={{ 
                          padding: '4px 10px', fontSize: '12px', borderRadius: '4px', border: 'none', flexShrink: 0,
                          background: isCtxRegenerating ? '#e4e4e7' : '#3b82f6', 
                          color: isCtxRegenerating ? '#a1a1aa' : '#fff', cursor: isCtxRegenerating ? 'not-allowed' : 'pointer'
                        }}
                      >
                        {isCtxRegenerating ? '解析中...' : '解析此例句'}
                      </button>
                    </div>

                    {ex.explanation && <div style={{ fontSize: '14px', color: '#52525b', marginBottom: '8px' }}>翻译: {ex.explanation}</div>}
                    
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
                      {ex.source && ex.source.text && (
                        <a href={ex.source.url || '#'} target="_blank" rel="noreferrer" style={{ 
                          fontSize: '12px', color: '#71717a', textDecoration: 'none',
                          display: 'inline-flex', alignItems: 'center', gap: '4px',
                          background: '#e4e4e7', padding: '2px 8px', borderRadius: '12px'
                        }}>
                          🏷️ {ex.source.text}
                        </a>
                      )}
                      
                      {ex.youtube && ex.youtube.url && (
                        <a href={`${ex.youtube.url}&t=${ex.youtube.timestamp || 0}s`} target="_blank" rel="noreferrer" style={{ 
                          fontSize: '12px', color: '#ef4444', textDecoration: 'none',
                          display: 'inline-flex', alignItems: 'center', gap: '4px',
                          background: '#fee2e2', padding: '2px 8px', borderRadius: '12px'
                        }}>
                          ▶ YouTube
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            
            <div style={{ marginTop: '48px', fontSize: '12px', color: '#a1a1aa' }}>
              首次记录时间: {detailData.createdAt}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#a1a1aa' }}>
            在左侧选择一个单词查看，或前往数据解析控制台快捷制卡。
          </div>
        )}
      </div>
    </div>
  );
}
