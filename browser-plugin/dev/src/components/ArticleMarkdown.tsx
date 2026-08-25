import React, { useMemo } from 'react';
import ArticleMath from './ArticleMath';

type TableAlignment = 'left' | 'center' | 'right' | undefined;
type MarkdownRenderMode = 'inline' | 'block';

interface TextBlock {
  type: 'text';
  text: string;
}

interface ParagraphBlock {
  type: 'paragraph';
  text: string;
}

interface HeadingBlock {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

interface ListBlock {
  type: 'list';
  ordered: boolean;
  items: string[];
}

interface QuoteBlock {
  type: 'quote';
  text: string;
}

interface CodeBlock {
  type: 'code';
  code: string;
  language: string;
}

interface RuleBlock {
  type: 'rule';
}

interface TableBlock {
  type: 'table';
  header: string[];
  alignments: TableAlignment[];
  rows: string[][];
}

type InlineMarkdownBlock = TextBlock | TableBlock;
type BlockMarkdownBlock = ParagraphBlock | HeadingBlock | ListBlock | QuoteBlock | CodeBlock | RuleBlock | TableBlock;

interface ArticleMarkdownProps {
  text: string;
  mode?: MarkdownRenderMode;
}

const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;
const FENCE_PATTERN = /^\s*(```+|~~~+)\s*([\w-]+)?\s*$/;
const THEMATIC_BREAK_PATTERN = /^\s{0,3}(([-*_])\s*){3,}$/;
const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const QUOTE_PATTERN = /^\s{0,3}>\s?(.*)$/;
const BULLET_LIST_PATTERN = /^\s{0,3}[-*+]\s+(.+)$/;
const ORDERED_LIST_PATTERN = /^\s{0,3}\d+[.)]\s+(.+)$/;
const INLINE_MARKDOWN_PATTERN = /(`[^`\n]+`|\[[^\]\n]+\]\([^)]+\)|\*\*[\s\S]+?\*\*|\*[^*\n]+?\*)/g;

function normalizeMarkdown(text: string) {
  return text.replace(/\r\n?/g, '\n');
}

function splitMarkdownTableRow(row: string) {
  let value = row.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);

  const cells: string[] = [];
  let cell = '';
  let inlineMath = false;
  let displayMath = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] || '';
    const nextCharacter = value[index + 1] || '';

    if (character === '\\' && nextCharacter === '|') {
      cell += '|';
      index += 1;
      continue;
    }

    if (character === '$' && nextCharacter === '$') {
      displayMath = !displayMath;
      cell += '$$';
      index += 1;
      continue;
    }

    if (character === '$' && !displayMath) {
      inlineMath = !inlineMath;
      cell += character;
      continue;
    }

    if (character === '|' && !inlineMath && !displayMath) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }

    cell += character;
  }

  cells.push(cell.trim());
  return cells;
}

function isTableSeparator(line: string) {
  const cells = splitMarkdownTableRow(line).map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL_PATTERN.test(cell));
}

function isTableStart(lines: string[], index: number) {
  const header = lines[index]?.trim() || '';
  const separator = lines[index + 1]?.trim() || '';
  return header.includes('|') && isTableSeparator(separator);
}

function getAlignment(separatorCell: string): TableAlignment {
  const value = separatorCell.trim();
  if (value.startsWith(':') && value.endsWith(':')) return 'center';
  if (value.endsWith(':')) return 'right';
  if (value.startsWith(':')) return 'left';
  return undefined;
}

function normalizeTableRow(cells: string[], columnCount: number) {
  return Array.from({ length: columnCount }, (_, index) => cells[index] || '');
}

function parseTableBlock(lines: string[], index: number) {
  const header = splitMarkdownTableRow(lines[index] || '');
  const separator = splitMarkdownTableRow(lines[index + 1] || '');
  const rows: string[][] = [];
  let nextIndex = index + 2;

  while (nextIndex < lines.length) {
    const line = lines[nextIndex] || '';
    if (!line.trim() || !line.includes('|') || isTableSeparator(line)) break;
    rows.push(splitMarkdownTableRow(line));
    nextIndex += 1;
  }

  const columnCount = Math.max(
    header.length,
    separator.length,
    ...rows.map((row) => row.length),
  );

  return {
    block: {
      type: 'table' as const,
      header: normalizeTableRow(header, columnCount),
      alignments: normalizeTableRow(separator, columnCount).map(getAlignment),
      rows: rows.map((row) => normalizeTableRow(row, columnCount)),
    },
    nextIndex,
  };
}

function parseInlineMarkdownBlocks(text: string): InlineMarkdownBlock[] {
  const lines = normalizeMarkdown(text).split('\n');
  const blocks: InlineMarkdownBlock[] = [];
  let index = 0;
  let textBuffer: string[] = [];

  const flushText = () => {
    const value = textBuffer.join('\n').trim();
    if (value) blocks.push({ type: 'text', text: value });
    textBuffer = [];
  };

  while (index < lines.length) {
    if (isTableStart(lines, index)) {
      flushText();
      const { block, nextIndex } = parseTableBlock(lines, index);
      blocks.push(block);
      index = nextIndex;
      continue;
    }

    textBuffer.push(lines[index] || '');
    index += 1;
  }

  flushText();
  return blocks.length > 0 ? blocks : [{ type: 'text', text }];
}

