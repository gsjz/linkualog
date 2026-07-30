export interface ArticleParagraph {
  id: string;
  element: HTMLElement;
  text: string;
  host: HTMLDivElement;
}

const MAX_PARAGRAPHS = 600;
const MIN_PARAGRAPH_LENGTH = 18;
const HOST_CLASS = 'linkual-article-translation-host';

const EXCLUDED_SELECTOR = [
  'nav',
  'header',
  'footer',
  'aside',
  'figure',
  'table',
  'pre',
  'code',
  'script',
  'style',
  'noscript',
  '.ltx_bibliography',
  '.ltx_biblist',
  '.ltx_figure',
  '.ltx_table',
  '.ltx_caption',
  '.ltx_equation',
  '.ltx_title',
  '.ltx_authors',
  '.ltx_note',
].join(',');

const BLOCKING_DESCENDANT_SELECTOR = [
  'img',
  'video',
  'iframe',
  'canvas',
  'textarea',
  'input',
  'select',
  'button',
  'pre',
  '.CodeMirror',
  '.monaco-editor',
].join(',');

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();
const normalizeMarkdownText = (value: string) => value
  .replace(/\r\n?/g, '\n')
  .split('\n')
  .map((line) => normalizeText(line))
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
const TRANSLATABLE_TABLE_SELECTOR = 'table, .ltx_table';
const OPENREVIEW_VALUE_SELECTOR = '.note-content-value, .markdown-rendered';
const TABLE_EXCLUDED_ANCESTOR_SELECTOR = [
  '[data-linkual-article-host]',
  'nav',
  'header',
  'footer',
  'aside',
  'pre',
  'code',
  'script',
  'style',
  'noscript',
  '.ltx_bibliography',
  '.ltx_biblist',
  '.ltx_figure',
  '.ltx_caption',
  '.ltx_equation',
  '.ltx_title',
  '.ltx_authors',
  '.ltx_note',
].join(',');

const ARXIV_HOSTNAMES = new Set(['arxiv.org', 'www.arxiv.org']);
const OPENREVIEW_HOSTNAMES = new Set(['openreview.net', 'www.openreview.net']);
const OPENREVIEW_EXCLUDED_FIELDS = new Set([
  'title',
  'authors',
  'authoremails',
  'authorids',
  'pdf',
  'html',
  'paperhash',
  'ee',
  'year',
  'venue',
  'venueid',
  'submissionnumber',
  'externalids',
]);

export function isArxivHtmlPage() {
  return ARXIV_HOSTNAMES.has(window.location.hostname) && window.location.pathname.startsWith('/html/');
}

export function isOpenReviewHost() {
  return OPENREVIEW_HOSTNAMES.has(window.location.hostname);
}

export function isOpenReviewForumPage() {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  return isOpenReviewHost() && (pathname === '/forum' || pathname.startsWith('/forum/'));
}

export function isArticleTranslationSupportedPage() {
  return isArxivHtmlPage() || isOpenReviewForumPage();
}

function escapeMarkdownTableCell(value: string) {
  return normalizeText(value).replace(/\|/g, '\\|');
}

function tableElementToMarkdown(table: HTMLTableElement) {
  const rows = Array.from(table.rows)
    .map((row) => Array.from(row.cells).map((cell) => escapeMarkdownTableCell(cell.innerText || cell.textContent || '')))
    .filter((row) => row.some(Boolean));
  if (rows.length === 0) return '';

  const columnCount = Math.max(...rows.map((row) => row.length));
  const header = rows[0] || [];
  const separator = Array.from({ length: columnCount }, () => '---');
  const body = rows.slice(1);
  const normalizeRow = (row: string[]) => Array.from({ length: columnCount }, (_, index) => row[index] || '');
  const formatRow = (row: string[]) => `| ${normalizeRow(row).join(' | ')} |`;

  return [formatRow(header), formatRow(separator), ...body.map(formatRow)].join('\n');
}

function getTableCaption(element: HTMLElement, table: HTMLTableElement) {
  const caption = table.caption || element.querySelector<HTMLElement>('.ltx_caption');
  return caption ? normalizeMarkdownText(caption.innerText || caption.textContent || '') : '';
}

