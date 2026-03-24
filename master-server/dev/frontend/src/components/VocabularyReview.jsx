import React, { useState, useEffect } from 'react';
import { getVocabularyList, getVocabularyDetail, addVocabulary } from '../api/client';

export default function VocabularyReview() {
  const [words, setWords] = useState([]);
  const [selectedWord, setSelectedWord] = useState(null);
  const [detailData, setDetailData] = useState(null);
  
  const [generatingMap, setGeneratingMap] = useState({});

  useEffect(() => {
    loadWords();
  }, []);

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
    } catch (e) {
      alert("加载详情失败");
    }
  };

  const handleRegenerateLlm = async () => {
    if (!detailData) return;
    const currentWord = detailData.word;
    
    setGeneratingMap(prev => ({ ...prev, [currentWord]: true }));
    try {
      const context = detailData.examples && detailData.examples.length > 0 ? detailData.examples[0].text : '';
      const source = detailData.examples && detailData.examples.length > 0 ? (detailData.examples[0].source?.text || '') : '';
      
      await addVocabulary(currentWord, context, source, true);
      
      if (selectedWord === currentWord) {
        const res = await getVocabularyDetail(currentWord);
        if (res.data) setDetailData(res.data);
      }
    } catch (e) {
      alert("请求 LLM 失败: " + e.message);
    } finally {
      setGeneratingMap(prev => ({ ...prev, [currentWord]: false }));
    }
  };

  const isCurrentRegenerating = detailData ? (generatingMap[detailData.word] || false) : false;

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', background: '#fff' }}>
      <div style={{ width: '280px', borderRight: '1px solid #e4e4e7', background: '#fafafa', display: 'flex', flexDirection: 'column' }}>
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
              {generatingMap[w] && <span style={{ fontSize: '12px', color: '#3b82f6', flexShrink: 0 }}>更新中...</span>}
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
                onClick={handleRegenerateLlm}
                disabled={isCurrentRegenerating}
                style={{
                  padding: '6px 12px', background: isCurrentRegenerating ? '#e4e4e7' : '#10b981',
                  color: isCurrentRegenerating ? '#a1a1aa' : '#fff', border: 'none', borderRadius: '6px',
                  fontSize: '13px', fontWeight: '500', cursor: isCurrentRegenerating ? 'not-allowed' : 'pointer',
                  transition: 'background 0.2s', display: 'flex', alignItems: 'center', gap: '4px'
                }}
              >
                {isCurrentRegenerating ? '🧠 生成中...' : '🧠 请求/更新 LLM 释义'}
              </button>
            </div>
            
            <div style={{ fontSize: '18px', color: '#71717a', marginBottom: '24px', fontFamily: 'serif' }}>{detailData.pronunciation || '暂无发音'}</div>

            <h3 style={{ borderBottom: '2px solid #e4e4e7', paddingBottom: '8px', marginTop: '32px' }}>📖 释义</h3>
            <ul style={{ paddingLeft: '20px', fontSize: '15px', lineHeight: '1.8' }}>
              {detailData.definitions && detailData.definitions.length > 0 ? (
                detailData.definitions.map((def, idx) => (
                  <li key={idx} style={{ marginBottom: '8px' }}>{def}</li>
                ))
              ) : (
                <li style={{ color: '#a1a1aa', listStyle: 'none', marginLeft: '-20px' }}>暂无释义 (请点击上方按钮请求 LLM 补全)</li>
              )}
            </ul>

            <h3 style={{ borderBottom: '2px solid #e4e4e7', paddingBottom: '8px', marginTop: '32px' }}>📝 上下文例句</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {detailData.examples && detailData.examples.map((ex, idx) => (
                <div key={idx} style={{ background: '#f4f4f5', padding: '16px', borderRadius: '8px', borderLeft: '4px solid #3b82f6' }}>
                  <div style={{ fontSize: '16px', fontWeight: '500', color: '#09090b', marginBottom: '8px' }}>{ex.text}</div>
                  {ex.explanation && <div style={{ fontSize: '14px', color: '#52525b', marginBottom: '8px' }}>释义: {ex.explanation}</div>}
                  
                  {ex.source && ex.source.text && (
                    <div style={{ 
                      fontSize: '12px', color: '#a1a1aa', marginTop: '12px', 
                      display: 'inline-flex', alignItems: 'center', gap: '6px',
                      background: '#e4e4e7', padding: '2px 8px', borderRadius: '12px'
                    }}>
                      <span>🏷️</span>
                      <span>{ex.source.text}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
            
            <div style={{ marginTop: '48px', fontSize: '12px', color: '#a1a1aa' }}>
              首次记录时间: {detailData.createdAt}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#a1a1aa' }}>
            👈 在左侧选择一个单词查看，或前往数据解析控制台快捷制卡。
          </div>
        )}
      </div>
    </div>
  );
}