import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import App from './App';
import { getAdapter } from '../adapters';

if (window.self !== window.top) {
  throw new Error('[Linkual] 阻止在 iframe 中重复执行');
}

let rootInstance: Root | null = null;

function mountApp() {
  let app = document.getElementById('linkual-root');
  if (!app) {
    app = document.createElement('div');
    app.id = 'linkual-root';
    document.body.append(app);
  }
  
  const adapter = getAdapter();
  
  if (rootInstance) {
    rootInstance.render(<App adapter={adapter} />);
  } else {
    rootInstance = createRoot(app);
    rootInstance.render(<App adapter={adapter} />);
  }
}

if (document.body) {
  mountApp();
} else { 
  document.addEventListener('DOMContentLoaded', mountApp); 
}

window.addEventListener('yt-navigate-finish', mountApp);

const observer = new MutationObserver(() => {
  if (document.body && !document.getElementById('linkual-root')) {
    console.log('[Linkual] 检测到根节点被意外移除，正在尝试恢复...');
    mountApp();
  }
});
if (document.body) {
  observer.observe(document.body, { childList: true, subtree: false });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, { childList: true, subtree: false });
  });
}