function ltxTableToMarkdown(element: HTMLElement) {
  const table = element.matches('table') ? element : element.querySelector('table');
  if (table instanceof HTMLTableElement) {
    return [getTableCaption(element, table), tableElementToMarkdown(table)]
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function isTranslatableTableElement(element: HTMLElement) {
  return element.matches(TRANSLATABLE_TABLE_SELECTOR);
}

function getOpenReviewValueElement(element: HTMLElement) {
  const value = element.closest(OPENREVIEW_VALUE_SELECTOR);
  return value instanceof HTMLElement ? value : null;
}

function elementToTranslatableText(element: HTMLElement) {
  if (isTranslatableTableElement(element)) {
    return ltxTableToMarkdown(element) || normalizeMarkdownText(element.innerText || element.textContent || '');
  }

  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('table').forEach((table) => {
    const markdown = tableElementToMarkdown(table);
    if (!markdown) return;
    const replacement = document.createElement('span');
    replacement.textContent = `\n${markdown}\n`;
    table.replaceWith(replacement);
  });

  return normalizeMarkdownText(clone.innerText || clone.textContent || '');
}

function hashText(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function isExcluded(element: HTMLElement) {
  if (isTranslatableTableElement(element)) {
    const tableWrapper = element.closest('.ltx_table');
    if (element.matches('table') && tableWrapper && tableWrapper !== element) return true;
    return Boolean(element.closest(TABLE_EXCLUDED_ANCESTOR_SELECTOR));
  }

  return Boolean(element.closest(EXCLUDED_SELECTOR)) || Boolean(element.closest('[data-linkual-article-host]'));
}

function getCandidateSelector() {
  if (isOpenReviewForumPage()) {
    return [
      '.note-content .note-content-value > p',
      '.note-content .note-content-value > ul > li',
      '.note-content .note-content-value > ol > li',
      '.note-content .note-content-value blockquote',
      '.note-content .note-content-value table',
      '.note-content .note-content-value',
      '.note-content-value > p',
      '.note-content-value > ul > li',
      '.note-content-value > ol > li',
      '.note-content-value blockquote',
      '.note-content-value table',
      '.note-content-value',
      '.markdown-rendered > p',
      '.markdown-rendered > ul > li',
      '.markdown-rendered > ol > li',
      '.markdown-rendered blockquote',
      '.markdown-rendered table',
      '.markdown-rendered',
    ].join(',');
  }

  return [
    '.ltx_document .ltx_para',
    '.ltx_document p.ltx_p',
    '.ltx_document p',
    '.ltx_document blockquote.ltx_quote',
    '.ltx_document li.ltx_item',
    '.ltx_document .ltx_theorem',
    '.ltx_document .ltx_proof',
    '.ltx_document .ltx_quote',
    '.ltx_document .ltx_table',
    '.ltx_document table',
  ].join(',');
}

function getArticleRoot() {
  if (isOpenReviewForumPage()) {
    return document.querySelector('.forum-container');
  }

  return document.querySelector('.ltx_document');
}

function getOpenReviewFieldName(element: HTMLElement) {
  const fieldAnchor = getOpenReviewValueElement(element) || element;
  let sibling: ChildNode | null = fieldAnchor.previousSibling;
  while (sibling) {
    if (sibling instanceof HTMLElement && sibling.classList.contains('note-content-field')) {
      return normalizeText(sibling.textContent || '').replace(/:$/, '').trim();
    }
    sibling = sibling.previousSibling;
  }

  const field = fieldAnchor.parentElement?.querySelector<HTMLElement>('.note-content-field') ||
    fieldAnchor.closest('.note-content')?.querySelector<HTMLElement>('.note-content-field');
  return field ? normalizeText(field.textContent || '').replace(/:$/, '').trim() : '';
}

function normalizeOpenReviewFieldName(fieldName: string) {
  return fieldName.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isOpenReviewFieldExcluded(element: HTMLElement) {
  if (!isOpenReviewForumPage()) return false;

  const fieldName = getOpenReviewFieldName(element);
  if (!fieldName) return false;
  return OPENREVIEW_EXCLUDED_FIELDS.has(normalizeOpenReviewFieldName(fieldName));
}

function getOrCreateHost(element: HTMLElement) {
  const next = element.nextElementSibling;
  if (next instanceof HTMLDivElement && next.dataset.linkualArticleHost === 'true') {
    return next;
  }

  const host = document.createElement('div');
  host.className = HOST_CLASS;
  host.dataset.linkualArticleHost = 'true';
  element.insertAdjacentElement('afterend', host);
  return host;
}

function canonicalizeCandidateElement(element: HTMLElement) {
  if (isArxivHtmlPage()) {
    const tableWrapper = element.closest('.ltx_table');
    if (tableWrapper instanceof HTMLElement) return tableWrapper;

    const paragraphWrapper = element.closest('.ltx_para');
    if (paragraphWrapper instanceof HTMLElement) return paragraphWrapper;
  }

  return element;
}

function hasNestedTextCandidate(element: HTMLElement, candidates: HTMLElement[]) {
  return candidates.some((candidate) => (
    candidate !== element &&
    element.contains(candidate) &&
    !isTranslatableTableElement(candidate)
  ));
}

function shouldSkipNestedCandidate(element: HTMLElement, candidates: HTMLElement[]) {
  if (isOpenReviewForumPage() && isTranslatableTableElement(element)) {
    const value = getOpenReviewValueElement(element);
    if (value && value !== element && candidates.includes(value) && !hasNestedTextCandidate(value, candidates)) {
      return true;
    }
  }

  return !isTranslatableTableElement(element) && hasNestedTextCandidate(element, candidates);
}

function collectCandidateElements(root: Element) {
  const elements = Array.from(root.querySelectorAll<HTMLElement>(getCandidateSelector()))
    .map(canonicalizeCandidateElement);
  const uniqueElements = Array.from(new Set(elements));
  return uniqueElements.filter((element) => !shouldSkipNestedCandidate(element, uniqueElements));
}

export function collectArticleParagraphs(): ArticleParagraph[] {
  if (!isArticleTranslationSupportedPage()) return [];

  const root = getArticleRoot();
  if (!root) return [];

  const candidates = collectCandidateElements(root)
    .filter((element) => !isExcluded(element) && !isOpenReviewFieldExcluded(element))
    .map((element) => ({ element, text: elementToTranslatableText(element) }))
    .filter(({ element, text }) => (
      text.length >= MIN_PARAGRAPH_LENGTH &&
      (isTranslatableTableElement(element) || !element.querySelector(BLOCKING_DESCENDANT_SELECTOR))
    ));

  const seen = new Set<HTMLElement>();
  return candidates.slice(0, MAX_PARAGRAPHS).filter(({ element }) => {
    if (seen.has(element)) return false;
    seen.add(element);
    return true;
  }).map(({ element, text }, index) => ({
    id: `article-${index}-${hashText(text)}`,
    element,
    text,
    host: getOrCreateHost(element),
  }));
}

export function removeArticleTranslationHosts(keep: Set<HTMLDivElement> = new Set()) {
  document.querySelectorAll<HTMLDivElement>(`[data-linkual-article-host="true"]`).forEach((host) => {
    if (!keep.has(host)) host.remove();
  });
}

export function isArticleTranslationPage() {
  return collectArticleParagraphs().length > 0;
}
