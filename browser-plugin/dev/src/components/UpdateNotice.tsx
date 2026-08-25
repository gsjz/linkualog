import React, { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import {
  UpdateAvailable,
  checkForUpdates,
  ignoreUpdateVersion,
} from '../services/updateChecker';

const UpdateNotice: React.FC = () => {
  const [update, setUpdate] = useState<UpdateAvailable | null>(null);

  useEffect(() => {
    let cancelled = false;

    checkForUpdates()
      .then((result) => {
        if (!cancelled && result) setUpdate(result);
      })
      .catch((error) => {
        console.warn('[Linkual] 自动检查更新失败', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!update) return null;

  const openUpdate = () => {
    const target = window.open(update.downloadUrl, '_blank', 'noopener,noreferrer');
    if (!target) window.location.href = update.downloadUrl;
    setUpdate(null);
  };

  const ignoreVersion = () => {
    ignoreUpdateVersion(update.latestVersion);
    setUpdate(null);
  };

  return (
    <div className="linkual-update-notice" role="dialog" aria-live="polite" aria-label="插件更新可用">
      <button type="button" className="linkual-update-close" onClick={() => setUpdate(null)} title="稍后提醒" aria-label="稍后提醒">
        <X size={15} strokeWidth={2.3} />
      </button>
      <div className="linkual-update-title">发现新版本</div>
      <div className="linkual-update-body">
        Linkual Log {update.latestVersion} 已可用，当前版本 {update.currentVersion}。
      </div>
      <div className="linkual-update-actions">
        <button type="button" className="linkual-update-primary" onClick={openUpdate}>
          <Download size={15} strokeWidth={2.2} />
          <span>安装更新</span>
        </button>
        <button type="button" className="linkual-update-secondary" onClick={ignoreVersion}>
          忽略此版本
        </button>
      </div>
    </div>
  );
};

export default UpdateNotice;
