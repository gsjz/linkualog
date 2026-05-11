export const FOCUS_TOKEN_REGEX = /\s+|[\p{L}\p{N}_]+|[^\s]/gu;

export function tokenizeNonSpace(text) {
  return (String(text || '').match(FOCUS_TOKEN_REGEX) || []).filter((chunk) => !/^\s+$/.test(chunk));
}
