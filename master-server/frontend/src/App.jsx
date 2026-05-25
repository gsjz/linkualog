import React, { useCallback, useEffect, useState } from 'react';
import TaskVisualizer from './components/TaskVisualizer';
import ConfigForm from './components/ConfigForm';
import VocabularyWorkspace from './components/VocabularyWorkspace';
import UiIcon from './components/UiIcon';
import { getVocabularyCategories } from './api/client';
import './App.css';

const COMPACT_LAYOUT_MEDIA_QUERY = '(max-width: 1180px)';
const DESKTOP_MINIMAL_MODE_KEY = 'linkualogDesktopMinimalMode';
const VALID_TABS = new Set(['tasks', 'vocabulary']);
const MOBILE_TOOLS_PANEL_ID = 'master-mobile-tools-panel';

const readUsesCompactViewport = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(COMPACT_LAYOUT_MEDIA_QUERY).matches;
};

const readDesktopMinimalMode = () => {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(DESKTOP_MINIMAL_MODE_KEY) === '1';
};

const normalizeTab = (value) => {
  const normalized = String(value || '').trim();
  return VALID_TABS.has(normalized) ? normalized : '';
};

const normalizeUrlBoolean = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
};

const normalizeUrlPart = (value) => String(value || '').trim();

const normalizeUrlWord = (value) => normalizeUrlPart(value).replace(/\.json$/i, '');

const safeDecodePathPart = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const readUrlState = () => {
  const fallback = {
    tab: 'tasks',
    hasMinimal: false,
    minimal: false,
    category: '',
    word: '',
  };

  if (typeof window === 'undefined') return fallback;

  const url = new URL(window.location.href);
  const params = url.searchParams;
  const pathParts = url.pathname
    .split('/')
    .filter(Boolean)
    .map(safeDecodePathPart);
  const pathTab = normalizeTab(pathParts[0]);
  const tab = normalizeTab(params.get('tab')) || pathTab || fallback.tab;
  const minimal = normalizeUrlBoolean(params.get('minimal'));

  return {
    tab,
    hasMinimal: minimal !== null,
    minimal: minimal === true,
    category: normalizeUrlPart(params.get('cat') || params.get('category') || (tab === 'vocabulary' ? pathParts[1] : '')),
    word: normalizeUrlWord(params.get('word') || (tab === 'vocabulary' ? pathParts[2] : '')),
  };
};

const buildVocabularyLaunchRequest = ({ category = '', word = '' } = {}) => {
  const normalizedWord = normalizeUrlWord(word);
  if (!normalizedWord) return null;

  return {
    category: normalizeUrlPart(category),
    word: normalizedWord,
    fileKey: normalizedWord,
  };
};

const writeUrlState = ({ tab, minimal, category, word }) => {
  if (typeof window === 'undefined') return;

  const params = new URLSearchParams();
  const normalizedTab = normalizeTab(tab) || 'tasks';
  if (normalizedTab !== 'tasks') params.set('tab', normalizedTab);
  if (minimal) params.set('minimal', '1');

  const normalizedCategory = normalizeUrlPart(category);
  const normalizedWord = normalizeUrlWord(word);
  if (normalizedCategory) params.set('cat', normalizedCategory);
  if (normalizedWord) params.set('word', normalizedWord);

  const nextUrl = `/${params.toString() ? `?${params.toString()}` : ''}`;
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (currentUrl !== nextUrl) {
    window.history.replaceState({ linkualog: true }, '', nextUrl);
  }
};

