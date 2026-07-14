import appCss from './App.css?raw';
import settingsCss from '../components/Settings.css?raw';

const STYLE_ID = 'linkual-app-style';

export function injectLinkualAppStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `${settingsCss}\n${appCss}`;
  document.head.append(style);
}
