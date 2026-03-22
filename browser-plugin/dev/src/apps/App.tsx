import React, { useState, useEffect } from 'react';
import { useVideoSync } from '../hooks/useVideoSync';
import SubtitleItem from '../components/SubtitleItem';
import Settings from '../components/Settings';
import LanSync from '../components/LanSync';
import { Subtitle } from '../types';
import { IVideoAdapter } from '../adapters/BaseAdapter';
import { ConfigService } from '../services/configService';
import './App.css';


interface AppProps {
  adapter: IVideoAdapter;
}

const App: React.FC<AppProps> = ({ adapter }) => {
  const [subs, setSubs] = useState<Subtitle[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(parseInt(ConfigService.get('sidebar_width') as string, 10));

  const [themeColor, setThemeColor] = useState(ConfigService.get('theme_color') as string);
  const [doneColor, setDoneColor] = useState(ConfigService.get('done_color') as string);
  const [errorColor, setErrorColor] = useState(ConfigService.get('error_color') as string);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const [renderLimit, setRenderLimit] = useState(50);

  const activeIndex = useVideoSync(subs, adapter);

  useEffect(() => {
    adapter.onSubtitleDetected((newSubs) => {
      setSubs(newSubs);
      setRenderLimit(50);
    });

    const handleSettingsUpdate = () => {
      setThemeColor(ConfigService.get('theme_color') as string);
      setDoneColor(ConfigService.get('done_color') as string);
      setErrorColor(ConfigService.get('error_color') as string);
      setSidebarWidth(parseInt(ConfigService.get('sidebar_width') as string, 10));
    };
    window.addEventListener('linkual_settings_updated', handleSettingsUpdate);
    return () => window.removeEventListener('linkual_settings_updated', handleSettingsUpdate);
  }, [adapter]);

  useEffect(() => {
    if (subs.length > 0 && renderLimit < subs.length) {
      const timer = setTimeout(() => {
        setRenderLimit(prev => Math.min(prev + 100, subs.length));
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [subs.length, renderLimit]);

  useEffect(() => {
    if (activeIndex >= renderLimit) {
      setRenderLimit(activeIndex + 50);
    }
  }, [activeIndex, renderLimit]);

  useEffect(() => {
    if (adapter.resizeHost) {
      adapter.resizeHost(sidebarWidth);
    }
  }, [sidebarWidth, adapter]);

  const startResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
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
      ConfigService.set('sidebar_width', currentWidth.toString());
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const wrapStyle: React.CSSProperties = {
    width: sidebarWidth,
    '--linkual-theme': themeColor,
    '--linkual-done': doneColor,
    '--linkual-error': errorColor
  } as React.CSSProperties;

  return (
    <div className="linkual-wrap" style={wrapStyle}>
      <div className="resizer" onMouseDown={startResize} title="左右拖拽调整宽度" />

      <div className="header">
        <span>Link-ual Log [{adapter.platformName}]</span>
        <div>
          <span className="settings-icon" onClick={() => setIsSettingsOpen(true)} title="全局设置">⚙️</span>
        </div>
      </div>

      <div className="list">
        {subs.length === 0 ? (
          <div className="empty-tip">⏳ 等待字幕数据...</div>
        ) : (
          subs.slice(0, renderLimit).map((sub, index) => (
            <SubtitleItem key={index} data={sub} index={index} allSubs={subs} isActive={index === activeIndex} adapter={adapter} />
          ))
        )}
      </div>

      <LanSync subs={subs} activeIndex={activeIndex} />

      {isSettingsOpen && <Settings onClose={() => setIsSettingsOpen(false)} />}
    </div>
  );
};

export default App;