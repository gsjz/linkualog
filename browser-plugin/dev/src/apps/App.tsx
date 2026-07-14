import React, { useCallback, useState, useEffect, useRef } from 'react';
import { useVideoSync } from '../hooks/useVideoSync';
import SubtitleItem from '../components/SubtitleItem';
import Settings from '../components/Settings';
import VocabQueue from '../components/VocabQueue';
import MobileFullscreenButton from '../components/MobileFullscreenButton';
import UniversalVocabWidget from '../components/UniversalVocabWidget';
import ArticleTranslator from '../components/ArticleTranslator';
import { ArticleTranslationProvider } from '../components/ArticleTranslationContext';
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
const LINKUAL_NAVIGATION_EVENT = 'linkual_navigation';
const MIN_SIDEBAR_WIDTH = 250;
const MIN_SIDEBAR_HEIGHT = 150;
const MIN_REMAINING_VIEWPORT = 80;

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

function getVisualViewportSize() {
  const reservedViewportHeight = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--linkual-visual-viewport-height')
  );
  const width = window.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth;
  const height = Number.isFinite(reservedViewportHeight) && reservedViewportHeight > 0
    ? reservedViewportHeight
    : window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;

  return {
    width: Number.isFinite(width) && width > 0 ? width : window.innerWidth,
    height: Number.isFinite(height) && height > 0 ? height : window.innerHeight,
  };
}

function getReservedBottomHeight() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--linkual-universal-widget-height');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function parseConfigNumber(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampSidebarWidth(width: number) {
  const viewport = getVisualViewportSize();
  const requestedWidth = Number.isFinite(width) ? width : MIN_SIDEBAR_WIDTH;
  const maxWidth = Math.max(0, viewport.width - MIN_REMAINING_VIEWPORT);
  const minWidth = Math.min(MIN_SIDEBAR_WIDTH, maxWidth || viewport.width);
  return Math.max(0, Math.min(Math.max(requestedWidth, minWidth), maxWidth || viewport.width));
}

function clampSidebarHeight(height: number) {
  const viewport = getVisualViewportSize();
  const requestedHeight = Number.isFinite(height) ? height : MIN_SIDEBAR_HEIGHT;
  const availableHeight = Math.max(0, viewport.height - getReservedBottomHeight());
  const maxHeight = Math.max(0, availableHeight - MIN_REMAINING_VIEWPORT);
  const minHeight = Math.min(MIN_SIDEBAR_HEIGHT, maxHeight || availableHeight);
  return Math.max(0, Math.min(Math.max(requestedHeight, minHeight), maxHeight || availableHeight));
}

