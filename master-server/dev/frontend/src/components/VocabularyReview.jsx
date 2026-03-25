import React, { useState, useEffect, useRef } from 'react';
import { getVocabularyList, getVocabularyDetail, addVocabulary } from '../api/client';

export default function VocabularyReview() {
  const [words, setWords] = useState([]);
  const [selectedWord, setSelectedWord] = useState(null);
  const [detailData, setDetailData] = useState(null);
  
  const [generatingWordMap, setGeneratingWordMap] = useState({});
  const [generatingContextMap, setGeneratingContextMap] = useState({});

  const selectedWordRef = useRef(selectedWord);
  useEffect(() => {
    selectedWordRef.current = selectedWord;
  }, [selectedWord]);

  useEffect(() => { loadWords(); }, []);

  const loadWords = async () => {
    try {
      const data = await getVocabularyList();
      setWords(data.words || []);
    } catch (e) {
      console.error("加载单词列表失败", e);
    }
  };

  const handleSelectWord = async (word) => {
    setSelectedWord(word);
    setDetailData(null);
    try {
      const res = await getVocabularyDetail(word);
      if (res.data) setDetailData(res.data);
    } catch (e) { alert("加载详情失败"); }
  };

  const handleRegenerateDef = async () => {
    if (!detailData) return;
    const currentWord = detailData.word;
    
    setGeneratingWordMap(prev => ({ ...prev, [currentWord]: true }));
    try {
      await addVocabulary(currentWord, '', '', true, 'def');
      
      if (selectedWordRef.current === currentWord) {
        const res = await getVocabularyDetail(currentWord);
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
      await addVocabulary(currentWord, exText, exSource || '', true, 'context');
      
      if (selectedWordRef.current === currentWord) {
        const res = await getVocabularyDetail(currentWord);
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

  const playAudio = async (text, type = 2, isSequential = false) => {
    try {
      if (isSequential) {
        const wordArray = text.replace(/-/g, ' ').split(/\s+/).filter(Boolean);
        
        for (const w of wordArray) {
          await new Promise((resolve) => {
            const audio = new Audio(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(w)}&type=${type}`);
            audio.onended = resolve; 
            audio.onerror = resolve; 
            audio.play().catch((err) => {
              console.error("播放音频失败:", err);
              resolve(); 
            });
          });
        }
      } else {
        const formattedText = text.replace(/-/g, ' ');
        const audio = new Audio(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(formattedText)}&type=${type}`);
        audio.play().catch(err => console.error("播放音频失败:", err));
      }
    } catch (error) {
      console.error("音频播放流程出错:", error);
    }
  };

  const isDefRegenerating = detailData ? (generatingWordMap[detailData.word] || false) : false;

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', background: '#fff' }}>
      <div style={{ width: '280px', borderRight: '1px solid #e4e4e7', background: '#fafafa', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '16px', borderBottom: '1px solid #e4e4e7', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: '14px', color: '#09090b' }}>生词本 ({words.length})</strong>
          <button onClick={loadWords} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#3b82f6', fontSize: '12px' }}>刷新</button>
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
          {words.length === 0 && <div style={{ padding: '20px', textAlign: 'center', color: '#a1a1aa', fontSize: '13px' }}>暂无生词</div>}
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
              <span>{detailData.pronunciation || '暂无发音'}</span>
              
              <button 
                onClick={() => playAudio(detailData.word, 2, true)}
                title="逐词播放美音"
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
                
                let renderedText = ex.text;
                if (ex.focusWords && ex.focusWords.length > 0) {
                  ex.focusWords.forEach(fw => {
                    const regex = new RegExp(`(${fw})`, 'gi');
                    renderedText = renderedText.replace(regex, '<strong>$1</strong>');
                  });
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
                          onClick={() => playAudio(ex.text, 2, false)}
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