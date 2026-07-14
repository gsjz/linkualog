import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useArticleTranslation } from './ArticleTranslationContext';
import { ArticleParagraph } from '../services/articleTranslator';
import { TranslationState } from './ArticleTranslationContext';
import {
  alignSentencePairs,
  findSentenceRange,
  getSentenceIndexAtPoint,
} from '../services/articleSentences';

const SOURCE_HIGHLIGHT_NAME = 'linkual-article-source-active';
let activeSourceHighlightOwner: object | null = null;

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
  const pairs = useMemo(() => (
    state?.sentences?.length ? state.sentences : alignSentencePairs(paragraph.text, state?.text || '')
  ), [paragraph.text, state?.sentences, state?.text]);
  const [activePairIndex, setActivePairIndex] = useState(-1);
  const sentenceRefs = useRef(new Map<number, HTMLButtonElement>());
  const sourceHighlightOwnerRef = useRef<object>({});

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

  useEffect(() => {
    if (!hasTranslation || pairs.length === 0) return undefined;

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
  }, [hasTranslation, pairs, paragraph.element, paragraph.text]);

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

    if (!highlights || !HighlightConstructor || !pair) {
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
  }, [activePairIndex, pairs, paragraph.element]);

  return (
    <div className={`linkual-article-translation ${state?.status || 'idle'}`}>
      <div className="linkual-article-translation-toolbar">
        <span className="linkual-article-translation-label">Linkual · 网页翻译</span>
        <button type="button" onClick={() => onTranslate(paragraph)} disabled={isLoading}>
          {isLoading ? '翻译中…' : hasTranslation ? '重新翻译' : '翻译本段'}
        </button>
      </div>
      {hasTranslation ? (
        <div className="linkual-article-translation-text">
          {pairs.length > 0 ? pairs.map((pair, pairIndex) => (
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
              {pair.translation}
            </button>
          )) : state?.text}
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
