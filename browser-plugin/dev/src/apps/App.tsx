import React, { useState, useEffect, useRef } from 'react';
import { useVideoSync } from '../hooks/useVideoSync';
import SubtitleItem from '../components/SubtitleItem';
import Settings from '../components/Settings';
import VocabQueue from '../components/VocabQueue';
import { Subtitle } from '../types';
import { IVideoAdapter } from '../adapters/BaseAdapter';
import { ConfigService } from '../services/configService';
import { DEFAULTS } from '../constants/defaults';
import './App.css';

interface AppProps { adapter: IVideoAdapter; }

type CfgKey = keyof typeof DEFAULTS;

const INITIAL_RENDER_LIMIT = 80;
const RENDER_BATCH_SIZE = 80;
const ACTIVE_RENDER_BUFFER = 20;

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
    if (adapter.resizeHost) {
      if (inVideo) {
        adapter.resizeHost(sidebarWidth, sidebarHeight, layout);
      } else {
        adapter.resizeHost(0, 0, layout);
      }
    }
  }, [sidebarWidth, sidebarHeight, layout, adapter, inVideo]);

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
    height: layout === 'bottom' ? sidebarHeight : '100vh',
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
        {isSettingsOpen && <Settings adapter={adapter} onClose={() => setIsSettingsOpen(false)} />}
      </div>
      {inVideo && <VocabQueue />}
    </>
  );
};

export default App;
