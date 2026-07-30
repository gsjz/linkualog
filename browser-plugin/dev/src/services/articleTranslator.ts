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

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();

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

function hashText(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function isExcluded(element: HTMLElement) {
  return Boolean(element.closest(EXCLUDED_SELECTOR)) || Boolean(element.closest('[data-linkual-article-host]'));
}

function getCandidateSelector() {
  if (isOpenReviewForumPage()) {
    return '.note-content .note-content-value';
  }

  return '.ltx_document p.ltx_p, .ltx_document p';
}

function getArticleRoot() {
  if (isOpenReviewForumPage()) {
    return document.querySelector('.forum-container');
  }

  return document.querySelector('.ltx_document');
}

function getOpenReviewFieldName(element: HTMLElement) {
  let sibling: ChildNode | null = element.previousSibling;
  while (sibling) {
    if (sibling instanceof HTMLElement && sibling.classList.contains('note-content-field')) {
      return normalizeText(sibling.textContent || '').replace(/:$/, '').trim();
    }
    sibling = sibling.previousSibling;
  }

  const field = element.parentElement?.querySelector<HTMLElement>('.note-content-field');
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

export function collectArticleParagraphs(): ArticleParagraph[] {
  if (!isArticleTranslationSupportedPage()) return [];

  const root = getArticleRoot();
  if (!root) return [];

  const candidates = Array.from(root.querySelectorAll<HTMLElement>(getCandidateSelector()))
    .filter((element) => !isExcluded(element) && !isOpenReviewFieldExcluded(element))
    .map((element) => ({ element, text: normalizeText(element.innerText || element.textContent || '') }))
    .filter(({ element, text }) => (
      text.length >= MIN_PARAGRAPH_LENGTH &&
      !element.querySelector('img, video, iframe, canvas, textarea, input, select, button, pre, code, .CodeMirror, .monaco-editor')
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
