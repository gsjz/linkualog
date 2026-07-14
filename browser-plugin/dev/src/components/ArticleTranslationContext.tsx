import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ArticleParagraph, collectArticleParagraphs, removeArticleTranslationHosts } from '../services/articleTranslator';
import { fetchLlmStream } from '../services/llmApi';
import { ConfigService } from '../services/configService';
import { alignSentencePairs } from '../services/articleSentences';
import {
  CACHE_UPDATED_EVENT,
  CachedTranslationEntry,
  getArticleTranslationCache,
  saveArticleTranslation,
} from '../services/articleTranslationCache';

type TranslationStatus = 'idle' | 'loading' | 'done' | 'error';

export interface TranslationState {
  text: string;
  status: TranslationStatus;
  error?: string;
  sentences?: CachedTranslationEntry['sentences'];
}

export interface ArticleTranslationContextValue {
  paragraphs: ArticleParagraph[];
  translations: Record<string, TranslationState>;
  isPageSupported: boolean;
  doneCount: number;
  isTranslatingAll: boolean;
  translateParagraph: (paragraph: ArticleParagraph) => Promise<boolean>;
  translateAll: () => Promise<void>;
  stopTranslation: () => void;
  rescan: () => void;
}

const LINKUAL_NAVIGATION_EVENT = 'linkual_navigation';

const ArticleTranslationContext = createContext<ArticleTranslationContextValue | null>(null);

export const ArticleTranslationProvider: React.FC<React.PropsWithChildren<{ enabled: boolean }>> = ({ enabled, children }) => {
  const [paragraphs, setParagraphs] = useState<ArticleParagraph[]>([]);
  const [pageUrl, setPageUrl] = useState(window.location.href);
  const [translations, setTranslations] = useState<Record<string, TranslationState>>({});
  const [isTranslatingAll, setIsTranslatingAll] = useState(false);
  const abortsRef = useRef(new Map<string, () => void>());
  const allRunIdRef = useRef(0);

  const getTargetLanguage = () => ConfigService.get('web_target_language').trim() || '简体中文';
  const cacheScopeRef = useRef(`${window.location.href}\n${ConfigService.get('web_target_language').trim() || '简体中文'}`);

  const hydrateCache = useCallback((nextParagraphs: ArticleParagraph[], nextUrl: string) => {
    const cache = getArticleTranslationCache(nextUrl, getTargetLanguage());
    if (!cache) return {};

    return nextParagraphs.reduce<Record<string, TranslationState>>((result, paragraph) => {
      const entry = cache.entries[paragraph.id];
      if (entry && entry.sourceText === paragraph.text && entry.text) {
        result[paragraph.id] = { status: 'done', text: entry.text, sentences: entry.sentences };
      }
      return result;
    }, {});
  }, []);

  const syncParagraphs = useCallback(() => {
    if (!enabled) return;

    const nextParagraphs = collectArticleParagraphs();
    const nextUrl = window.location.href;
    const nextCacheScope = `${nextUrl}\n${getTargetLanguage()}`;
    const nextHosts = new Set(nextParagraphs.map((paragraph) => paragraph.host));
    removeArticleTranslationHosts(nextHosts);

    setParagraphs((previous) => {
      const unchanged = previous.length === nextParagraphs.length && previous.every((paragraph, index) => (
        paragraph.element === nextParagraphs[index]?.element && paragraph.text === nextParagraphs[index]?.text
      ));
      return unchanged ? previous : nextParagraphs;
    });

    setTranslations((previous) => {
      const cached = hydrateCache(nextParagraphs, nextUrl);
      if (cacheScopeRef.current !== nextCacheScope) {
        cacheScopeRef.current = nextCacheScope;
        return cached;
      }
      return Object.keys(cached).length > 0 ? { ...previous, ...cached } : previous;
    });

    setPageUrl((previous) => {
      if (previous === nextUrl) return previous;
      allRunIdRef.current += 1;
      abortsRef.current.forEach((abort) => abort());
      abortsRef.current.clear();
      setTranslations(hydrateCache(nextParagraphs, nextUrl));
      setIsTranslatingAll(false);
      return nextUrl;
    });
  }, [enabled, hydrateCache]);

  useEffect(() => {
    if (!enabled) {
      allRunIdRef.current += 1;
      abortsRef.current.forEach((abort) => abort());
      abortsRef.current.clear();
      setParagraphs([]);
      setTranslations({});
      setIsTranslatingAll(false);
      removeArticleTranslationHosts();
      return undefined;
    }

    syncParagraphs();
    const interval = window.setInterval(syncParagraphs, 1200);
    window.addEventListener(LINKUAL_NAVIGATION_EVENT, syncParagraphs);
    window.addEventListener('popstate', syncParagraphs);
    window.addEventListener('hashchange', syncParagraphs);
    window.addEventListener('linkual_settings_updated', syncParagraphs);
    const refreshCurrentCache = () => {
      const currentParagraphs = collectArticleParagraphs();
      setTranslations(hydrateCache(currentParagraphs, window.location.href));
    };
    window.addEventListener(CACHE_UPDATED_EVENT, refreshCurrentCache);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener(LINKUAL_NAVIGATION_EVENT, syncParagraphs);
      window.removeEventListener('popstate', syncParagraphs);
      window.removeEventListener('hashchange', syncParagraphs);
      window.removeEventListener('linkual_settings_updated', syncParagraphs);
      window.removeEventListener(CACHE_UPDATED_EVENT, refreshCurrentCache);
      abortsRef.current.forEach((abort) => abort());
      abortsRef.current.clear();
      removeArticleTranslationHosts();
    };
  }, [enabled, syncParagraphs]);

  const translateParagraph = useCallback((paragraph: ArticleParagraph) => {
    const apiKey = ConfigService.get('api_key').trim();
    const apiUrl = ConfigService.get('api_url').trim();
    const apiModel = ConfigService.get('api_model').trim();
    const timeout = parseInt(ConfigService.get('api_timeout') as string, 10) || 30;
    const targetLanguage = getTargetLanguage();
    const promptTemplate = ConfigService.get('web_translation_prompt').trim();

    if (!apiKey) {
      setTranslations((previous) => ({
        ...previous,
        [paragraph.id]: { status: 'error', text: '', error: '请先在设置中填入 API Key' },
      }));
      return Promise.resolve(false);
    }

    abortsRef.current.get(paragraph.id)?.();
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
            [paragraph.id]: {
              status: 'done',
              text: content.trim(),
              sentences: alignSentencePairs(paragraph.text, content.trim()),
            },
          }));
          saveArticleTranslation(window.location.href, targetLanguage, paragraph.id, {
            sourceText: paragraph.text,
            text: content.trim(),
            sentences: alignSentencePairs(paragraph.text, content.trim()),
          });
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
        stream: false,
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
      const success = await translateParagraph(paragraph);
      if (!success) break;
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

  const value = useMemo<ArticleTranslationContextValue>(() => ({
    paragraphs,
    translations,
    isPageSupported: paragraphs.length > 0,
    doneCount,
    isTranslatingAll,
    translateParagraph,
    translateAll,
    stopTranslation,
    rescan: syncParagraphs,
  }), [doneCount, isTranslatingAll, paragraphs, stopTranslation, syncParagraphs, translateAll, translateParagraph, translations]);

  return (
    <ArticleTranslationContext.Provider value={value}>
      {children}
    </ArticleTranslationContext.Provider>
  );
};

export function useArticleTranslation() {
  const context = useContext(ArticleTranslationContext);
  if (!context) {
    throw new Error('useArticleTranslation must be used inside ArticleTranslationProvider');
  }
  return context;
}
