import React from 'react';
import { createPortal } from 'react-dom';
import { useArticleTranslation } from './ArticleTranslationContext';
import { ArticleParagraph } from '../services/articleTranslator';
import { TranslationState } from './ArticleTranslationContext';

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