function getListMatch(line: string) {
  const ordered = line.match(ORDERED_LIST_PATTERN);
  if (ordered) return { ordered: true, text: ordered[1] || '' };

  const bullet = line.match(BULLET_LIST_PATTERN);
  if (bullet) return { ordered: false, text: bullet[1] || '' };

  return null;
}

function isBlockStart(lines: string[], index: number) {
  const line = lines[index] || '';
  return Boolean(
    FENCE_PATTERN.test(line)
    || isTableStart(lines, index)
    || HEADING_PATTERN.test(line)
    || THEMATIC_BREAK_PATTERN.test(line)
    || QUOTE_PATTERN.test(line)
    || getListMatch(line)
  );
}

function parseBlockMarkdownBlocks(text: string): BlockMarkdownBlock[] {
  const lines = normalizeMarkdown(text).split('\n');
  const blocks: BlockMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] || '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(FENCE_PATTERN);
    if (fence) {
      const fenceMarker = fence[1] || '';
      const fenceChar = fenceMarker[0] || '`';
      const fenceLength = fenceMarker.length;
      const closingFence = new RegExp(`^\\s*${fenceChar}{${fenceLength},}\\s*$`);
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !closingFence.test(lines[index] || '')) {
        codeLines.push(lines[index] || '');
        index += 1;
      }
      if (index < lines.length) index += 1;

      blocks.push({ type: 'code', code: codeLines.join('\n'), language: fence[2] || '' });
      continue;
    }

    if (isTableStart(lines, index)) {
      const { block, nextIndex } = parseTableBlock(lines, index);
      blocks.push(block);
      index = nextIndex;
      continue;
    }

    const heading = line.match(HEADING_PATTERN);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: Math.min(6, heading[1]?.length || 1) as HeadingBlock['level'],
        text: (heading[2] || '').trim(),
      });
      index += 1;
      continue;
    }

    if (THEMATIC_BREAK_PATTERN.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    const quote = line.match(QUOTE_PATTERN);
    if (quote) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quoteLine = (lines[index] || '').match(QUOTE_PATTERN);
        if (!quoteLine) break;
        quoteLines.push(quoteLine[1] || '');
        index += 1;
      }
      blocks.push({ type: 'quote', text: quoteLines.join('\n').trim() });
      continue;
    }

    const listMatch = getListMatch(line);
    if (listMatch) {
      const items: string[] = [];
      const ordered = listMatch.ordered;

      while (index < lines.length) {
        const currentMatch = getListMatch(lines[index] || '');
        if (!currentMatch || currentMatch.ordered !== ordered) break;

        let itemText = currentMatch.text;
        index += 1;

        while (index < lines.length) {
          const continuation = lines[index] || '';
          if (!continuation.trim()) {
            index += 1;
            break;
          }
          if (getListMatch(continuation) || isBlockStart(lines, index)) break;
          if (/^\s{2,}/.test(continuation)) {
            itemText += `\n${continuation.replace(/^\s{2,}/, '')}`;
            index += 1;
            continue;
          }
          break;
        }

        items.push(itemText.trim());
      }

      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const currentLine = lines[index] || '';
      if (!currentLine.trim()) break;
      if (paragraphLines.length > 0 && isBlockStart(lines, index)) break;
      paragraphLines.push(currentLine);
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraphLines.join('\n').trim() });
  }

  return blocks.length > 0 ? blocks : [{ type: 'paragraph', text }];
}

export function hasMarkdownTable(text: string) {
  const lines = normalizeMarkdown(text).split('\n');
  return lines.some((_, index) => isTableStart(lines, index));
}

function getSafeMarkdownUrl(rawUrl: string) {
  const url = rawUrl.trim().replace(/^<|>$/g, '');
  if (/^(https?:|mailto:|#|\/)/i.test(url)) return url;
  return '';
}

function renderInlineMarkdown(text: string, keyPrefix: string, allowLinks = false): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = new RegExp(INLINE_MARKDOWN_PATTERN);
  let cursor = 0;
  let match = pattern.exec(text);

  while (match) {
    const token = match[0] || '';
    if (match.index > cursor) {
      nodes.push(<ArticleMath key={`${keyPrefix}-text-${cursor}`} text={text.slice(cursor, match.index)} />);
    }

    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code className="linkual-markdown-inline-code" key={`${keyPrefix}-code-${match.index}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]\n]+)\]\(([^)\n]+)\)$/);
      const href = getSafeMarkdownUrl(link?.[2] || '');
      if (link && href && allowLinks) {
        nodes.push(
          <a
            className="linkual-markdown-link"
            href={href}
            key={`${keyPrefix}-link-${match.index}`}
            rel="noreferrer"
            target="_blank"
          >
            {renderInlineMarkdown(link[1] || '', `${keyPrefix}-link-${match.index}`, allowLinks)}
          </a>
        );
      } else if (link) {
        nodes.push(
          <span className="linkual-markdown-link-text" key={`${keyPrefix}-link-text-${match.index}`}>
            {renderInlineMarkdown(link[1] || '', `${keyPrefix}-link-text-${match.index}`, allowLinks)}
          </span>
        );
      } else {
        nodes.push(<ArticleMath key={`${keyPrefix}-link-text-${match.index}`} text={token} />);
      }
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-strong-${match.index}`}>
          {renderInlineMarkdown(token.slice(2, -2), `${keyPrefix}-strong-${match.index}`, allowLinks)}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(
        <em key={`${keyPrefix}-em-${match.index}`}>
          {renderInlineMarkdown(token.slice(1, -1), `${keyPrefix}-em-${match.index}`, allowLinks)}
        </em>
      );
    } else {
      nodes.push(<ArticleMath key={`${keyPrefix}-fallback-${match.index}`} text={token} />);
    }

    cursor = match.index + token.length;
    match = pattern.exec(text);
  }

  if (cursor < text.length) {
    nodes.push(<ArticleMath key={`${keyPrefix}-text-${cursor}`} text={text.slice(cursor)} />);
  }

  return nodes.length > 0 ? nodes : [<ArticleMath key={`${keyPrefix}-empty`} text={text} />];
}

