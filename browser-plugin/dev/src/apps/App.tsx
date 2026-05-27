import React, { useState, useEffect, useRef } from 'react';
import { useVideoSync } from '../hooks/useVideoSync';
import SubtitleItem from '../components/SubtitleItem';
import Settings from '../components/Settings';
import VocabQueue from '../components/VocabQueue';
import MobileFullscreenButton from '../components/MobileFullscreenButton';
import UniversalVocabWidget from '../components/UniversalVocabWidget';
import { Subtitle } from '../types';
import { IVideoAdapter } from '../adapters/BaseAdapter';
import { ConfigService } from '../services/configService';
import { DEFAULTS } from '../constants/defaults';
import './App.css';

interface AppProps { adapter: IVideoAdapter; }

type CfgKey = keyof typeof DEFAULTS;
type BrowserFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  mozCancelFullScreen?: () => Promise<void> | void;
  msExitFullscreen?: () => Promise<void> | void;
};

const INITIAL_RENDER_LIMIT = 80;
const RENDER_BATCH_SIZE = 80;
const ACTIVE_RENDER_BUFFER = 20;

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

const App: React.FC<AppProps> = ({ adapter }) => {
  const [subs, setSubs] = useState<Subtitle[]>([]);
  
  const [inVideo, setInVideo] = useState(adapter.isVideoPage());

  const getAdpCfg = (key: CfgKey) => {
    const val = ConfigService.get(`${key}_${adapter.platformName}` as any);
    return (val !== null && val !== undefined && val !== '') ? val : ConfigService.get(key);
  };

  const [layout, setLayout] = useState(getAdpCfg('layout_position') as string);
  const [sidebarWidth, setSidebarWidth] = useState(parseInt(getAdpCfg('sidebar_width') as string, 10));
  const [sidebarHeight, setSidebarHeight] = useState(parseInt(getAdpCfg('sidebar_height') as string, 10));

  const [themeColor, setThemeColor] = useState(ConfigService.get('theme_color') as string);
  const [doneColor, setDoneColor] = useState(ConfigService.get('done_color') as string);
  const [errorColor, setErrorColor] = useState(ConfigService.get('error_color') as string);
  const [mobileFullscreenMode, setMobileFullscreenMode] = useState(ConfigService.get('mobile_fullscreen_mode') as string);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [renderLimit, setRenderLimit] = useState(INITIAL_RENDER_LIMIT);
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeIndex = useVideoSync(subs, adapter);

  useEffect(() => {
    const checkVideo = () => {
      setInVideo((prev) => {
        const isVid = adapter.isVideoPage();
        return prev !== isVid ? isVid : prev;
      });
    };
    
    const interval = setInterval(checkVideo, 500);
    window.addEventListener('yt-navigate-finish', checkVideo);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('yt-navigate-finish', checkVideo);
    };
  }, [adapter]);

  useEffect(() => {
    adapter.onSubtitleDetected((newSubs) => {
      setSubs(newSubs);
      if (newSubs.length === 0) setRenderLimit(INITIAL_RENDER_LIMIT);
    });

    const handleSettingsUpdate = () => {
      setThemeColor(ConfigService.get('theme_color') as string);
      setDoneColor(ConfigService.get('done_color') as string);
      setErrorColor(ConfigService.get('error_color') as string);
      setMobileFullscreenMode(ConfigService.get('mobile_fullscreen_mode') as string);
      
      setLayout(getAdpCfg('layout_position') as string);
      setSidebarWidth(parseInt(getAdpCfg('sidebar_width') as string, 10));
      setSidebarHeight(parseInt(getAdpCfg('sidebar_height') as string, 10));
    };
    window.addEventListener('linkual_settings_updated', handleSettingsUpdate);
    return () => window.removeEventListener('linkual_settings_updated', handleSettingsUpdate);
  }, [adapter]);

  useEffect(() => {
    if (activeIndex < 0 || subs.length === 0) return;

    if (activeIndex >= renderLimit - ACTIVE_RENDER_BUFFER) {
      setRenderLimit((prev) => Math.min(subs.length, Math.max(prev, activeIndex + RENDER_BATCH_SIZE)));
    }
  }, [activeIndex, renderLimit, subs.length]);

  useEffect(() => {
    const clearCustomFullscreenIfNeeded = () => {
      if (inVideo || !document.documentElement.classList.contains('linkual-custom-fullscreen')) return;

      document.documentElement.classList.remove('linkual-custom-fullscreen');
      adapter.setCustomFullscreen?.(false);
      window.dispatchEvent(new Event('linkual_custom_fullscreen_changed'));
      window.dispatchEvent(new Event('linkual_custom_layout_refresh'));
      window.dispatchEvent(new Event('resize'));

      if (getBrowserFullscreenElement() === document.documentElement) {
        const browserFullscreenAction = exitBrowserFullscreen();
        if (isPromiseLike(browserFullscreenAction)) {
          browserFullscreenAction.catch((error) => console.warn('[Linkual] 浏览器全屏退出失败', error));
        }
      }
    };

    clearCustomFullscreenIfNeeded();
    window.addEventListener('linkual_custom_fullscreen_changed', clearCustomFullscreenIfNeeded);
    return () => window.removeEventListener('linkual_custom_fullscreen_changed', clearCustomFullscreenIfNeeded);
  }, [adapter, inVideo]);

  useEffect(() => {
    if (adapter.resizeHost) {
      if (inVideo) {
        adapter.resizeHost(sidebarWidth, sidebarHeight, layout);
      } else {
        adapter.resizeHost(0, 0, layout);
      }
    }
  }, [sidebarWidth, sidebarHeight, layout, adapter, inVideo]);

  useEffect(() => {
    const refreshCustomLayout = () => {
      if (adapter.resizeHost && inVideo) {
        adapter.resizeHost(sidebarWidth, sidebarHeight, layout);
      }
    };

    window.addEventListener('linkual_custom_layout_refresh', refreshCustomLayout);
    return () => window.removeEventListener('linkual_custom_layout_refresh', refreshCustomLayout);
  }, [adapter, inVideo, layout, sidebarHeight, sidebarWidth]);

  const startResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (layout === 'bottom') {
      const startY = e.clientY;
      const startHeight = sidebarHeight;
      let currentHeight = startHeight;
      const onMouseMove = (ev: globalThis.MouseEvent) => {
        let newHeight = startHeight - (ev.clientY - startY);
        if (newHeight < 150) newHeight = 150;
        if (newHeight > window.innerHeight * 0.8) newHeight = window.innerHeight * 0.8;
        currentHeight = newHeight;
        setSidebarHeight(newHeight);
      };
      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        ConfigService.set(`sidebar_height_${adapter.platformName}` as any, currentHeight.toString());
        ConfigService.set('sidebar_height', currentHeight.toString());
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    } else {
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      let currentWidth = startWidth;
      const onMouseMove = (ev: globalThis.MouseEvent) => {
        let newWidth = startWidth - (ev.clientX - startX);
        if (newWidth < 250) newWidth = 250;
        if (newWidth > window.innerWidth * 0.8) newWidth = window.innerWidth * 0.8;
        currentWidth = newWidth;
        setSidebarWidth(newWidth);
      };
      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        ConfigService.set(`sidebar_width_${adapter.platformName}` as any, currentWidth.toString());
        ConfigService.set('sidebar_width', currentWidth.toString());
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    }
  };

  const wrapStyle: React.CSSProperties = {
    display: inVideo ? 'flex' : 'none',
    width: layout === 'right' ? sidebarWidth : '100%',
    height: layout === 'bottom'
      ? sidebarHeight
      : 'calc(100vh - var(--linkual-universal-widget-height, 0px) - env(safe-area-inset-bottom, 0px))',
    pointerEvents: inVideo ? 'auto' : 'none',
    '--linkual-theme': themeColor,
    '--linkual-done': doneColor,
    '--linkual-error': errorColor
  } as React.CSSProperties;

  const handleListScroll = () => {
    const listEl = listRef.current;
    if (!listEl || renderLimit >= subs.length) return;

    const distanceToBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
    if (distanceToBottom < 160) {
      setRenderLimit((prev) => Math.min(subs.length, prev + RENDER_BATCH_SIZE));
    }
  };

  const visibleSubs = subs.slice(0, renderLimit);
  const hasMoreSubs = visibleSubs.length < subs.length;
  const showMobileFullscreenButton = mobileFullscreenMode === 'always' || (mobileFullscreenMode === 'video' && inVideo);

  return (
    <>
      <div className={`linkual-wrap layout-${layout}`} style={wrapStyle}>
        <div className="resizer" onMouseDown={startResize} title={layout === 'right' ? '左右拖拽调整宽度' : '上下拖拽调整高度'} />
        <div className="header">
          <span>Link-ual Log [{adapter.platformName}]</span>
          <div><span className="settings-icon" onClick={() => setIsSettingsOpen(true)} title="全局设置">⚙️</span></div>
        </div>
        <div className="list" ref={listRef} onScroll={handleListScroll}>
          {subs.length === 0 ? (
            <div className="empty-tip">等待字幕数据...</div>
          ) : (
            <>
              {visibleSubs.map((sub, index) => (
                <SubtitleItem key={index} data={sub} index={index} allSubs={subs} isActive={index === activeIndex} adapter={adapter} />
              ))}
              {hasMoreSubs && (
                <div className="load-more-tip">
                  向下滚动加载更多字幕（{visibleSubs.length}/{subs.length}）
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <UniversalVocabWidget onOpenSettings={() => setIsSettingsOpen(true)} />
      {showMobileFullscreenButton && <MobileFullscreenButton adapter={adapter} />}
      <VocabQueue />
      {isSettingsOpen && <Settings adapter={adapter} onClose={() => setIsSettingsOpen(false)} />}
    </>
  );
};

export default App;
