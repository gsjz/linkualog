import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArticleParagraph, collectArticleParagraphs, removeArticleTranslationHosts } from '../services/articleTranslator';
import { fetchLlmStream } from '../services/llmApi';
import { ConfigService } from '../services/configService';

interface ArticleTranslatorProps {
  onOpenSettings: () => void;
}

type TranslationStatus = 'idle' | 'loading' | 'done' | 'error';
interface TranslationState {
  text: string;
  status: TranslationStatus;
  error?: string;
}

const LINKUAL_NAVIGATION_EVENT = 'linkual_navigation';

function TranslationBlock({
  paragraph,
  state,
  onTranslate,
}: {
  paragraph: ArticleParagraph;
  state?: TranslationState;
  onTranslate: (paragraph: ArticleParagraph) => void;
}) {
  const isLoading = state?.status === 'loading';
  const hasTranslation = Boolean(state?.text);

  return (
    <div className={`linkual-article-translation ${state?.status || 'idle'}`}>
      <div className="linkual-article-translation-toolbar">
        <span className="linkual-article-translation-label">Linkual · 网页翻译</span>
        <button type="button" onClick={() => onTranslate(paragraph)} disabled={isLoading}>
          {isLoading ? '翻译中…' : hasTranslation ? '重新翻译' : '翻译本段'}
        </button>
      </div>
      {hasTranslation ? (
        <div className="linkual-article-translation-text">{state?.text}</div>
      ) : (
        <div className="linkual-article-translation-placeholder">
          {state?.error || (isLoading ? '正在请求模型…' : '点击“翻译本段”显示译文')}
        </div>
      )}
    </div>
  );
}

