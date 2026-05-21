import React, { useCallback, useEffect, useState } from 'react';
import TaskVisualizer from './components/TaskVisualizer';
import ConfigForm from './components/ConfigForm';
import VocabQueueWidget from './components/VocabQueueWidget';
import VocabularyWorkspace from './components/VocabularyWorkspace';
import { getVocabularyCategories } from './api/client';
import './App.css';

const MOBILE_MEDIA_QUERY = '(max-width: 820px)';
const DESKTOP_MINIMAL_MODE_KEY = 'linkualogDesktopMinimalMode';
const VALID_TABS = new Set(['tasks', 'vocabulary']);

const readIsMobileViewport = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
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
    editMode: false,
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
  const editMode = normalizeUrlBoolean(params.get('edit'));

  return {
    tab,
    hasMinimal: minimal !== null,
    minimal: minimal === true,
    editMode: editMode === true,
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

const writeUrlState = ({ tab, minimal, editMode, category, word }) => {
  if (typeof window === 'undefined') return;

  const params = new URLSearchParams();
  const normalizedTab = normalizeTab(tab) || 'tasks';
  if (normalizedTab !== 'tasks') params.set('tab', normalizedTab);
  if (minimal) params.set('minimal', '1');
  if (editMode) params.set('edit', '1');

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
  const [currentTab, setCurrentTab] = useState(initialUrlState.tab);
  const [defaultCategory, setDefaultCategory] = useState(() => String(localStorage.getItem('defaultCategory') || '').trim());
  const [categories, setCategories] = useState([]);
  const [vocabularyRouteState, setVocabularyRouteState] = useState(() => ({
    editMode: initialUrlState.editMode,
    category: initialUrlState.category,
    word: initialUrlState.word,
  }));
  const [vocabularyLaunchRequest, setVocabularyLaunchRequest] = useState(() => (
    buildVocabularyLaunchRequest(initialUrlState)
  ));
  const [isMobileViewport, setIsMobileViewport] = useState(readIsMobileViewport);
  const [preferDesktopMinimalMode, setPreferDesktopMinimalMode] = useState(() => (
    initialUrlState.hasMinimal ? initialUrlState.minimal : readDesktopMinimalMode()
  ));
  const useDesktopMinimalMode = !isMobileViewport && preferDesktopMinimalMode;
  const usesCompactLayout = isMobileViewport || useDesktopMinimalMode;
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

    const media = window.matchMedia(MOBILE_MEDIA_QUERY);
    const handleChange = (event) => {
      setIsMobileViewport(event.matches);
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
        editMode: nextState.editMode,
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
      editMode: vocabularyRouteState.editMode,
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

  const handleVocabularyEditModeChange = useCallback((nextEditMode) => {
    setVocabularyRouteState((prev) => ({
      ...prev,
      editMode: Boolean(nextEditMode),
    }));
  }, []);

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
    setCurrentTab('tasks');
    setPreferDesktopMinimalMode(false);
    setVocabularyRouteState({
      editMode: false,
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

  return (
    <div className={`master-shell${useDesktopMinimalMode ? ' is-desktop-minimal' : ''}`}>
      {!usesCompactLayout ? <VocabQueueWidget /> : null}

      <header className="master-header">
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
              onClick={() => setCurrentTab('tasks')}
              className={`master-tab${currentTab === 'tasks' ? ' active' : ''}`}
            >
              {usesCompactLayout ? '上传文件' : 'OCR 解析库'}
            </button>
            <button
              onClick={() => setCurrentTab('vocabulary')}
              className={`master-tab${currentTab === 'vocabulary' ? ' active' : ''}`}
            >
              {usesCompactLayout ? '词库工作台' : '我的生词本'}
            </button>
          </div>
        </div>

        {!isMobileViewport ? (
          <div className={`master-actions${useDesktopMinimalMode ? ' is-compact-layout' : ''}`}>
            <button
              type="button"
              onClick={handleDesktopMinimalModeToggle}
              aria-pressed={useDesktopMinimalMode}
              className={`master-secondary-button master-layout-toggle${useDesktopMinimalMode ? ' is-active' : ''}`}
            >
              {useDesktopMinimalMode ? '退出极简' : '极简模式'}
            </button>

            {!useDesktopMinimalMode ? (
              <label className="master-select-label">
                默认生词本目录
                <select
                  value={defaultCategory}
                  onChange={(e) => handleDefaultCategoryChange(e.target.value)}
                  className="master-select"
                >
                  <option value="">请选择目录</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            ) : null}

            {!useDesktopMinimalMode ? (
              <button
                onClick={() => setShowConfig(true)}
                className="master-primary-button"
              >
                全局配置
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {showConfig && !isMobileViewport ? <ConfigForm onClose={() => setShowConfig(false)} categories={categories} /> : null}

      <main className="app-main">
        <div className="task-container-wrapper">
          <div
            className={`master-pane${currentTab === 'tasks' ? ' is-active' : ''}`}
            aria-hidden={currentTab !== 'tasks'}
          >
            <TaskVisualizer onOpenVocabularyEntry={handleOpenVocabularyEntry} simpleCreateOnly={usesCompactLayout} />
          </div>
          <div
            className={`master-pane${currentTab === 'vocabulary' ? ' is-active' : ''}`}
            aria-hidden={currentTab !== 'vocabulary'}
          >
            <VocabularyWorkspace
              editMode={vocabularyRouteState.editMode}
              currentSelection={vocabularyRouteState}
              launchRequest={vocabularyLaunchRequest}
              mobileSimple={usesCompactLayout}
              compactDesktop={useDesktopMinimalMode}
              onOpenConfig={() => setShowConfig(true)}
              onEditModeChange={handleVocabularyEditModeChange}
              onSelectionChange={handleVocabularySelectionChange}
            />
          </div>
        </div>
      </main>

    </div>
  );
}

export default App;