function renderTable(block: TableBlock, blockIndex: number, allowLinks: boolean) {
  return (
    <div className="linkual-article-markdown-table-wrap" key={`table-${blockIndex}`}>
      <table className="linkual-article-markdown-table">
        <thead>
          <tr>
            {block.header.map((cell, cellIndex) => (
              <th key={`head-${cellIndex}`} style={{ textAlign: block.alignments[cellIndex] }}>
                {renderInlineMarkdown(cell, `table-${blockIndex}-head-${cellIndex}`, allowLinks)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`cell-${rowIndex}-${cellIndex}`} style={{ textAlign: block.alignments[cellIndex] }}>
                  {renderInlineMarkdown(cell, `table-${blockIndex}-cell-${rowIndex}-${cellIndex}`, allowLinks)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderHeading(block: HeadingBlock, blockIndex: number) {
  const children = renderInlineMarkdown(block.text, `heading-${blockIndex}`, true);
  const className = `linkual-markdown-heading linkual-markdown-heading-${block.level}`;

  switch (block.level) {
    case 1:
      return <h1 className={className} key={`heading-${blockIndex}`}>{children}</h1>;
    case 2:
      return <h2 className={className} key={`heading-${blockIndex}`}>{children}</h2>;
    case 3:
      return <h3 className={className} key={`heading-${blockIndex}`}>{children}</h3>;
    case 4:
      return <h4 className={className} key={`heading-${blockIndex}`}>{children}</h4>;
    case 5:
      return <h5 className={className} key={`heading-${blockIndex}`}>{children}</h5>;
    default:
      return <h6 className={className} key={`heading-${blockIndex}`}>{children}</h6>;
  }
}

const ArticleMarkdown: React.FC<ArticleMarkdownProps> = ({ text, mode = 'inline' }) => {
  const inlineBlocks = useMemo(() => (
    mode === 'inline' ? parseInlineMarkdownBlocks(text) : []
  ), [mode, text]);
  const blockBlocks = useMemo(() => (
    mode === 'block' ? parseBlockMarkdownBlocks(text) : []
  ), [mode, text]);

  if (mode === 'inline') {
    return (
      <>
        {inlineBlocks.map((block, blockIndex) => {
          if (block.type === 'text') {
            return (
              <span className="linkual-article-markdown-text" key={`text-${blockIndex}`}>
                {renderInlineMarkdown(block.text, `text-${blockIndex}`, false)}
              </span>
            );
          }

          return renderTable(block, blockIndex, false);
        })}
      </>
    );
  }

  return (
    <>
      {blockBlocks.map((block, blockIndex) => {
        if (block.type === 'paragraph') {
          return (
            <p className="linkual-markdown-paragraph" key={`paragraph-${blockIndex}`}>
              {renderInlineMarkdown(block.text, `paragraph-${blockIndex}`, true)}
            </p>
          );
        }

        if (block.type === 'heading') return renderHeading(block, blockIndex);

        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag className="linkual-markdown-list" key={`list-${blockIndex}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`item-${itemIndex}`}>
                  {renderInlineMarkdown(item, `list-${blockIndex}-item-${itemIndex}`, true)}
                </li>
              ))}
            </ListTag>
          );
        }

        if (block.type === 'quote') {
          return (
            <blockquote className="linkual-markdown-quote" key={`quote-${blockIndex}`}>
              {renderInlineMarkdown(block.text, `quote-${blockIndex}`, true)}
            </blockquote>
          );
        }

        if (block.type === 'code') {
          return (
            <pre className="linkual-markdown-code-block" key={`code-${blockIndex}`}>
              <code data-language={block.language || undefined}>{block.code}</code>
            </pre>
          );
        }

        if (block.type === 'rule') {
          return <hr className="linkual-markdown-rule" key={`rule-${blockIndex}`} />;
        }

        return renderTable(block, blockIndex, true);
      })}
    </>
  );
};

export default ArticleMarkdown;
