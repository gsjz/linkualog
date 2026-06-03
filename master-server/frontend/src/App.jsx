import React, { useCallback, useEffect, useState } from 'react';
import TaskVisualizer from './components/TaskVisualizer';
import ConfigForm from './components/ConfigForm';
import VocabularyWorkspace from './components/VocabularyWorkspace';
import VisualizationDashboard from './components/VisualizationDashboard';
import UiIcon from './components/UiIcon';
import { getVocabularyCategories } from './api/client';
import './App.css';

const COMPACT_LAYOUT_MEDIA_QUERY = '(max-width: 1180px)';
const DESKTOP_MINIMAL_MODE_KEY = 'linkualogDesktopMinimalMode';
const VALID_TABS = new Set(['tasks', 'vocabulary', 'visualization']);
const DEFAULT_TAB = 'visualization';
const MOBILE_TOOLS_PANEL_ID = 'master-mobile-tools-panel';
const ADD_VOCAB_CATEGORY_KEY = 'addVocabularyCategory';
const ADD_VOCAB_CATEGORY_EVENT = 'add-vocabulary-category-updated';
const LEGACY_UPLOAD_DEFAULT_CATEGORY_KEY = 'uploadDefaultCategory';
const LEGACY_DEFAULT_CATEGORY_KEY = 'defaultCategory';

const readUsesCompactViewport = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(COMPACT_LAYOUT_MEDIA_QUERY).matches;
};

const readDesktopMinimalMode = () => {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(DESKTOP_MINIMAL_MODE_KEY) === '1';
};

