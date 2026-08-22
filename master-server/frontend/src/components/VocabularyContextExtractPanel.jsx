import React, { useCallback, useState } from 'react';
import { extractVocabularyCandidates } from '../api/client';

export default function VocabularyContextExtractPanel({
  className = '',
  onUseCandidate = null,
  onEnqueueCandidate = null,
  useLabel = '录入',
  enqueueLabel = '加入队列',
} = {}) {
  const [extractText, setExtractText] = useState('');
  const [extractPrompt, setExtractPrompt] = useState('');
  const [extractCandidates, setExtractCandidates] = useState([]);
  const [extractNotes, setExtractNotes] = useState([]);
  const [extractLoading, setExtractLoading] = useState(false);
  const [extractError, setExtractError] = useState('');
  const [extractNotice, setExtractNotice] = useState('');

  const handleExtractCandidates = useCallback(async ({ append = false } = {}) => {
    const text = String(extractText || '').trim();
    if (!text) {
      setExtractError('先粘贴输入内容。');
      setExtractNotice('');
      return;
    }
    setExtractLoading(true);
    setExtractError('');
    setExtractNotice('');
    try {
      const previousCandidates = append ? extractCandidates : [];
      const res = await extractVocabularyCandidates(text, {
        prompt: extractPrompt,
        previousCandidates,
        limit: 8,
      });
      const candidates = Array.isArray(res?.candidates) ? res.candidates : [];
      setExtractCandidates((current) => {
        const base = append ? current : [];
        const seen = new Set(base.map((item) => `${String(item.word || '').toLowerCase()}\u0001${String(item.context || '').toLowerCase()}`));
        const merged = [...base];
        candidates.forEach((candidate) => {
          const key = `${String(candidate.word || '').toLowerCase()}\u0001${String(candidate.context || '').toLowerCase()}`;
          if (seen.has(key)) return;
          seen.add(key);
          merged.push(candidate);
        });
        return merged;
      });
      setExtractNotes(Array.isArray(res?.notes) ? res.notes : []);
      if (!candidates.length) {
        setExtractError('没有拿到新候选。');
      }
    } catch (error) {
      setExtractError(error?.message || '提取候选失败');
    } finally {
      setExtractLoading(false);
    }
  }, [extractCandidates, extractPrompt, extractText]);

  const runCandidateAction = useCallback((handler, candidate, successText) => {
    if (typeof handler !== 'function') return;
    const result = handler(candidate);
    if (result === false) {
      setExtractError('先选择目标目录。');
      setExtractNotice('');
      return;
    }
    if (typeof result === 'string') {
      setExtractError(result);
      setExtractNotice('');
      return;
    }
    setExtractError('');
    setExtractNotice(successText);
  }, []);

  return (
    <div className={`queue-extract-panel${className ? ` ${className}` : ''}`}>
      <div className="queue-field">
        <label className="queue-field-label">混乱输入</label>
        <textarea
          className="queue-field-input queue-field-textarea"
          value={extractText}
          onChange={(e) => setExtractText(e.target.value)}
          placeholder="粘贴和 LLM 聊天记录、论文讨论或笔记"
        />
      </div>
      <div className="queue-field">
        <label className="queue-field-label">继续提示</label>
        <input
          className="queue-field-input"
          value={extractPrompt}
          onChange={(e) => setExtractPrompt(e.target.value)}
          placeholder="例如: 更偏学术词、少给基础词"
        />
      </div>
      <div className="queue-extract-actions">
        <button type="button" className="master-primary-button" onClick={() => void handleExtractCandidates({ append: false })} disabled={extractLoading || !String(extractText || '').trim()}>
          {extractLoading ? '提取中...' : '提取候选'}
        </button>
        <button type="button" className="master-secondary-button" onClick={() => void handleExtractCandidates({ append: true })} disabled={extractLoading || !String(extractText || '').trim() || !extractCandidates.length}>
          继续候选
        </button>
      </div>
      {extractError ? (
        <div className="queue-task-error">{extractError}</div>
      ) : null}
      {extractNotice ? (
        <div className="queue-extract-notes is-success">{extractNotice}</div>
      ) : null}
      {extractNotes.length ? (
        <div className="queue-extract-notes">
          {extractNotes.slice(0, 2).join('；')}
        </div>
      ) : null}
      <div className="queue-extract-candidates">
        {extractCandidates.length ? extractCandidates.map((candidate, index) => (
          <div key={`${candidate.word}-${index}`} className="queue-extract-card">
            <div className="queue-extract-card-head">
              <strong className="queue-extract-word">{candidate.word}</strong>
              <span className="queue-extract-confidence">{Math.round((Number(candidate.confidence) || 0) * 100)}%</span>
            </div>
            {candidate.definition_hint ? <div className="queue-extract-definition">{candidate.definition_hint}</div> : null}
            {candidate.context ? <div className="queue-extract-context">{candidate.context}</div> : null}
            {candidate.reason ? <div className="queue-extract-reason">{candidate.reason}</div> : null}
            <div className="queue-extract-card-actions">
              <button type="button" className="master-secondary-button" onClick={() => runCandidateAction(onUseCandidate, candidate, '已填入录入表单')}>
                {useLabel}
              </button>
              <button type="button" className="master-primary-button" onClick={() => runCandidateAction(onEnqueueCandidate, candidate, '已加入队列')}>
                {enqueueLabel}
              </button>
            </div>
          </div>
        )) : (
          <div className="queue-empty">暂无候选</div>
        )}
      </div>
    </div>
  );
}
