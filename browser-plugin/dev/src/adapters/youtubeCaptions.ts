import { Subtitle } from '../types';

interface YouTubeCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  vssId?: string;
  kind?: string;
  name?: unknown;
  isTranslatable?: boolean;
}

interface FetchOptions {
  playerEl?: Element | null;
  win?: any;
}

export interface YouTubeCaptionFetchResult {
  videoId: string | null;
  subtitles: Subtitle[];
  url: string;
}

const PLAYER_RESPONSE_KEYS = [
  'playerResponse',
  'player_response',
  'captions',
  'playerCaptionsTracklistRenderer',
  'args',
  'data',
  'playerData',
  'response',
];

const TARGET_CAPTION_LANGUAGE = 'en';

function cleanCaptionText(text: string) {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(value: unknown, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function safeJsonParse(value: unknown) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function parseScriptString(value: string) {
  try {
    return JSON.parse(`"${value}"`);
  } catch (error) {
    return value;
  }
}

function getScriptConfigValue(key: string) {
  const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
  const scripts = Array.from(document.scripts).reverse().slice(0, 60);

  for (const script of scripts) {
    const match = script.textContent?.match(pattern);
    if (match) return parseScriptString(match[1]);
  }

  return null;
}

function getYtcfgValue(win: any, key: string) {
  try {
    const fromGetter = win?.ytcfg?.get?.(key);
    if (fromGetter !== undefined && fromGetter !== null) return fromGetter;
  } catch (error) {}

  try {
    const fromData = win?.ytcfg?.data_?.[key];
    if (fromData !== undefined && fromData !== null) return fromData;
  } catch (error) {}

  return getScriptConfigValue(key);
}

function parseJsonTimedText(data: any): Subtitle[] {
  const events = Array.isArray(data?.events) ? data.events : [];
  const subtitles: Subtitle[] = [];

  events.forEach((event: any, index: number) => {
    if (!event?.segs) return;

    const text = cleanCaptionText(event.segs.map((seg: any) => seg?.utf8 || '').join(''));
    if (!text) return;

    const start = toNumber(event.tStartMs) / 1000;
    const durationMs = toNumber(event.dDurationMs);
    const nextStartMs = toNumber(events[index + 1]?.tStartMs, NaN);
    const end = durationMs > 0
      ? (toNumber(event.tStartMs) + durationMs) / 1000
      : Number.isFinite(nextStartMs)
        ? nextStartMs / 1000
        : start;

    subtitles.push({ text, start, end: Math.max(start, end) });
  });

  return subtitles;
}

function parseXmlTimedText(xmlText: string): Subtitle[] {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) return [];

  const transcriptNodes = Array.from(doc.querySelectorAll('transcript text'));
  if (transcriptNodes.length > 0) {
    return transcriptNodes
      .map((node) => {
        const start = toNumber(node.getAttribute('start'));
        const duration = toNumber(node.getAttribute('dur'));
        return {
          text: cleanCaptionText(node.textContent || ''),
          start,
          end: start + duration,
        };
      })
      .filter((sub) => sub.text);
  }

  return Array.from(doc.querySelectorAll('p'))
    .map((node) => {
      const start = toNumber(node.getAttribute('t')) / 1000;
      const duration = toNumber(node.getAttribute('d')) / 1000;
      const segTexts = Array.from(node.querySelectorAll('s')).map((seg) => seg.textContent || '');
      const text = cleanCaptionText(segTexts.length > 0 ? segTexts.join('') : node.textContent || '');
      return { text, start, end: start + duration };
    })
    .filter((sub) => sub.text);
}

export function parseYouTubeTimedTextPayload(payload: unknown): Subtitle[] {
  if (!payload) return [];

  if (typeof payload === 'string') {
    const text = payload.trim();
    if (!text) return [];
    if (text.startsWith('{') || text.startsWith('[')) {
      const parsed = safeJsonParse(text);
      return parsed ? parseJsonTimedText(parsed) : [];
    }
    return parseXmlTimedText(text);
  }

  if (typeof payload === 'object') {
    return parseJsonTimedText(payload);
  }

  return [];
}

export function getTimedTextVideoId(url: string): string | null {
  try {
    return new URL(url, window.location.href).searchParams.get('v');
  } catch (error) {
    const match = url.match(/[?&]v=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

function isTargetLanguage(value: unknown) {
  if (!value) return false;
  const language = String(value).toLowerCase().replace('_', '-');
  return language === TARGET_CAPTION_LANGUAGE || language.startsWith(`${TARGET_CAPTION_LANGUAGE}-`);
}

function getTimedTextLanguage(url: string, key: 'lang' | 'tlang') {
  try {
    return new URL(url, window.location.href).searchParams.get(key);
  } catch (error) {
    const match = url.match(new RegExp(`[?&]${key}=([^&]+)`));
    return match ? decodeURIComponent(match[1]) : null;
  }
}

export function isEnglishTimedTextUrl(url: string) {
  const translatedLanguage = getTimedTextLanguage(url, 'tlang');
  if (translatedLanguage) return isTargetLanguage(translatedLanguage);
  return isTargetLanguage(getTimedTextLanguage(url, 'lang'));
}

function isCaptionTrack(value: unknown): value is YouTubeCaptionTrack {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as YouTubeCaptionTrack).baseUrl === 'string' &&
    (value as YouTubeCaptionTrack).baseUrl!.includes('timedtext')
  );
}

function addTracks(target: YouTubeCaptionTrack[], tracks: unknown) {
  if (!Array.isArray(tracks)) return;

  tracks.forEach((track) => {
    if (!isCaptionTrack(track)) return;
    const exists = target.some((item) => item.baseUrl === track.baseUrl);
    if (!exists) target.push(track);
  });
}

function collectCaptionTracks(value: unknown, target: YouTubeCaptionTrack[], seen = new WeakSet<object>(), depth = 0) {
  const data = safeJsonParse(value) as any;
  if (!data || typeof data !== 'object') return;
  if (depth > 6) return;
  if (seen.has(data)) return;
  seen.add(data);

  addTracks(target, data.captionTracks);
  addTracks(target, data?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
  addTracks(target, data?.playerCaptionsTracklistRenderer?.captionTracks);

  if (Array.isArray(data)) {
    data.forEach((item) => collectCaptionTracks(item, target, seen, depth + 1));
    return;
  }

  PLAYER_RESPONSE_KEYS.forEach((key) => {
    if (key in data) collectCaptionTracks(data[key], target, seen, depth + 1);
  });
}

function extractJsonObjectAfterMarker(text: string, marker: string) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;

  const start = text.indexOf('{', markerIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

function collectScriptCaptionTracks(target: YouTubeCaptionTrack[]) {
  const scripts = Array.from(document.scripts).reverse().slice(0, 40);

  scripts.forEach((script) => {
    const text = script.textContent || '';
    if (!text.includes('captionTracks') && !text.includes('ytInitialPlayerResponse')) return;

    const responseJson = extractJsonObjectAfterMarker(text, 'ytInitialPlayerResponse');
    if (responseJson) collectCaptionTracks(responseJson, target);
  });
}

function getActiveCaptionTrack(playerEl?: Element | null): any {
  const player = playerEl as any;
  if (!player || typeof player.getOption !== 'function') return null;

  try {
    return player.getOption('captions', 'track');
  } catch (error) {
    return null;
  }
}

function trackMatches(track: YouTubeCaptionTrack, activeTrack: any) {
  if (!activeTrack) return false;
  return Boolean(
    (track.vssId && track.vssId === activeTrack.vssId) ||
    (track.languageCode && track.languageCode === activeTrack.languageCode)
  );
}

function selectCaptionTrack(tracks: YouTubeCaptionTrack[], playerEl?: Element | null) {
  const activeTrack = getActiveCaptionTrack(playerEl);
  const activeMatch = tracks.find((track) => trackMatches(track, activeTrack));
  if (activeMatch) return activeMatch;

  return tracks
    .map((track, index) => ({
      track,
      score: (track.kind === 'asr' ? 0 : 10) + (track.isTranslatable ? 0 : 1) - index / 100,
    }))
    .sort((a, b) => b.score - a.score)[0]?.track || null;
}

function rankCaptionTracks(tracks: YouTubeCaptionTrack[], playerEl?: Element | null) {
  const activeTrack = getActiveCaptionTrack(playerEl);

  return tracks
    .map((track, index) => ({
      track,
      score:
        (trackMatches(track, activeTrack) ? 100 : 0) +
        (track.kind === 'asr' ? 0 : 10) +
        (track.isTranslatable ? 0 : 1) -
        index / 100,
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.track);
}

function isEnglishOutputTrack(track: YouTubeCaptionTrack) {
  if (track.baseUrl && isEnglishTimedTextUrl(track.baseUrl)) return true;
  return isTargetLanguage(track.languageCode);
}

function canTranslateTrackToEnglish(track: YouTubeCaptionTrack) {
  return Boolean(track.baseUrl && track.isTranslatable && !isEnglishOutputTrack(track));
}

function filterTracksForEnglish(tracks: YouTubeCaptionTrack[]) {
  const englishTracks = tracks.filter(isEnglishOutputTrack);
  if (englishTracks.length > 0) return englishTracks;

  return tracks.filter(canTranslateTrackToEnglish);
}

function buildTimedTextUrl(track: YouTubeCaptionTrack, videoId: string | null) {
  const url = new URL(track.baseUrl!, window.location.href);
  url.searchParams.set('fmt', 'json3');
  if (videoId && !url.searchParams.get('v')) url.searchParams.set('v', videoId);
  if (!isEnglishOutputTrack(track) && track.isTranslatable) {
    url.searchParams.set('tlang', TARGET_CAPTION_LANGUAGE);
  }
  return url.toString();
}

function filterTracksForVideo(tracks: YouTubeCaptionTrack[], videoId: string | null) {
  if (!videoId) return tracks;

  return tracks.filter((track) => {
    if (!track.baseUrl) return false;
    const trackVideoId = getTimedTextVideoId(track.baseUrl);
    return !trackVideoId || trackVideoId === videoId;
  });
}

export function extractYouTubeCaptionTracks(options: FetchOptions = {}) {
  const win = options.win || window;
  const tracks: YouTubeCaptionTrack[] = [];
  const playerEl = options.playerEl || document.querySelector('.html5-video-player');
  const player = playerEl as any;

  try {
    if (player && typeof player.getPlayerResponse === 'function') {
      collectCaptionTracks(player.getPlayerResponse(), tracks);
    }
  } catch (error) {}

  try {
    if (player && typeof player.getOption === 'function') {
      collectCaptionTracks(player.getOption('captions', 'tracklist'), tracks);
    }
  } catch (error) {}

  collectCaptionTracks(win?.ytInitialPlayerResponse, tracks);
  collectCaptionTracks(win?.ytplayer?.config?.args?.player_response, tracks);

  [
    options.playerEl,
    document.querySelector('ytd-reel-video-renderer[is-active]'),
    document.querySelector('ytd-watch-flexy'),
    document.querySelector('ytd-player'),
  ].forEach((element) => {
    if (!element) return;
    ['data', 'playerData', 'playerResponse', '__data'].forEach((key) => {
      collectCaptionTracks((element as any)[key], tracks);
    });
  });

  if (tracks.length === 0) collectScriptCaptionTracks(tracks);

  return tracks;
}

function getInnertubeContext(win: any) {
  const configuredContext = getYtcfgValue(win, 'INNERTUBE_CONTEXT');
  if (configuredContext && typeof configuredContext === 'object') return configuredContext;

  return {
    client: {
      clientName: getYtcfgValue(win, 'INNERTUBE_CLIENT_NAME') || 'WEB',
      clientVersion: getYtcfgValue(win, 'INNERTUBE_CLIENT_VERSION') || '2.20240101.00.00',
      hl: getYtcfgValue(win, 'HL') || document.documentElement.lang || 'en',
      gl: getYtcfgValue(win, 'GL') || 'US',
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
    },
  };
}

function getInnertubeEndpoint(win: any) {
  const apiKey = getYtcfgValue(win, 'INNERTUBE_API_KEY');
  if (!apiKey) return null;

  const endpoint = getYtcfgValue(win, 'INNERTUBE_API_ENDPOINT') || '/youtubei/v1';
  const url = new URL(`${String(endpoint).replace(/\/$/, '')}/player`, window.location.origin);
  url.searchParams.set('key', String(apiKey));
  url.searchParams.set('prettyPrint', 'false');
  return url.toString();
}

async function fetchInnertubeCaptionTracks(videoId: string, options: FetchOptions = {}) {
  const win = options.win || window;
  const endpoint = getInnertubeEndpoint(win);
  if (!endpoint) return [];

  const context = getInnertubeContext(win);
  const client = context?.client || {};
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const headerClientName = getYtcfgValue(win, 'INNERTUBE_CONTEXT_CLIENT_NAME');
  const headerClientVersion = client.clientVersion || getYtcfgValue(win, 'INNERTUBE_CLIENT_VERSION');
  const visitorId = getYtcfgValue(win, 'VISITOR_DATA');
  if (headerClientName) headers['X-YouTube-Client-Name'] = String(headerClientName);
  if (headerClientVersion) headers['X-YouTube-Client-Version'] = String(headerClientVersion);
  if (visitorId) headers['X-Goog-Visitor-Id'] = String(visitorId);

  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({
      context,
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: {
        contentPlaybackContext: {
          html5Preference: 'HTML5_PREF_WANTS',
        },
      },
    }),
  });

  if (!response.ok) return [];

  const tracks: YouTubeCaptionTrack[] = [];
  collectCaptionTracks(await response.json(), tracks);
  return tracks;
}

export async function fetchYouTubeCaptionsFromPlayer(
  videoId: string | null,
  options: FetchOptions = {},
): Promise<YouTubeCaptionFetchResult | null> {
  const playerEl = options.playerEl || document.querySelector('.html5-video-player');
  let tracks = filterTracksForEnglish(filterTracksForVideo(extractYouTubeCaptionTracks({ ...options, playerEl }), videoId));

  if (tracks.length === 0 && videoId) {
    tracks = filterTracksForEnglish(filterTracksForVideo(await fetchInnertubeCaptionTracks(videoId, { ...options, playerEl }), videoId));
  }

  const selectedTrack = selectCaptionTrack(tracks, playerEl);
  const rankedTracks = rankCaptionTracks(
    selectedTrack ? [selectedTrack, ...tracks.filter((track) => track.baseUrl !== selectedTrack.baseUrl)] : tracks,
    playerEl,
  );

  for (const track of rankedTracks) {
    if (!track?.baseUrl) continue;

    const url = buildTimedTextUrl(track, videoId);
    if (!isEnglishTimedTextUrl(url)) continue;

    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) continue;

    const subtitles = parseYouTubeTimedTextPayload(await response.text());
    if (subtitles.length === 0) continue;

    const resultVideoId = getTimedTextVideoId(url) || videoId;
    if (videoId && resultVideoId && resultVideoId !== videoId) continue;

    return {
      videoId: resultVideoId,
      subtitles,
      url,
    };
  }

  return null;
}