function App() {
  const [initialUrlState] = useState(readUrlState);
  const [showConfig, setShowConfig] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [currentTab, setCurrentTab] = useState(initialUrlState.tab);
  const [defaultCategory, setDefaultCategory] = useState(() => String(localStorage.getItem('defaultCategory') || '').trim());
  const [categories, setCategories] = useState([]);
  const [vocabularyRouteState, setVocabularyRouteState] = useState(() => ({
    category: initialUrlState.category,
    word: initialUrlState.word,
  }));
  const [vocabularyLaunchRequest, setVocabularyLaunchRequest] = useState(() => (
    buildVocabularyLaunchRequest(initialUrlState)
  ));
  const [usesCompactViewport, setUsesCompactViewport] = useState(readUsesCompactViewport);
  const [preferDesktopMinimalMode, setPreferDesktopMinimalMode] = useState(() => (
    initialUrlState.hasMinimal ? initialUrlState.minimal : readDesktopMinimalMode()
  ));
  const useDesktopMinimalMode = !usesCompactViewport && preferDesktopMinimalMode;
  const usesCompactLayout = usesCompactViewport || useDesktopMinimalMode;
  const brandSubtitle = useDesktopMinimalMode
    ? 'Desktop Study'
    : (usesCompactLayout ? 'Mobile Study' : 'Master Server Workspace');

  useEffect(() => {
    getVocabularyCategories()
      .then((data) => setCategories(data.categories || []))
      .catch(() => {});

    const handleDefaultCategoryUpdate = (e) => {
      const fromEvent = e?.detail?.category;
      if (typeof fromEvent === 'string') {
        setDefaultCategory(String(fromEvent || '').trim());
      } else {
        setDefaultCategory(String(localStorage.getItem('defaultCategory') || '').trim());
      }
    };

    window.addEventListener('default-category-updated', handleDefaultCategoryUpdate);
    return () => window.removeEventListener('default-category-updated', handleDefaultCategoryUpdate);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

    const media = window.matchMedia(COMPACT_LAYOUT_MEDIA_QUERY);
    const handleChange = (event) => {
      setUsesCompactViewport(event.matches);
      if (!event.matches) {
        setMobileToolsOpen(false);
      }
    };

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handleChange);
      return () => media.removeEventListener('change', handleChange);
    }

    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(DESKTOP_MINIMAL_MODE_KEY, preferDesktopMinimalMode ? '1' : '0');
  }, [preferDesktopMinimalMode]);

  useEffect(() => {
    const handlePopState = () => {
      const nextState = readUrlState();
      setCurrentTab(nextState.tab);
      setPreferDesktopMinimalMode(nextState.hasMinimal ? nextState.minimal : readDesktopMinimalMode());
      setVocabularyRouteState({
        category: nextState.category,
        word: nextState.word,
      });
      setVocabularyLaunchRequest(buildVocabularyLaunchRequest(nextState));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    writeUrlState({
      tab: currentTab,
      minimal: preferDesktopMinimalMode,
      category: vocabularyRouteState.category,
      word: vocabularyRouteState.word,
    });
  }, [currentTab, preferDesktopMinimalMode, vocabularyRouteState]);

  const handleDefaultCategoryChange = (nextCategory) => {
    const finalCategory = String(nextCategory || '').trim();
    localStorage.setItem('defaultCategory', finalCategory);
    setDefaultCategory(finalCategory);
    window.dispatchEvent(new Event('config-updated'));
    window.dispatchEvent(new CustomEvent('default-category-updated', {
      detail: { category: finalCategory }
    }));
  };

  const handleOpenVocabularyEntry = ({ category = '', word = '', fileKey = '' }) => {
    const normalizedFileKey = String(fileKey || '').trim().replace(/\.json$/i, '');
    const normalizedWord = String(word || '').trim().replace(/\.json$/i, '');
    const lookupWord = normalizedFileKey || normalizedWord;
    if (!lookupWord) return;

    const nextCategory = String(category || '').trim();
    setVocabularyLaunchRequest({
      category: nextCategory,
      word: normalizedWord || lookupWord,
      fileKey: lookupWord,
    });
    setVocabularyRouteState((prev) => ({
      ...prev,
      category: nextCategory,
      word: lookupWord,
    }));
    setCurrentTab('vocabulary');
  };

  const handleVocabularySelectionChange = useCallback((selection) => {
    const nextCategory = normalizeUrlPart(selection?.category);
    const nextWord = normalizeUrlWord(selection?.word || selection?.fileKey || selection?.filename);
    setVocabularyRouteState((prev) => {
      if (prev.category === nextCategory && prev.word === nextWord) return prev;
      return {
        ...prev,
        category: nextCategory,
        word: nextWord,
      };
    });
  }, []);

  const handleBrandReset = useCallback(() => {
    setShowConfig(false);
    setMobileToolsOpen(false);
    setCurrentTab('tasks');
    setPreferDesktopMinimalMode(false);
    setVocabularyRouteState({
      category: '',
      word: '',
    });
    setVocabularyLaunchRequest(null);
    if (typeof window !== 'undefined') {
      window.history.pushState({ linkualog: true }, '', '/');
    }
  }, []);

  const handleDesktopMinimalModeToggle = useCallback(() => {
    const nextEnabled = !preferDesktopMinimalMode;
    setPreferDesktopMinimalMode(nextEnabled);
    if (nextEnabled) {
      setShowConfig(false);
      setCurrentTab('vocabulary');
    }
  }, [preferDesktopMinimalMode]);

  const handleTabChange = useCallback((nextTab) => {
    setCurrentTab(nextTab);
    setMobileToolsOpen(false);
  }, []);

  const handleOpenConfig = useCallback(() => {
    setMobileToolsOpen(false);
    setShowConfig(true);
  }, []);

  return (
    <div className={`master-shell${useDesktopMinimalMode ? ' is-desktop-minimal' : ''}`}>
      <header className={`master-header${mobileToolsOpen ? ' has-mobile-tools-open' : ''}`}>
        <div className="master-brand-wrap">
          <button
            type="button"
            className="master-brand-block master-brand-button"
            onClick={handleBrandReset}
            aria-label="回到 Linkual Log 首页"
          >
            <span className="master-brand">Linkual Log</span>
            <div className="master-brand-subtitle">{brandSubtitle}</div>
          </button>

          <div className="master-tabs">
            <button
              onClick={() => handleTabChange('tasks')}
              aria-label="打开上传文件"
              className={`master-tab${currentTab === 'tasks' ? ' active' : ''}`}
            >
              <span className="master-tab-icon">
                <UiIcon name="upload" size={17} />
              </span>
              <span className="master-tab-label">{usesCompactLayout ? '上传' : '上传中心'}</span>
            </button>
            <button
              onClick={() => handleTabChange('vocabulary')}
              aria-label="打开词库工作台"
              className={`master-tab${currentTab === 'vocabulary' ? ' active' : ''}`}
            >
              <span className="master-tab-icon">
                <UiIcon name="book" size={17} />
              </span>
              <span className="master-tab-label">{usesCompactLayout ? '词库' : '我的生词本'}</span>
            </button>
          </div>
        </div>

        <div className={`master-actions${useDesktopMinimalMode ? ' is-compact-layout' : ''}${usesCompactViewport ? ' is-mobile-actions' : ''}`}>
          {usesCompactViewport ? (
            <>
              <button
                type="button"
                onClick={() => setMobileToolsOpen((open) => !open)}
                className={`master-icon-button master-mobile-tools-trigger${mobileToolsOpen ? ' is-active' : ''}`}
                aria-label="打开工具设置"
                aria-expanded={mobileToolsOpen}
                aria-controls={MOBILE_TOOLS_PANEL_ID}
              >
                <UiIcon name="sliders" size={18} />
              </button>

              {mobileToolsOpen ? (
                <div className="master-mobile-tools-layer" role="presentation">
                  <button
                    type="button"
                    className="master-mobile-tools-backdrop"
                    aria-label="关闭工具设置"
                    onClick={() => setMobileToolsOpen(false)}
                  />
                  <section
                    className="master-mobile-tools-panel"
                    id={MOBILE_TOOLS_PANEL_ID}
                    role="dialog"
                    aria-modal="false"
                    aria-label="工具设置"
                  >
                    <div className="master-mobile-tools-header">
                      <div>
                        <div className="master-mobile-tools-title">工具</div>
                        <div className="master-mobile-tools-caption">全局设置</div>
                      </div>
                      <button
                        type="button"
                        className="master-icon-button master-mobile-tools-close"
                        aria-label="关闭工具设置"
                        onClick={() => setMobileToolsOpen(false)}
                      >
                        <UiIcon name="close" size={17} />
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={handleOpenConfig}
                      className="master-primary-button master-mobile-config-button"
                    >
                      全局配置
                    </button>
                  </section>
                </div>
              ) : null}
            </>
          ) : (
            <>
            <button
              type="button"
              onClick={handleDesktopMinimalModeToggle}
              aria-pressed={useDesktopMinimalMode}
              className={`master-secondary-button master-layout-toggle${useDesktopMinimalMode ? ' is-active' : ''}`}
            >
              {useDesktopMinimalMode ? '退出极简' : '极简模式'}
            </button>

            {!useDesktopMinimalMode ? (
              <button
                onClick={handleOpenConfig}
                className="master-primary-button"
              >
                全局配置
              </button>
            ) : null}
            </>
          )}
        </div>
      </header>

      {showConfig ? <ConfigForm onClose={() => setShowConfig(false)} categories={categories} /> : null}

      <main className="app-main">
        <div className="task-container-wrapper">
          <div
            className={`master-pane${currentTab === 'tasks' ? ' is-active' : ''}`}
            aria-hidden={currentTab !== 'tasks'}
          >
            <TaskVisualizer
              onOpenVocabularyEntry={handleOpenVocabularyEntry}
              simpleCreateOnly={usesCompactLayout}
              isActive={currentTab === 'tasks'}
              categories={categories}
              defaultCategory={defaultCategory}
              onDefaultCategoryChange={handleDefaultCategoryChange}
            />
          </div>
          <div
            className={`master-pane${currentTab === 'vocabulary' ? ' is-active' : ''}`}
            aria-hidden={currentTab !== 'vocabulary'}
          >
            <VocabularyWorkspace
              currentSelection={vocabularyRouteState}
              launchRequest={vocabularyLaunchRequest}
              mobileSimple={usesCompactLayout}
              compactDesktop={useDesktopMinimalMode}
              onOpenConfig={handleOpenConfig}
              onSelectionChange={handleVocabularySelectionChange}
            />
          </div>
        </div>
      </main>

    </div>
  );
}

export default App;
