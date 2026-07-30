import React, { useMemo } from 'react';
import ArticleMath from './ArticleMath';

type TableAlignment = 'left' | 'center' | 'right' | undefined;

interface TextBlock {
  type: 'text';
  text: string;
}

interface TableBlock {
  type: 'table';
  header: string[];
  alignments: TableAlignment[];
  rows: string[][];
}

type MarkdownBlock = TextBlock | TableBlock;

interface ArticleMarkdownProps {
  text: string;
}

const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;

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

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
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

      const header = splitMarkdownTableRow(lines[index] || '');
      const separator = splitMarkdownTableRow(lines[index + 1] || '');
      const rows: string[][] = [];
      index += 2;

      while (index < lines.length) {
        const line = lines[index] || '';
        if (!line.trim() || !line.includes('|') || isTableSeparator(line)) break;
        rows.push(splitMarkdownTableRow(line));
        index += 1;
      }

      const columnCount = Math.max(
        header.length,
        separator.length,
        ...rows.map((row) => row.length),
      );

      blocks.push({
        type: 'table',
        header: normalizeTableRow(header, columnCount),
        alignments: normalizeTableRow(separator, columnCount).map(getAlignment),
        rows: rows.map((row) => normalizeTableRow(row, columnCount)),
      });
      continue;
    }

    textBuffer.push(lines[index] || '');
    index += 1;
  }

  flushText();
  return blocks.length > 0 ? blocks : [{ type: 'text', text }];
}

export function hasMarkdownTable(text: string) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return lines.some((_, index) => isTableStart(lines, index));
}

const ArticleMarkdown: React.FC<ArticleMarkdownProps> = ({ text }) => {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);

  return (
    <>
      {blocks.map((block, blockIndex) => {
        if (block.type === 'text') {
          return (
            <span className="linkual-article-markdown-text" key={`text-${blockIndex}`}>
              <ArticleMath text={block.text} />
            </span>
          );
        }

        return (
          <div className="linkual-article-markdown-table-wrap" key={`table-${blockIndex}`}>
            <table className="linkual-article-markdown-table">
              <thead>
                <tr>
                  {block.header.map((cell, cellIndex) => (
                    <th key={`head-${cellIndex}`} style={{ textAlign: block.alignments[cellIndex] }}>
                      <ArticleMath text={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={`row-${rowIndex}`}>
                    {row.map((cell, cellIndex) => (
                      <td key={`cell-${rowIndex}-${cellIndex}`} style={{ textAlign: block.alignments[cellIndex] }}>
                        <ArticleMath text={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
};

export default ArticleMarkdown;
