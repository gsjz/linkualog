import { GM_getValue, GM_setValue, GM_deleteValue } from '$';
import { SentencePair } from './articleSentences';

const STORAGE_KEY = 'linkual_article_translation_cache';
const CACHE_VERSION = 1;
const CACHE_UPDATED_EVENT = 'linkual_article_cache_updated';

export interface CachedTranslationEntry {
  sourceText: string;
  text: string;
  sentences: SentencePair[];
}

export interface ArticleTranslationCache {
  url: string;
  targetLanguage: string;
  updatedAt: number;
  entries: Record<string, CachedTranslationEntry>;
}

interface CacheStore {
  version: number;
  pages: Record<string, ArticleTranslationCache>;
}

function getCanonicalUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url.split('#')[0] || url;
  }
}

export function getArticleTranslationCacheKey(url: string, targetLanguage: string) {
  return `${getCanonicalUrl(url)}\n${targetLanguage.trim() || '简体中文'}`;
}

function parseStore(value: unknown): CacheStore {
  const parsed = typeof value === 'string' ? (() => {
    try { return JSON.parse(value) as unknown; } catch { return null; }
  })() : value;
  if (!parsed || typeof parsed !== 'object') return { version: CACHE_VERSION, pages: {} };
  const candidate = parsed as Partial<CacheStore>;
  if (!candidate.pages || typeof candidate.pages !== 'object') return { version: CACHE_VERSION, pages: {} };
  return { version: CACHE_VERSION, pages: candidate.pages as Record<string, ArticleTranslationCache> };
}

function readStore() {
  try {
    if (typeof GM_getValue !== 'undefined') {
      const gmValue = GM_getValue(STORAGE_KEY);
      if (gmValue !== undefined && gmValue !== null) return parseStore(gmValue);
    }
  } catch {}
  return parseStore(localStorage.getItem(STORAGE_KEY));
}

function writeStore(store: CacheStore) {
  const serialized = JSON.stringify(store);
  try {
    if (typeof GM_setValue !== 'undefined') GM_setValue(STORAGE_KEY, store);
  } catch {}
  localStorage.setItem(STORAGE_KEY, serialized);
  window.dispatchEvent(new Event(CACHE_UPDATED_EVENT));
}

export function getArticleTranslationCache(url: string, targetLanguage: string) {
  return readStore().pages[getArticleTranslationCacheKey(url, targetLanguage)] || null;
}

export function saveArticleTranslation(
  url: string,
  targetLanguage: string,
  paragraphId: string,
  entry: CachedTranslationEntry,
) {
  const store = readStore();
  const key = getArticleTranslationCacheKey(url, targetLanguage);
  const current = store.pages[key] || {
    url: getCanonicalUrl(url),
    targetLanguage: targetLanguage.trim() || '简体中文',
    updatedAt: Date.now(),
    entries: {},
  };
  current.entries[paragraphId] = entry;
  current.updatedAt = Date.now();
  store.pages[key] = current;
  writeStore(store);
}

export function listArticleTranslationCaches() {
  return Object.entries(readStore().pages)
    .map(([key, page]) => ({ key, ...page, entryCount: Object.keys(page.entries || {}).length }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function clearArticleTranslationCaches() {
  const empty = { version: CACHE_VERSION, pages: {} };
  try {
    if (typeof GM_setValue !== 'undefined') GM_setValue(STORAGE_KEY, empty);
    if (typeof GM_deleteValue !== 'undefined') GM_deleteValue(`${STORAGE_KEY}_legacy`);
  } catch {}
  localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(CACHE_UPDATED_EVENT));
}

export function deleteArticleTranslationCache(key: string) {
  const store = readStore();
  delete store.pages[key];
  writeStore(store);
}

export { CACHE_UPDATED_EVENT };