const App: React.FC<AppProps> = ({ adapter }) => {
  const [subs, setSubs] = useState<Subtitle[]>([]);
  
  const [inVideo, setInVideo] = useState(adapter.isVideoPage());

  const getAdpCfg = (key: CfgKey) => {
    const val = ConfigService.get(`${key}_${adapter.platformName}` as any);
    return (val !== null && val !== undefined && val !== '') ? val : ConfigService.get(key);
  };

  const [layout, setLayout] = useState(getAdpCfg('layout_position') as string);
  const [sidebarWidth, setSidebarWidth] = useState(parseConfigNumber(getAdpCfg('sidebar_width'), parseConfigNumber(DEFAULTS.sidebar_width, 500)));
  const [sidebarHeight, setSidebarHeight] = useState(parseConfigNumber(getAdpCfg('sidebar_height'), parseConfigNumber(DEFAULTS.sidebar_height, 350)));

  const [themeColor, setThemeColor] = useState(ConfigService.get('theme_color') as string);
  const [doneColor, setDoneColor] = useState(ConfigService.get('done_color') as string);
  const [errorColor, setErrorColor] = useState(ConfigService.get('error_color') as string);
  const [mobileFullscreenMode, setMobileFullscreenMode] = useState(ConfigService.get('mobile_fullscreen_mode') as string);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [renderLimit, setRenderLimit] = useState(INITIAL_RENDER_LIMIT);
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastHostLayoutRef = useRef<{ adapter: IVideoAdapter; width: number; height: number; layout: string; inVideo: boolean } | null>(null);
  const activeIndex = useVideoSync(subs, adapter);

  const resizeAdapterHost = useCallback((force = false) => {
    if (!adapter.resizeHost) return;

    const nextLayout = inVideo
      ? {
          adapter,
          width: clampSidebarWidth(sidebarWidth),
          height: clampSidebarHeight(sidebarHeight),
          layout,
          inVideo,
        }
      : {
          adapter,
          width: 0,
          height: 0,
          layout,
          inVideo,
        };
    const prevLayout = lastHostLayoutRef.current;

    if (
      !force &&
      prevLayout &&
      prevLayout.adapter === nextLayout.adapter &&
      prevLayout.width === nextLayout.width &&
      prevLayout.height === nextLayout.height &&
      prevLayout.layout === nextLayout.layout &&
      prevLayout.inVideo === nextLayout.inVideo
    ) {
      return;
    }

    lastHostLayoutRef.current = nextLayout;
    adapter.resizeHost(nextLayout.width, nextLayout.height, nextLayout.layout);
  }, [adapter, inVideo, layout, sidebarHeight, sidebarWidth]);

  useEffect(() => {
    const checkVideo = () => {
      setInVideo((prev) => {
        const isVid = adapter.isVideoPage();
        return prev !== isVid ? isVid : prev;
      });
    };
    
    const interval = setInterval(checkVideo, 500);
    window.addEventListener('yt-navigate-finish', checkVideo);
    window.addEventListener(LINKUAL_NAVIGATION_EVENT, checkVideo);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('yt-navigate-finish', checkVideo);
      window.removeEventListener(LINKUAL_NAVIGATION_EVENT, checkVideo);
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
      setSidebarWidth(parseConfigNumber(getAdpCfg('sidebar_width'), parseConfigNumber(DEFAULTS.sidebar_width, 500)));
      setSidebarHeight(parseConfigNumber(getAdpCfg('sidebar_height'), parseConfigNumber(DEFAULTS.sidebar_height, 350)));
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
    resizeAdapterHost();
  }, [resizeAdapterHost]);

  useEffect(() => {
    const refreshCustomLayout = () => resizeAdapterHost(true);

    window.addEventListener('linkual_custom_layout_refresh', refreshCustomLayout);
    window.addEventListener(LINKUAL_NAVIGATION_EVENT, refreshCustomLayout);
    return () => {
      window.removeEventListener('linkual_custom_layout_refresh', refreshCustomLayout);
      window.removeEventListener(LINKUAL_NAVIGATION_EVENT, refreshCustomLayout);
    };
  }, [resizeAdapterHost]);

  useEffect(() => {
    const refreshViewportLayout = () => resizeAdapterHost();

    window.addEventListener('orientationchange', refreshViewportLayout);
    window.addEventListener('resize', refreshViewportLayout);
    window.visualViewport?.addEventListener('resize', refreshViewportLayout);

    return () => {
      window.removeEventListener('orientationchange', refreshViewportLayout);
      window.removeEventListener('resize', refreshViewportLayout);
      window.visualViewport?.removeEventListener('resize', refreshViewportLayout);
    };
  }, [resizeAdapterHost]);

  const startResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (layout === 'bottom') {
      const startY = e.clientY;
      const startHeight = sidebarHeight;
      let currentHeight = startHeight;
      const onMouseMove = (ev: globalThis.MouseEvent) => {
        const viewport = getVisualViewportSize();
        let newHeight = startHeight - (ev.clientY - startY);
        if (newHeight < MIN_SIDEBAR_HEIGHT) newHeight = MIN_SIDEBAR_HEIGHT;
        if (newHeight > viewport.height * 0.8) newHeight = viewport.height * 0.8;
        newHeight = clampSidebarHeight(newHeight);
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
        const viewport = getVisualViewportSize();
        let newWidth = startWidth - (ev.clientX - startX);
        if (newWidth < MIN_SIDEBAR_WIDTH) newWidth = MIN_SIDEBAR_WIDTH;
        if (newWidth > viewport.width * 0.8) newWidth = viewport.width * 0.8;
        newWidth = clampSidebarWidth(newWidth);
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
    width: layout === 'right' ? clampSidebarWidth(sidebarWidth) : '100%',
    height: layout === 'bottom'
      ? clampSidebarHeight(sidebarHeight)
      : 'calc(var(--linkual-visual-viewport-height, 100vh) - var(--linkual-universal-widget-height, 0px) - env(safe-area-inset-bottom, 0px))',
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
    <ArticleTranslationProvider enabled={!inVideo}>
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
      <ArticleTranslator />
      {showMobileFullscreenButton && <MobileFullscreenButton adapter={adapter} />}
      <VocabQueue />
      {isSettingsOpen && <Settings adapter={adapter} onClose={() => setIsSettingsOpen(false)} />}
      </>
    </ArticleTranslationProvider>
  );
};

export default App;
