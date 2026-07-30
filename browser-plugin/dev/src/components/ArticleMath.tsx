import React, { useMemo } from 'react';
import katex from 'katex';

interface MathSegment {
  type: 'text' | 'math';
  text: string;
  display: boolean;
}

interface ArticleMathProps {
  text: string;
}

const MATH_DELIMITER_PATTERN = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

function splitMathSegments(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let cursor = 0;
  const pattern = new RegExp(MATH_DELIMITER_PATTERN);
  let match: RegExpExecArray | null = pattern.exec(text);

  while (match) {
    if (match.index > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, match.index), display: false });
    }

    const isDisplay = typeof match[1] === 'string';
    const formula = (isDisplay ? match[1] : match[2] || '').trim();
    if (formula) {
      segments.push({ type: 'math', text: formula, display: isDisplay });
    } else {
      segments.push({ type: 'text', text: match[0], display: false });
    }

    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', text: text.slice(cursor), display: false });
  }

  return segments.length > 0 ? segments : [{ type: 'text', text, display: false }];
}

function renderMath(text: string, displayMode: boolean) {
  try {
    return katex.renderToString(text, {
      displayMode,
      output: 'mathml',
      strict: false,
      throwOnError: false,
      trust: false,
    });
  } catch {
    return '';
  }
}

const ArticleMath: React.FC<ArticleMathProps> = ({ text }) => {
  const segments = useMemo(() => splitMathSegments(text), [text]);

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <React.Fragment key={`text-${index}`}>{segment.text}</React.Fragment>;
        }

        const rendered = renderMath(segment.text, segment.display);
        if (!rendered) {
          const delimiter = segment.display ? '$$' : '$';
          return <React.Fragment key={`math-fallback-${index}`}>{`${delimiter}${segment.text}${delimiter}`}</React.Fragment>;
        }

        return (
          <span
            key={`math-${index}`}
            className={`linkual-article-math ${segment.display ? 'display' : 'inline'}`}
            dangerouslySetInnerHTML={{ __html: rendered }}
          />
        );
      })}
    </>
  );
};

export default ArticleMath;
