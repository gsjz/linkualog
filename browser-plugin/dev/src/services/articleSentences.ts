export interface SentencePair {
  sourceIndex: number;
  translationIndex: number;
  source: string;
  translation: string;
}

const SENTENCE_PATTERN = /[^.!?。！？]+[.!?。！？]+["'”’）)]*|[^.!?。！？]+$/g;

export function normalizeSentence(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

export function splitSentences(value: string) {
  return Array.from(value.matchAll(SENTENCE_PATTERN))
    .map((match) => normalizeSentence(match[0] || ''))
    .filter(Boolean);
}

export function alignSentencePairs(source: string, translation: string): SentencePair[] {
  const sourceSentences = splitSentences(source);
  const translatedSentences = splitSentences(translation);
  if (sourceSentences.length === 0 || translatedSentences.length === 0) return [];

  return translatedSentences.map((translatedSentence, translationIndex) => {
    const sourceIndex = sourceSentences.length === translatedSentences.length
      ? translationIndex
      : Math.min(
          sourceSentences.length - 1,
          Math.floor((translationIndex * sourceSentences.length) / translatedSentences.length),
        );

    return {
      sourceIndex,
      translationIndex,
      source: sourceSentences[sourceIndex] || sourceSentences[sourceSentences.length - 1] || '',
      translation: translatedSentence,
    };
  });
}

interface TextPoint {
  node: Text;
  offset: number;
}

interface TextModel {
  text: string;
  points: TextPoint[];
}

function createTextModel(root: HTMLElement): TextModel {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let text = '';
  const points: TextPoint[] = [];

  while (node) {
    const textNode = node as Text;
    const parent = textNode.parentElement;
    if (parent && !parent.closest('[data-linkual-article-host], script, style, noscript')) {
      const value = textNode.nodeValue || '';
      for (let index = 0; index < value.length; index += 1) {
        const character = value[index] || '';
        if (/\s/.test(character)) {
          if (text.endsWith(' ')) continue;
          text += ' ';
          points.push({ node: textNode, offset: index });
        } else {
          text += character;
          points.push({ node: textNode, offset: index });
        }
      }
    }
    node = walker.nextNode();
  }

  return { text: text.trim(), points };
}

export function findSentenceRange(root: HTMLElement, sentence: string) {
  const model = createTextModel(root);
  const target = normalizeSentence(sentence);
  if (!target) return null;

  const start = model.text.indexOf(target);
  if (start < 0) return null;
  const end = start + target.length - 1;
  const startPoint = model.points[start];
  const endPoint = model.points[end];
  if (!startPoint || !endPoint) return null;

  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset + 1);
  return range;
}

export function getSentenceIndexAtPoint(root: HTMLElement, event: MouseEvent, source: string) {
  const getCaretRange = (document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  });
  const range = getCaretRange.caretRangeFromPoint?.(event.clientX, event.clientY);
  const position = range || getCaretRange.caretPositionFromPoint?.(event.clientX, event.clientY);
  if (!position) return -1;

  const caret = 'startContainer' in position
    ? position
    : (() => {
        const next = document.createRange();
        next.setStart(position.offsetNode, position.offset);
        next.collapse(true);
        return next;
      })();
  if (!root.contains(caret.startContainer)) return -1;

  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(caret.startContainer, caret.startOffset);
  const offset = normalizeSentence(before.toString()).length;
  const sentences = splitSentences(source);
  let cursor = 0;
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index] || '';
    if (offset <= cursor + sentence.length) return index;
    cursor += sentence.length + 1;
  }
  return sentences.length - 1;
}
