import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import App from './App';
import { getAdapter } from '../adapters';

declare const unsafeWindow: typeof window | undefined;

if (window.self !== window.top) {
  throw new Error('[Linkual] 阻止在 iframe 中重复执行');
}

let rootInstance: Root | null = null;
let navigationRefreshTimer: number | null = null;

const LINKUAL_NAVIGATION_EVENT = 'linkual_navigation';

function isYouTubeHost() {
  return /(^|\.)youtube(?:-nocookie)?\.com$/i.test(window.location.hostname);
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
}

function getRootHost() {
  const fullscreenElement = document.fullscreenElement;
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

function mountApp() {
  if (!document.body) return;

  let app = document.getElementById('linkual-root');
  if (!app) {
    app = document.createElement('div');
    app.id = 'linkual-root';
  }
  attachRootToActiveHost(app);
  isolateRoot(app);
  
  const adapter = getAdapter();
  
  if (rootInstance) {
    rootInstance.render(<App adapter={adapter} />);
  } else {
    rootInstance = createRoot(app);
    rootInstance.render(<App adapter={adapter} />);
  }
}

function dispatchNavigationRefresh() {
  window.dispatchEvent(new Event(LINKUAL_NAVIGATION_EVENT));
  window.dispatchEvent(new Event('linkual_custom_layout_refresh'));
  window.dispatchEvent(new Event('resize'));
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
  if (!isYouTubeHost()) return;

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

if (document.body) {
  mountApp();
} else { 
  document.addEventListener('DOMContentLoaded', mountApp); 
}

if (isYouTubeHost()) {
  installNavigationHooks();
  window.addEventListener('yt-navigate-finish', scheduleNavigationRefresh);
}
document.addEventListener('fullscreenchange', () => {
  const app = document.getElementById('linkual-root');
  if (app) attachRootToActiveHost(app);
});

const observer = new MutationObserver(() => {
  if (document.body && !document.getElementById('linkual-root')) {
    console.log('[Linkual] 检测到根节点被意外移除，正在尝试恢复...');
    mountApp();
  } else {
    const app = document.getElementById('linkual-root');
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
