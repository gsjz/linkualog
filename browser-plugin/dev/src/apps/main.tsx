import { createElement } from 'react';
import { createRoot, Root } from 'react-dom/client';
import App from './App';
import { getAdapter } from '../adapters';
import { isArticleTranslationSupportedPage, isOpenReviewHost } from '../services/articleTranslator';
import { injectLinkualAppStyles, injectLinkualPageStyles } from './styles';

declare const unsafeWindow: typeof window | undefined;

let rootInstance: Root | null = null;
let reactMountNode: HTMLElement | null = null;
let navigationRefreshTimer: number | null = null;

const LINKUAL_NAVIGATION_EVENT = 'linkual_navigation';
const LINKUAL_ROOT_ID = 'linkual-root';
const LINKUAL_ROOT_RECOVER_EVENT = 'linkual_root_recover';
const LINKUAL_CUSTOM_FULLSCREEN_CLASS = 'linkual-custom-fullscreen';
const LINKUAL_MOBILE_FULLSCREEN_FALLBACK_CLASS = 'linkual-mobile-fullscreen-fallback';

type BrowserFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  mozCancelFullScreen?: () => Promise<void> | void;
  msExitFullscreen?: () => Promise<void> | void;
};

const FULLSCREEN_CHANGE_EVENTS = [
  'fullscreenchange',
  'webkitfullscreenchange',
  'mozfullscreenchange',
  'MSFullscreenChange',
] as const;

function isYouTubeHost() {
  return /(^|\.)youtube(?:-nocookie)?\.com$/i.test(window.location.hostname);
}

function isGeminiHost() {
  return /(^|\.)gemini\.google\.com$/i.test(window.location.hostname) ||
    /(^|\.)bard\.google\.com$/i.test(window.location.hostname);
}

function shouldHookNavigation() {
  return isYouTubeHost() || isOpenReviewHost();
}

function getPageWindow() {
  try {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  } catch {
    return window;
  }
}

function isolateRoot(app: HTMLElement) {
  app.dataset.linkualRoot = 'true';
  app.style.setProperty('all', 'initial');
  app.style.display = 'block';
  app.style.position = 'fixed';
  app.style.left = '0';
  app.style.top = '0';
  app.style.width = '0';
  app.style.height = '0';
  app.style.margin = '0';
  app.style.padding = '0';
  app.style.border = '0';
  app.style.overflow = 'visible';
  app.style.zIndex = '2147483647';
  app.style.pointerEvents = 'none';
  app.style.background = 'transparent';
  app.style.colorScheme = 'normal';
  app.style.contain = 'style';
}

function getBrowserFullscreenElement() {
  const doc = document as BrowserFullscreenDocument;
  return document.fullscreenElement ||
    doc.webkitFullscreenElement ||
    doc.mozFullScreenElement ||
    doc.msFullscreenElement ||
    null;
}

function exitBrowserFullscreen() {
  const doc = document as BrowserFullscreenDocument;

  if (document.exitFullscreen) return document.exitFullscreen();
  if (doc.webkitExitFullscreen) return doc.webkitExitFullscreen();
  if (doc.mozCancelFullScreen) return doc.mozCancelFullScreen();
  if (doc.msExitFullscreen) return doc.msExitFullscreen();
}

function isPromiseLike(value: unknown): value is Promise<void> {
  return Boolean(value && typeof (value as Promise<void>).then === 'function');
}

function getRootHost() {
  const fullscreenElement = getBrowserFullscreenElement();
  if (fullscreenElement instanceof HTMLElement && fullscreenElement.isConnected) {
    return fullscreenElement;
  }

  return document.body;
}

function attachRootToActiveHost(app: HTMLElement) {
  const host = getRootHost();
  if (host && app.parentElement !== host) {
    host.append(app);
  }
}

function recoverLinkualRoot() {
  if (!document.body) return;

  const app = document.getElementById(LINKUAL_ROOT_ID);
  if (!app) {
    mountApp();
    return;
  }

  attachRootToActiveHost(app);
  isolateRoot(app);
}

function scheduleRootRecover() {
  recoverLinkualRoot();
  window.setTimeout(recoverLinkualRoot, 80);
  window.setTimeout(recoverLinkualRoot, 250);
}

function getShadowMount(app: HTMLElement) {
  const shadow = app.shadowRoot || app.attachShadow({ mode: 'open' });
  injectLinkualAppStyles(shadow);

  let mount = shadow.getElementById(LINKUAL_ROOT_ID) as HTMLElement | null;
  if (!mount) {
    mount = document.createElement('div');
    mount.id = LINKUAL_ROOT_ID;
    shadow.append(mount);
  }

  return mount;
}

function mountApp() {
  if (!document.body) return;

  let app = document.getElementById(LINKUAL_ROOT_ID);
  if (!app) {
    app = document.createElement('div');
    app.id = LINKUAL_ROOT_ID;
  }
  attachRootToActiveHost(app);
  isolateRoot(app);

  if (isArticleTranslationSupportedPage()) {
    injectLinkualPageStyles();
  }

  const nextMountNode = getShadowMount(app);
  const adapter = getAdapter();
  const appElement = createElement(App, { adapter });

  if (rootInstance && reactMountNode === nextMountNode) {
    rootInstance.render(appElement);
  } else {
    rootInstance?.unmount();
    reactMountNode = nextMountNode;
    rootInstance = createRoot(nextMountNode);
    rootInstance.render(appElement);
  }
}

