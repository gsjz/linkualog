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

interface TranslationResult {
  success: boolean;
  error?: string;
  aborted: boolean;
  elapsedMs: number;
}

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
  translationConcurrency: number;
  translateParagraph: (paragraph: ArticleParagraph) => Promise<boolean>;
  translateAll: () => Promise<void>;
  stopTranslation: () => void;
  rescan: () => void;
}

const LINKUAL_NAVIGATION_EVENT = 'linkual_navigation';
const INITIAL_TRANSLATION_CONCURRENCY = 4;
const MIN_TRANSLATION_CONCURRENCY = 1;
const MAX_TRANSLATION_CONCURRENCY = 8;
const HEALTHY_RESPONSES_TO_SCALE = 3;
const RATE_LIMIT_ERROR_PATTERN = /(?:429|rate\s*limit|too\s*many\s*requests|限流|请求过多)/i;

const ArticleTranslationContext = createContext<ArticleTranslationContextValue | null>(null);

export const ArticleTranslationProvider: React.FC<React.PropsWithChildren<{ enabled: boolean }>> = ({ enabled, children }) => {
  const [paragraphs, setParagraphs] = useState<ArticleParagraph[]>([]);
  const [pageUrl, setPageUrl] = useState(window.location.href);
  const [translations, setTranslations] = useState<Record<string, TranslationState>>({});
  const [isTranslatingAll, setIsTranslatingAll] = useState(false);
  const [translationConcurrency, setTranslationConcurrency] = useState(INITIAL_TRANSLATION_CONCURRENCY);
  const abortsRef = useRef(new Map<string, () => void>());
  const allRunIdRef = useRef(0);
  const concurrencyRef = useRef(INITIAL_TRANSLATION_CONCURRENCY);
  const healthyResponsesRef = useRef(0);
  const translationsRef = useRef(translations);

  useEffect(() => {
    translationsRef.current = translations;
  }, [translations]);

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

  const translateParagraphRequest = useCallback((paragraph: ArticleParagraph): Promise<TranslationResult> => {
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
      return Promise.resolve({ success: false, aborted: false, error: '请先在设置中填入 API Key', elapsedMs: 0 });
    }

    abortsRef.current.get(paragraph.id)?.();
    setTranslations((previous) => ({
      ...previous,
      [paragraph.id]: { status: 'loading', text: '' },
    }));

    return new Promise<TranslationResult>((resolve) => {
      let content = '';
      let settled = false;
      const startedAt = Date.now();
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
        resolve({
          success,
          error,
          aborted: error === 'ABORTED',
          elapsedMs: Date.now() - startedAt,
        });
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

  const translateParagraph = useCallback(async (paragraph: ArticleParagraph) => (
    (await translateParagraphRequest(paragraph)).success
  ), [translateParagraphRequest]);

  const adaptTranslationConcurrency = useCallback((result: TranslationResult, timeoutSec: number) => {
    if (result.aborted) return;

    const slowResponseLimit = Math.max(5000, timeoutSec * 1000 * 0.65);
    const shouldReduce = !result.success || result.elapsedMs >= slowResponseLimit;
    if (shouldReduce) {
      healthyResponsesRef.current = 0;
      const isRateLimited = RATE_LIMIT_ERROR_PATTERN.test(result.error || '');
      const nextConcurrency = isRateLimited
        ? Math.max(MIN_TRANSLATION_CONCURRENCY, Math.floor(concurrencyRef.current / 2))
        : Math.max(MIN_TRANSLATION_CONCURRENCY, concurrencyRef.current - 1);
      concurrencyRef.current = nextConcurrency;
      setTranslationConcurrency(nextConcurrency);
      return;
    }

    healthyResponsesRef.current += 1;
    if (healthyResponsesRef.current < HEALTHY_RESPONSES_TO_SCALE) return;

    healthyResponsesRef.current = 0;
    const nextConcurrency = Math.min(
      MAX_TRANSLATION_CONCURRENCY,
      concurrencyRef.current + 1,
    );
    concurrencyRef.current = nextConcurrency;
    setTranslationConcurrency(nextConcurrency);
  }, []);

  const translateAll = useCallback(async () => {
    if (isTranslatingAll || paragraphs.length === 0) return;
    const runId = allRunIdRef.current + 1;
    allRunIdRef.current = runId;
    setIsTranslatingAll(true);
    healthyResponsesRef.current = 0;

    const timeout = parseInt(ConfigService.get('api_timeout') as string, 10) || 30;
    const queue = paragraphs.filter((paragraph) => translationsRef.current[paragraph.id]?.status !== 'done');

    await new Promise<void>((resolve) => {
      let cursor = 0;
      let activeCount = 0;
      let settled = false;

      const finish = () => {
        if (settled || activeCount > 0 || (cursor < queue.length && allRunIdRef.current === runId)) return;
        settled = true;
        if (allRunIdRef.current === runId) setIsTranslatingAll(false);
        resolve();
      };

      const pump = () => {
        if (allRunIdRef.current !== runId) {
          finish();
          return;
        }

        while (activeCount < concurrencyRef.current && cursor < queue.length) {
          const paragraph = queue[cursor];
          cursor += 1;
          activeCount += 1;

          void translateParagraphRequest(paragraph).then((result) => {
            adaptTranslationConcurrency(result, timeout);
          }).finally(() => {
            activeCount -= 1;
            pump();
            finish();
          });
        }

        finish();
      };

      pump();
    });
  }, [adaptTranslationConcurrency, isTranslatingAll, paragraphs, translateParagraphRequest]);

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
    translationConcurrency,
    translateParagraph,
    translateAll,
    stopTranslation,
    rescan: syncParagraphs,
  }), [doneCount, isTranslatingAll, paragraphs, stopTranslation, syncParagraphs, translateAll, translateParagraph, translationConcurrency, translations]);

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
