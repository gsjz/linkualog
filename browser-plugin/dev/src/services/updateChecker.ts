import { GM_xmlhttpRequest } from '$';
import { ConfigService } from './configService';

export const LINKUAL_CURRENT_VERSION = __LINKUAL_VERSION__;
export const LINKUAL_UPDATE_URL = 'https://raw.githubusercontent.com/gsjz/linkualog/main/browser-plugin/user/linkualog.user.js';
export const LINKUAL_DOWNLOAD_URL = LINKUAL_UPDATE_URL;

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12000;

export interface UpdateAvailable {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
}

function requestText(url: string) {
  const requestUrl = `${url}?_=${Date.now()}`;

  if (typeof GM_xmlhttpRequest !== 'undefined') {
    return new Promise<string>((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: requestUrl,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: 'text/plain,*/*',
          'Cache-Control': 'no-cache',
        },
        onload: (response: any) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`HTTP ${response.status}`));
            return;
          }
          resolve(String(response.responseText || ''));
        },
        onerror: () => reject(new Error('更新检查请求失败')),
        ontimeout: () => reject(new Error('更新检查请求超时')),
        onabort: () => reject(new Error('更新检查请求已取消')),
      });
    });
  }

  return fetch(requestUrl, { cache: 'no-store' }).then(async (response) => {
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return text;
  });
}

function readUserscriptVersion(source: string) {
  return source.match(/^\s*\/\/\s*@version\s+(.+?)\s*$/m)?.[1]?.trim() || '';
}

function normalizeVersion(value: string) {
  return value.trim().replace(/^v/i, '');
}

function compareVersions(left: string, right: string) {
  const leftParts = normalizeVersion(left).split(/[.-]/);
  const rightParts = normalizeVersion(right).split(/[.-]/);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] || '0';
    const rightPart = rightParts[index] || '0';
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);

    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1;
      continue;
    }

    const stringCompare = leftPart.localeCompare(rightPart);
    if (stringCompare !== 0) return stringCompare > 0 ? 1 : -1;
  }

  return 0;
}

function getLastCheckedAt() {
  const parsed = Number.parseInt(ConfigService.get('update_last_checked_at') as string, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function markCheckedNow() {
  ConfigService.set('update_last_checked_at', String(Date.now()));
}

export function isAutoUpdateCheckEnabled() {
  return ConfigService.get('auto_update_check') !== 'false';
}

export function shouldCheckForUpdates(force = false) {
  if (!force && !isAutoUpdateCheckEnabled()) return false;
  if (force) return true;

  return Date.now() - getLastCheckedAt() >= CHECK_INTERVAL_MS;
}

export async function checkForUpdates(options: { force?: boolean } = {}): Promise<UpdateAvailable | null> {
  if (!shouldCheckForUpdates(Boolean(options.force))) return null;

  markCheckedNow();
  const source = await requestText(LINKUAL_UPDATE_URL);

  const latestVersion = readUserscriptVersion(source);
  if (!latestVersion || compareVersions(latestVersion, LINKUAL_CURRENT_VERSION) <= 0) return null;

  if (ConfigService.get('update_ignored_version') === latestVersion) return null;

  return {
    currentVersion: LINKUAL_CURRENT_VERSION,
    latestVersion,
    downloadUrl: LINKUAL_DOWNLOAD_URL,
  };
}

export function ignoreUpdateVersion(version: string) {
  ConfigService.set('update_ignored_version', version);
}