const ArticleTranslator: React.FC<ArticleTranslatorProps> = ({ onOpenSettings }) => {
  const [paragraphs, setParagraphs] = useState<ArticleParagraph[]>([]);
  const [pageUrl, setPageUrl] = useState(window.location.href);
  const [translations, setTranslations] = useState<Record<string, TranslationState>>({});
  const [isTranslatingAll, setIsTranslatingAll] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const abortsRef = useRef(new Map<string, () => void>());
  const allRunIdRef = useRef(0);

  const syncParagraphs = useCallback(() => {
    const nextParagraphs = collectArticleParagraphs();
    const nextUrl = window.location.href;
    const nextHosts = new Set(nextParagraphs.map((paragraph) => paragraph.host));
    removeArticleTranslationHosts(nextHosts);

    setParagraphs((previous) => {
      const unchanged = previous.length === nextParagraphs.length && previous.every((paragraph, index) => (
        paragraph.element === nextParagraphs[index]?.element && paragraph.text === nextParagraphs[index]?.text
      ));
      return unchanged ? previous : nextParagraphs;
    });

    setPageUrl((previous) => {
      if (previous === nextUrl) return previous;
      allRunIdRef.current += 1;
      abortsRef.current.forEach((abort) => abort());
      abortsRef.current.clear();
      setTranslations({});
      setIsTranslatingAll(false);
      return nextUrl;
    });
  }, []);

  useEffect(() => {
    syncParagraphs();
    const interval = window.setInterval(syncParagraphs, 1200);
    window.addEventListener(LINKUAL_NAVIGATION_EVENT, syncParagraphs);
    window.addEventListener('popstate', syncParagraphs);
    window.addEventListener('hashchange', syncParagraphs);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener(LINKUAL_NAVIGATION_EVENT, syncParagraphs);
      window.removeEventListener('popstate', syncParagraphs);
      window.removeEventListener('hashchange', syncParagraphs);
      abortsRef.current.forEach((abort) => abort());
      abortsRef.current.clear();
      removeArticleTranslationHosts();
    };
  }, [syncParagraphs]);

  const translateParagraph = useCallback((paragraph: ArticleParagraph) => {
    const apiKey = ConfigService.get('api_key').trim();
    const apiUrl = ConfigService.get('api_url').trim();
    const apiModel = ConfigService.get('api_model').trim();
    const timeout = parseInt(ConfigService.get('api_timeout') as string, 10) || 30;
    const targetLanguage = ConfigService.get('web_target_language').trim() || '简体中文';
    const promptTemplate = ConfigService.get('web_translation_prompt').trim();

    if (!apiKey) {
      setTranslations((previous) => ({
        ...previous,
        [paragraph.id]: { status: 'error', text: '', error: '请先在设置中填入 API Key' },
      }));
      return Promise.resolve(false);
    }

    const previousAbort = abortsRef.current.get(paragraph.id);
    previousAbort?.();
    setTranslations((previous) => ({
      ...previous,
      [paragraph.id]: { status: 'loading', text: '' },
    }));

    return new Promise<boolean>((resolve) => {
      let content = '';
      let settled = false;
      const finish = (success: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        abortsRef.current.delete(paragraph.id);
        if (success) {
          setTranslations((previous) => ({
            ...previous,
            [paragraph.id]: { status: 'done', text: content.trim() },
          }));
        } else if (error === 'ABORTED') {
          setTranslations((previous) => ({
            ...previous,
            [paragraph.id]: { status: 'idle', text: '' },
          }));
        } else {
          setTranslations((previous) => ({
            ...previous,
            [paragraph.id]: { status: 'error', text: content, error: error || '翻译失败，请重试' },
          }));
        }
        resolve(success);
      };

      const request = fetchLlmStream({
        apiUrl,
        apiKey,
        apiModel,
        timeoutSec: timeout,
        systemPrompt: promptTemplate || `你是专业学术翻译。请将输入内容准确翻译成${targetLanguage}。保留数学符号、变量名、引用标记和段落语气；只输出译文，不要解释，不要添加标题。`,
        userPrompt: `请将下面这一个网页论文段落翻译成${targetLanguage}：\n\n${paragraph.text}`,
        onData: (chunk) => {
          content += chunk;
          setTranslations((previous) => ({
            ...previous,
            [paragraph.id]: { status: 'loading', text: content },
          }));
        },
        onError: (error) => finish(false, error),
        onDone: () => finish(true),
      });

      abortsRef.current.set(paragraph.id, request.abort);
    });
  }, []);

  const translateAll = useCallback(async () => {
    if (isTranslatingAll || paragraphs.length === 0) return;
    const runId = allRunIdRef.current + 1;
    allRunIdRef.current = runId;
    setIsTranslatingAll(true);

    for (const paragraph of paragraphs) {
      if (allRunIdRef.current !== runId) break;
      const state = translations[paragraph.id];
      if (state?.status === 'done') continue;
      await translateParagraph(paragraph);
    }

    if (allRunIdRef.current === runId) setIsTranslatingAll(false);
  }, [isTranslatingAll, paragraphs, translateParagraph, translations]);

  const stopTranslation = useCallback(() => {
    allRunIdRef.current += 1;
    abortsRef.current.forEach((abort) => abort());
    abortsRef.current.clear();
    setIsTranslatingAll(false);
  }, []);

  useEffect(() => () => {
    allRunIdRef.current += 1;
    abortsRef.current.forEach((abort) => abort());
  }, [pageUrl]);

  const doneCount = useMemo(() => paragraphs.reduce((count, paragraph) => (
    translations[paragraph.id]?.status === 'done' ? count + 1 : count
  ), 0), [paragraphs, translations]);

  if (paragraphs.length === 0) return null;

  return (
    <>
      {paragraphs.map((paragraph) => createPortal(
        <TranslationBlock
          key={paragraph.id}
          paragraph={paragraph}
          state={translations[paragraph.id]}
          onTranslate={translateParagraph}
        />,
        paragraph.host,
        paragraph.id,
      ))}
      <div className={`linkual-article-panel ${isPanelOpen ? 'open' : 'closed'}`}>
        <div className="linkual-article-panel-header">
          <button type="button" className="linkual-article-panel-title" onClick={() => setIsPanelOpen((open) => !open)}>
            <span>Linkual 网页翻译</span>
            <span className="linkual-article-panel-count">{doneCount}/{paragraphs.length}</span>
          </button>
          <button type="button" className="linkual-article-panel-close" onClick={() => setIsPanelOpen(false)} aria-label="折叠网页翻译">−</button>
        </div>
        {isPanelOpen && (
          <div className="linkual-article-panel-body">
            <div className="linkual-article-panel-info">已识别 {paragraphs.length} 个正文段落，每段单独翻译。</div>
            <div className="linkual-article-panel-actions">
              {isTranslatingAll ? (
                <button type="button" className="primary" onClick={stopTranslation}>停止翻译</button>
              ) : (
                <button type="button" className="primary" onClick={() => void translateAll}>翻译全文</button>
              )}
              <button type="button" onClick={syncParagraphs}>重新扫描</button>
              <button type="button" onClick={onOpenSettings}>设置</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default ArticleTranslator;
