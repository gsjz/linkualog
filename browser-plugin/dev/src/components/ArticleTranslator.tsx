import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useArticleTranslation } from './ArticleTranslationContext';
import { ArticleParagraph } from '../services/articleTranslator';
import { TranslationState } from './ArticleTranslationContext';
import ArticleMarkdown, { hasMarkdownTable } from './ArticleMarkdown';
import {
  alignSentencePairs,
  findSentenceRange,
  getSentenceIndexAtPoint,
} from '../services/articleSentences';

const SOURCE_HIGHLIGHT_NAME = 'linkual-article-source-active';
let activeSourceHighlightOwner: object | null = null;

function copyTextToClipboard(text: string) {
  const fallbackCopy = () => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();

    try {
      document.execCommand('copy');
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    } finally {
      textarea.remove();
    }
  };

  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(fallbackCopy);
  }

  return fallbackCopy();
}

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
  const rawTranslation = state?.text || '';
  const shouldRenderWholeTranslation = hasMarkdownTable(rawTranslation);
  const pairs = useMemo(() => (
    state?.sentences?.length ? state.sentences : alignSentencePairs(paragraph.text, state?.text || '')
  ), [paragraph.text, state?.sentences, state?.text]);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [activePairIndex, setActivePairIndex] = useState(-1);
  const sentenceRefs = useRef(new Map<number, HTMLButtonElement>());
  const sourceHighlightOwnerRef = useRef<object>({});
  const copyResetTimerRef = useRef<number | null>(null);

  const focusSource = (pairIndex: number) => {
    const pair = pairs[pairIndex];
    if (!pair) return;
    const range = findSentenceRange(paragraph.element, pair.source);
    if (range) {
      const rect = range.getBoundingClientRect();
      window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - window.innerHeight * 0.35), behavior: 'smooth' });
    } else {
      paragraph.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setActivePairIndex(pairIndex);
  };

  const focusTranslation = (pairIndex: number) => {
    sentenceRefs.current.get(pairIndex)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setActivePairIndex(pairIndex);
  };

  const handleCopy = () => {
    if (!rawTranslation) return;
    copyTextToClipboard(rawTranslation).then(() => {
      setCopyStatus('copied');
      if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopyStatus('idle'), 1200);
    }).catch(() => {
      setCopyStatus('error');
      if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopyStatus('idle'), 1600);
    });
  };

  useEffect(() => {
    setCopyStatus('idle');
    if (copyResetTimerRef.current) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
  }, [rawTranslation]);

  useEffect(() => () => {
    if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current);
  }, []);

  useEffect(() => {
    if (!hasTranslation || shouldRenderWholeTranslation || pairs.length === 0) return undefined;

    const handleSourceClick = (event: MouseEvent) => {
      const sourceIndex = getSentenceIndexAtPoint(paragraph.element, event, paragraph.text);
      if (sourceIndex < 0) return;
      const pairIndex = pairs.findIndex((pair) => pair.sourceIndex === sourceIndex);
      if (pairIndex >= 0) focusTranslation(pairIndex);
    };

    paragraph.element.classList.add('linkual-article-source-locatable');
    paragraph.element.addEventListener('click', handleSourceClick);
    return () => {
      paragraph.element.classList.remove('linkual-article-source-locatable');
      paragraph.element.removeEventListener('click', handleSourceClick);
    };
  }, [hasTranslation, shouldRenderWholeTranslation, pairs, paragraph.element, paragraph.text]);

  useEffect(() => {
    const browserWindow = window as Window & {
      CSS?: { highlights?: { set: (name: string, highlight: unknown) => void; delete: (name: string) => void } };
      Highlight?: new (range: Range) => unknown;
    };
    const highlights = browserWindow.CSS?.highlights;
    const HighlightConstructor = browserWindow.Highlight;
    const pair = pairs[activePairIndex];
    const owner = sourceHighlightOwnerRef.current;
    const clearHighlight = () => {
      if (activeSourceHighlightOwner !== owner) return;
      highlights?.delete(SOURCE_HIGHLIGHT_NAME);
      activeSourceHighlightOwner = null;
    };

    if (!highlights || !HighlightConstructor || !pair || shouldRenderWholeTranslation) {
      clearHighlight();
      return undefined;
    }

    const range = findSentenceRange(paragraph.element, pair.source);
    if (range) {
      clearHighlight();
      highlights.set(SOURCE_HIGHLIGHT_NAME, new HighlightConstructor(range));
      activeSourceHighlightOwner = owner;
    }

    return clearHighlight;
  }, [activePairIndex, shouldRenderWholeTranslation, pairs, paragraph.element]);

  return (
    <div className={`linkual-article-translation ${state?.status || 'idle'}`}>
      <div className="linkual-article-translation-toolbar">
        <span className="linkual-article-translation-label">网页翻译</span>
        <div className="linkual-article-translation-actions">
          <button type="button" onClick={() => onTranslate(paragraph)} disabled={isLoading}>
            {isLoading ? '翻译中…' : hasTranslation ? '重新翻译' : '翻译本段'}
          </button>
          <button
            type="button"
            className={`linkual-article-copy-source ${copyStatus}`}
            onClick={handleCopy}
            disabled={!rawTranslation}
            aria-label={copyStatus === 'copied' ? '已复制译文源码' : '复制译文源码'}
            title={copyStatus === 'copied' ? '已复制译文源码' : copyStatus === 'error' ? '复制失败' : '复制译文源码'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="9" width="10" height="10" rx="2" />
              <path d="M5 15V7a2 2 0 0 1 2-2h8" />
            </svg>
          </button>
        </div>
      </div>
      {hasTranslation ? (
        <div className="linkual-article-translation-text">
          {shouldRenderWholeTranslation ? <ArticleMarkdown text={rawTranslation} /> : pairs.length > 0 ? pairs.map((pair, pairIndex) => (
            <button
              type="button"
              className={`linkual-article-translation-sentence ${activePairIndex === pairIndex ? 'active' : ''}`}
              key={`${pair.sourceIndex}-${pair.translationIndex}`}
              ref={(element) => {
                if (element) sentenceRefs.current.set(pairIndex, element);
                else sentenceRefs.current.delete(pairIndex);
              }}
              onClick={() => focusSource(pairIndex)}
              title="定位到原文句子"
            >
              <ArticleMarkdown text={pair.translation} />
            </button>
          )) : <ArticleMarkdown text={rawTranslation} />}
        </div>
      ) : (
        <div className="linkual-article-translation-placeholder">
          {state?.error || (isLoading ? '正在请求模型…' : '点击“翻译本段”显示译文')}
        </div>
      )}
    </div>
  );
}

const ArticleTranslator: React.FC = () => {
  const { paragraphs, translations, translateParagraph } = useArticleTranslation();

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
    </>
  );
};

export default ArticleTranslator;
