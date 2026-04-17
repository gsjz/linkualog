import React, { useState, useEffect } from 'react';
import TaskVisualizer from './components/TaskVisualizer';
import ConfigForm from './components/ConfigForm';
import VocabularyReview from './components/VocabularyReview'; 
import VocabQueueWidget from './components/VocabQueueWidget'; 
import ReviewWorkspace from './review/App.jsx';
import { getVocabularyCategories } from './api/client';
import './App.css';

const MOBILE_MEDIA_QUERY = '(max-width: 820px)';
const DESKTOP_MINIMAL_MODE_KEY = 'linkualogDesktopMinimalMode';

const readIsMobileViewport = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
};

const readDesktopMinimalMode = () => {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(DESKTOP_MINIMAL_MODE_KEY) === '1';
};

function App() {
  const [showConfig, setShowConfig] = useState(false);
  const [currentTab, setCurrentTab] = useState('tasks');
  const [defaultCategory, setDefaultCategory] = useState(() => String(localStorage.getItem('defaultCategory') || '').trim());
  const [categories, setCategories] = useState([]);
  const [reviewLaunchRequest, setReviewLaunchRequest] = useState(null);
  const [vocabularyLaunchRequest, setVocabularyLaunchRequest] = useState(null);
  const [isMobileViewport, setIsMobileViewport] = useState(readIsMobileViewport);
  const [preferDesktopMinimalMode, setPreferDesktopMinimalMode] = useState(readDesktopMinimalMode);
  const useDesktopMinimalMode = !isMobileViewport && preferDesktopMinimalMode;
  const usesCompactLayout = isMobileViewport || useDesktopMinimalMode;

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

    setIsMobileViewport(media.matches);
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handleChange);
      return () => media.removeEventListener('change', handleChange);
    }

    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (usesCompactLayout && currentTab === 'review') {
      setCurrentTab('vocabulary');
    }
  }, [currentTab, usesCompactLayout]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(DESKTOP_MINIMAL_MODE_KEY, preferDesktopMinimalMode ? '1' : '0');
  }, [preferDesktopMinimalMode]);

  const handleDefaultCategoryChange = (nextCategory) => {
    const finalCategory = String(nextCategory || '').trim();
    localStorage.setItem('defaultCategory', finalCategory);
    setDefaultCategory(finalCategory);
    window.dispatchEvent(new Event('config-updated'));
    window.dispatchEvent(new CustomEvent('default-category-updated', {
      detail: { category: finalCategory }
    }));
  };

  const handleOpenReviewEntry = ({ category = '', word = '', focus = 'clean' }) => {
    const normalizedWord = String(word || '').trim();
    if (!normalizedWord) return;

    setReviewLaunchRequest({
      category: String(category || ''),
      filename: normalizedWord.endsWith('.json') ? normalizedWord : `${normalizedWord}.json`,
      focus: focus === 'review' ? 'review' : 'clean',
    });
    setCurrentTab('review');
  };

  const handleOpenVocabularyEntry = ({ category = '', word = '', fileKey = '' }) => {
    const normalizedFileKey = String(fileKey || '').trim().replace(/\.json$/i, '');
    const normalizedWord = String(word || '').trim().replace(/\.json$/i, '');
    const lookupWord = normalizedFileKey || normalizedWord;
    if (!lookupWord) return;

    setVocabularyLaunchRequest({
      category: String(category || ''),
      word: normalizedWord,
      fileKey: lookupWord,
    });
    setCurrentTab('vocabulary');
  };

  return (
    <div className="master-shell">
      {!usesCompactLayout ? <VocabQueueWidget /> : null}

      <header className="master-header">
        <div className="master-brand-wrap">
          <div className="master-brand-block">
            <h1 className="master-brand">Linkual Log</h1>
            <div className="master-brand-subtitle">{usesCompactLayout ? 'Mobile Study' : 'Master Server Workspace'}</div>
          </div>

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
              {usesCompactLayout ? '随机背词' : '我的生词本'}
            </button>
            {!usesCompactLayout ? (
              <button
                onClick={() => setCurrentTab('review')}
                className={`master-tab${currentTab === 'review' ? ' active' : ''}`}
              >
                精修与复习
              </button>
            ) : null}
          </div>
        </div>

        {!isMobileViewport ? (
          <div className={`master-actions${useDesktopMinimalMode ? ' is-compact-layout' : ''}`}>
            <button
              type="button"
              onClick={() => setPreferDesktopMinimalMode((prev) => !prev)}
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
            <VocabularyReview
              onOpenReviewEntry={handleOpenReviewEntry}
              launchRequest={vocabularyLaunchRequest}
              mobileSimple={usesCompactLayout}
              compactDesktop={useDesktopMinimalMode}
            />
          </div>
          {!usesCompactLayout ? (
            <div
              className={`master-pane master-pane-scroll${currentTab === 'review' ? ' is-active' : ''}`}
              aria-hidden={currentTab !== 'review'}
            >
              <ReviewWorkspace
                embedded
                onOpenConfig={() => setShowConfig(true)}
                launchRequest={reviewLaunchRequest}
              />
            </div>
          ) : null}
        </div>
      </main>

    </div>
  );
}

export default App;
