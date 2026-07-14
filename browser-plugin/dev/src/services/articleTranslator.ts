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

export function isArxivHtmlPage() {
  return ARXIV_HOSTNAMES.has(window.location.hostname) && window.location.pathname.startsWith('/html/');
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
  return '.ltx_document p.ltx_p, .ltx_document p';
}

function getArticleRoot() {
  return document.querySelector('.ltx_document');
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
  if (!isArxivHtmlPage()) return [];

  const root = getArticleRoot();
  if (!root) return [];

  const candidates = Array.from(root.querySelectorAll<HTMLElement>(getCandidateSelector()))
    .filter((element) => !isExcluded(element))
    .map((element) => ({ element, text: normalizeText(element.innerText || element.textContent || '') }))
    .filter(({ element, text }) => (
      text.length >= MIN_PARAGRAPH_LENGTH &&
      !element.querySelector('img, video, iframe')
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
