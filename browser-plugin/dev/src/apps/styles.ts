import appCss from './App.css?raw';
import settingsCss from '../components/Settings.css?raw';

const STYLE_ID = 'linkual-app-style';

type StyleTarget = Document | ShadowRoot;

function getExistingStyle(target: StyleTarget) {
  return target.getElementById(STYLE_ID);
}

function appendStyle(target: StyleTarget, style: HTMLStyleElement) {
  if (target instanceof Document) {
    target.head.append(style);
  } else {
    target.append(style);
  }
}

function injectStyles(target: StyleTarget) {
  if (getExistingStyle(target)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `${settingsCss}\n${appCss}`;
  appendStyle(target, style);
}

export function injectLinkualAppStyles(target: ShadowRoot) {
  injectStyles(target);
}

export function injectLinkualPageStyles() {
  injectStyles(document);
}
