import { GM_getValue, GM_setValue, GM_deleteValue } from '$';
import { DEFAULTS } from '../constants/defaults';

export const ConfigService = {
  get<K extends keyof typeof DEFAULTS>(key: K): typeof DEFAULTS[K] {
    try {
      if (typeof GM_getValue !== 'undefined') {
        const gmVal = GM_getValue(`linkual_${key}`);
        if (gmVal !== undefined && gmVal !== null) {
          return gmVal as typeof DEFAULTS[K];
        }
      }
    } catch (e) { }

    const val = localStorage.getItem(`linkual_${key}`);
    if (val !== null) {
      if (typeof DEFAULTS[key] === 'boolean') {
        return (val === 'true') as unknown as typeof DEFAULTS[K];
      }
      return val as unknown as typeof DEFAULTS[K];
    }

    return DEFAULTS[key];
  },

  set<K extends keyof typeof DEFAULTS>(key: K, value: typeof DEFAULTS[K]) {
    try {
      if (typeof GM_setValue !== 'undefined') {
        GM_setValue(`linkual_${key}`, value);
      }
    } catch (e) { }
    localStorage.setItem(`linkual_${key}`, String(value));
  },

  reset() {
    Object.keys(DEFAULTS).forEach(key => {
      localStorage.removeItem(`linkual_${key}`);
      try {
        if (typeof GM_deleteValue !== 'undefined') {
          GM_deleteValue(`linkual_${key}`);
        }
      } catch (e) { }
    });
  }
};