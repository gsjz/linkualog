const isGreaseMonkey = typeof GM_xmlhttpRequest !== 'undefined';
declare const GM_xmlhttpRequest: any;

export interface JsonRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

const formatHttpError = (status: number, responseText: string) => {
  const detail = (responseText || '').trim();
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
};

export async function requestJson<T = unknown>({
  url,
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 15000,
}: JsonRequestOptions): Promise<T> {
  if (isGreaseMonkey) {
    return new Promise<T>((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body,
        timeout: timeoutMs,
        onload: (res: any) => {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error(formatHttpError(res.status, res.responseText)));
            return;
          }

          const text = String(res.responseText || '').trim();
          if (!text) {
            resolve({} as T);
            return;
          }

          try {
            resolve(JSON.parse(text) as T);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            reject(new Error(`响应 JSON 解析失败: ${message}`));
          }
        },
        onerror: () => reject(new Error('网络请求被拦截或断开')),
        ontimeout: () => reject(new Error(`请求超时 (${Math.ceil(timeoutMs / 1000)}s)`)),
        onabort: () => reject(new Error('请求已取消')),
      });
    });
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: abortController.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(formatHttpError(response.status, text));
    }

    if (!text.trim()) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`请求超时 (${Math.ceil(timeoutMs / 1000)}s)`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