function dispatchNavigationRefresh() {
  window.dispatchEvent(new Event(LINKUAL_NAVIGATION_EVENT));
  window.dispatchEvent(new Event('linkual_custom_layout_refresh'));
  window.dispatchEvent(new Event('resize'));
}

function clearCustomFullscreenState() {
  const root = document.documentElement;
  const hadCustomFullscreen = root.classList.contains(LINKUAL_CUSTOM_FULLSCREEN_CLASS) ||
    root.classList.contains(LINKUAL_MOBILE_FULLSCREEN_FALLBACK_CLASS);

  root.classList.remove(LINKUAL_CUSTOM_FULLSCREEN_CLASS);
  root.classList.remove(LINKUAL_MOBILE_FULLSCREEN_FALLBACK_CLASS);
  scheduleRootRecover();

  if (!hadCustomFullscreen) return;

  window.dispatchEvent(new Event('linkual_custom_fullscreen_changed'));
  window.dispatchEvent(new Event('linkual_custom_layout_refresh'));
  window.dispatchEvent(new Event('resize'));
}

function handleFullscreenHostChange() {
  if (!getBrowserFullscreenElement() && document.documentElement.classList.contains(LINKUAL_CUSTOM_FULLSCREEN_CLASS)) {
    clearCustomFullscreenState();
    return;
  }

  scheduleRootRecover();
}

function handleGlobalEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !document.documentElement.classList.contains(LINKUAL_CUSTOM_FULLSCREEN_CLASS)) return;

  event.preventDefault();
  event.stopPropagation();
  const browserFullscreenElement = getBrowserFullscreenElement();
  clearCustomFullscreenState();

  if (browserFullscreenElement) {
    const browserFullscreenAction = exitBrowserFullscreen();
    if (isPromiseLike(browserFullscreenAction)) {
      browserFullscreenAction.catch((error) => console.warn('[Linkual] 浏览器全屏退出失败', error));
    }
  }
}

function scheduleNavigationRefresh() {
  if (navigationRefreshTimer !== null) {
    window.clearTimeout(navigationRefreshTimer);
  }

  navigationRefreshTimer = window.setTimeout(() => {
    navigationRefreshTimer = null;
    mountApp();
    dispatchNavigationRefresh();
  }, 80);
}

function installNavigationHooks() {
  if (!shouldHookNavigation()) return;

  const pageWindow = getPageWindow() as Window & typeof globalThis & { __linkualNavigationHooked?: boolean };
  if (pageWindow.__linkualNavigationHooked) return;

  pageWindow.__linkualNavigationHooked = true;

  const wrapHistoryMethod = (methodName: 'pushState' | 'replaceState') => {
    const rawMethod = pageWindow.history?.[methodName];
    if (typeof rawMethod !== 'function') return;

    try {
      Object.defineProperty(pageWindow.history, methodName, {
        configurable: true,
        writable: true,
        value(...args: Parameters<History[typeof methodName]>) {
          const result = rawMethod.apply(this, args);
          scheduleNavigationRefresh();
          return result;
        },
      });
    } catch {}
  };

  wrapHistoryMethod('pushState');
  wrapHistoryMethod('replaceState');
  pageWindow.addEventListener('popstate', scheduleNavigationRefresh, true);
  pageWindow.addEventListener('hashchange', scheduleNavigationRefresh, true);
  window.addEventListener('pageshow', scheduleNavigationRefresh);
}

if (!isGeminiHost()) {
  if (window.self !== window.top) {
    throw new Error('[Linkual] 阻止在 iframe 中重复执行');
  }

  if (document.body) {
    mountApp();
  } else {
    document.addEventListener('DOMContentLoaded', mountApp);
  }

  if (shouldHookNavigation()) {
    installNavigationHooks();
    if (isYouTubeHost()) {
      window.addEventListener('yt-navigate-finish', scheduleNavigationRefresh);
    }
  }

  FULLSCREEN_CHANGE_EVENTS.forEach((eventName) => {
    document.addEventListener(eventName, handleFullscreenHostChange, true);
  });
  window.addEventListener('keydown', handleGlobalEscape, true);
  window.addEventListener('keyup', handleGlobalEscape, true);
  document.addEventListener('keydown', handleGlobalEscape, true);
  document.addEventListener('keyup', handleGlobalEscape, true);
  window.addEventListener(LINKUAL_ROOT_RECOVER_EVENT, scheduleRootRecover);

  if (shouldHookNavigation() || isArticleTranslationSupportedPage()) {
    const observer = new MutationObserver(() => {
      if (document.body && !document.getElementById(LINKUAL_ROOT_ID)) {
        console.log('[Linkual] 检测到根节点被意外移除，正在尝试恢复...');
        mountApp();
      } else {
        const app = document.getElementById(LINKUAL_ROOT_ID);
        if (app) attachRootToActiveHost(app);
      }
    });
    if (document.body) {
      observer.observe(document.documentElement, { childList: true, subtree: false });
      observer.observe(document.body, { childList: true, subtree: false });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.documentElement, { childList: true, subtree: false });
        observer.observe(document.body, { childList: true, subtree: false });
        installNavigationHooks();
      });
    }
  }
} else {
  console.info('[Linkual] Gemini 页面已禁用');
}