const readAddVocabularyCategory = () => {
  if (typeof window === 'undefined') return '';
  const storedAddCategory = localStorage.getItem(ADD_VOCAB_CATEGORY_KEY);
  if (storedAddCategory !== null) return String(storedAddCategory || '').trim();
  const storedUploadCategory = localStorage.getItem(LEGACY_UPLOAD_DEFAULT_CATEGORY_KEY);
  if (storedUploadCategory !== null) return String(storedUploadCategory || '').trim();
  return String(localStorage.getItem(LEGACY_DEFAULT_CATEGORY_KEY) || '').trim();
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

const getFullscreenElement = () => {
  if (typeof document === 'undefined') return null;
  return document.fullscreenElement
    || document.webkitFullscreenElement
    || document.mozFullScreenElement
    || document.msFullscreenElement
    || null;
};

const requestFullscreen = (element) => {
  if (!element) return Promise.reject(new Error('Fullscreen target is not available.'));
  const request = element.requestFullscreen
    || element.webkitRequestFullscreen
    || element.mozRequestFullScreen
    || element.msRequestFullscreen;
  if (!request) return Promise.reject(new Error('Fullscreen is not supported by this browser.'));
  return Promise.resolve(request.call(element));
};

const exitFullscreen = () => {
  if (typeof document === 'undefined') return Promise.resolve();
  const exit = document.exitFullscreen
    || document.webkitExitFullscreen
    || document.mozCancelFullScreen
    || document.msExitFullscreen;
  if (!exit) return Promise.reject(new Error('Fullscreen exit is not supported by this browser.'));
  return Promise.resolve(exit.call(document));
};

const safeDecodePathPart = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const readUrlState = () => {
  const fallback = {
    tab: DEFAULT_TAB,
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
  const normalizedTab = normalizeTab(tab) || DEFAULT_TAB;
  if (normalizedTab !== DEFAULT_TAB) params.set('tab', normalizedTab);
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
  const [addVocabularyCategory, setAddVocabularyCategory] = useState(readAddVocabularyCategory);
  const [categories, setCategories] = useState([]);
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(getFullscreenElement()));
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
        setAddVocabularyCategory(String(fromEvent || '').trim());
      } else {
        setAddVocabularyCategory(readAddVocabularyCategory());
      }
    };

    window.addEventListener(ADD_VOCAB_CATEGORY_EVENT, handleDefaultCategoryUpdate);
    return () => window.removeEventListener(ADD_VOCAB_CATEGORY_EVENT, handleDefaultCategoryUpdate);
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
    if (typeof document === 'undefined') return undefined;

    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(getFullscreenElement()));
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    handleFullscreenChange();

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);

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

  const handleAddVocabularyCategoryChange = (nextCategory) => {
    const finalCategory = String(nextCategory || '').trim();
    localStorage.setItem(ADD_VOCAB_CATEGORY_KEY, finalCategory);
    localStorage.removeItem(LEGACY_UPLOAD_DEFAULT_CATEGORY_KEY);
    setAddVocabularyCategory(finalCategory);
    window.dispatchEvent(new CustomEvent(ADD_VOCAB_CATEGORY_EVENT, {
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
    setCurrentTab(DEFAULT_TAB);
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

  const handleOpenTodo = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.location.assign('/todo');
  }, []);

  const handleFullscreenToggle = useCallback(() => {
    if (typeof document === 'undefined') return;

    const fullscreenElement = getFullscreenElement();
    const action = fullscreenElement
      ? exitFullscreen()
      : requestFullscreen(document.documentElement);

    action
      .then(() => {
        setMobileToolsOpen(false);
      })
      .catch(() => {});
  }, []);

  const fullscreenLabel = isFullscreen ? '退出全屏' : '全屏';
  const fullscreenAriaLabel = isFullscreen ? '退出全屏显示' : '进入全屏显示';
  const fullscreenIconName = isFullscreen ? 'fullscreen-exit' : 'fullscreen';

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
              onClick={() => handleTabChange('visualization')}
              aria-label="打开可视化"
              className={`master-tab${currentTab === 'visualization' ? ' active' : ''}`}
            >
              <span className="master-tab-icon">
                <UiIcon name="chart" size={17} />
              </span>
              <span className="master-tab-label">可视化</span>
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
              type="button"
              onClick={handleOpenTodo}
              aria-label="打开待办页面"
              className="master-tab"
            >
              <span className="master-tab-icon">
                <UiIcon name="todo" size={17} />
              </span>
              <span className="master-tab-label">{usesCompactLayout ? '待办' : '待办事项'}</span>
            </button>
          </div>
        </div>

        <div className={`master-actions${useDesktopMinimalMode ? ' is-compact-layout' : ''}${usesCompactViewport ? ' is-mobile-actions' : ''}`}>
          {usesCompactViewport ? (
            <>
              <button
                type="button"
                onClick={handleFullscreenToggle}
                className={`master-icon-button master-fullscreen-button${isFullscreen ? ' is-active' : ''}`}
                aria-label={fullscreenAriaLabel}
                aria-pressed={isFullscreen}
                title={fullscreenAriaLabel}
              >
                <UiIcon name={fullscreenIconName} size={18} />
              </button>

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

                    <button
                      type="button"
                      onClick={handleFullscreenToggle}
                      className={`master-secondary-button master-mobile-fullscreen-button${isFullscreen ? ' is-active' : ''}`}
                      aria-pressed={isFullscreen}
                    >
                      <UiIcon name={fullscreenIconName} size={17} />
                      <span>{fullscreenLabel}</span>
                    </button>
                  </section>
                </div>
              ) : null}
            </>
          ) : (
            <>
            <button
              type="button"
              onClick={handleFullscreenToggle}
              aria-pressed={isFullscreen}
              aria-label={fullscreenAriaLabel}
              className={`master-secondary-button master-fullscreen-button${isFullscreen ? ' is-active' : ''}`}
              title={fullscreenAriaLabel}
            >
              <UiIcon name={fullscreenIconName} size={17} />
              <span>{fullscreenLabel}</span>
            </button>

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

      {showConfig ? <ConfigForm onClose={() => setShowConfig(false)} /> : null}

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
              addVocabularyCategory={addVocabularyCategory}
              onAddVocabularyCategoryChange={handleAddVocabularyCategoryChange}
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
          <div
            className={`master-pane${currentTab === 'visualization' ? ' is-active' : ''}`}
            aria-hidden={currentTab !== 'visualization'}
          >
            <VisualizationDashboard
              categories={categories}
              onOpenVocabularyEntry={handleOpenVocabularyEntry}
            />
          </div>
        </div>
      </main>

    </div>
  );
}

export default App;
