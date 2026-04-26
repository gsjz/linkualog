import { GM_xmlhttpRequest } from '$';

export interface FetchLlmOptions {
  apiUrl: string;
  apiKey: string;
  apiModel: string;
  systemPrompt?: string;
  userPrompt?: string;
  messages?: { role: string; content: string | any[] }[]; 
  timeoutSec?: number;
  onData: (chunk: string) => void;
  onError: (err: string) => void;
  onDone: () => void;
}

export function fetchLlmStream(options: FetchLlmOptions): { abort: () => void } {
  let isAborted = false;
  let gmReq: any = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const abortController = new AbortController();

  const abort = (reason = 'ABORTED') => {
    if (isAborted) return;
    isAborted = true;
    if (timeoutId) clearTimeout(timeoutId);
    if (gmReq && typeof gmReq.abort === 'function') gmReq.abort();
    abortController.abort();
    options.onError(reason); 
  };

  const execute = async () => {
    if (options.timeoutSec) {
      timeoutId = setTimeout(() => {
        abort(`\n❌ 请求超时 (${options.timeoutSec}s)，请检查网络或更换节点。`);
      }, options.timeoutSec * 1000);
    }

    const chatMessages = options.messages && options.messages.length > 0 
      ? options.messages 
      : [{ role: "user", content: options.userPrompt || '' }];

    const finalMessages = [];
    if (options.systemPrompt) {
      finalMessages.push({ role: "system", content: options.systemPrompt });
    }
    finalMessages.push(...chatMessages);

    const payload = {
      model: options.apiModel,
      messages: finalMessages,
      stream: true
    };

    if (typeof GM_xmlhttpRequest !== 'undefined') {
      let streamAttached = false;
      gmReq = GM_xmlhttpRequest({
        method: 'POST',
        url: options.apiUrl,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Authorization': `Bearer ${options.apiKey}`
        },
        data: JSON.stringify(payload),
        responseType: 'stream',
        onreadystatechange: async (res: any) => {
          if (isAborted) return;
          if (res.readyState === 2 || res.readyState === 3) {
            if (!streamAttached && res.response && typeof res.response.getReader === 'function') {
              streamAttached = true;
              try {
                const reader = res.response.getReader();
                const decoder = new TextDecoder('utf-8');
                let buffer = '';
                while (true) {
                  if (isAborted) break;
                  const { done, value } = await reader.read();
                  if (done || isAborted) break;
                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split('\n');
                  buffer = lines.pop() || '';
                  for (const line of lines) {
                    const t = line.trim();
                    if (t.startsWith('data: ') && t !== 'data: [DONE]') {
                      try {
                        const json = JSON.parse(t.substring(6));
                        const chunk = json.choices?.[0]?.delta?.content || '';
                        if (chunk && !isAborted) {
                           if (timeoutId) clearTimeout(timeoutId);
                           options.onData(chunk);
                        }
                      } catch(e) {
                        console.warn('[Linkual] 数据块解析异常，等待拼接...', t);
                      }
                    } else if (t.includes('"error":')) {
                      if (!isAborted) abort("\n❌ API 返回错误: " + t);
                    }
                  }
                }
                if (!isAborted) {
                  if (timeoutId) clearTimeout(timeoutId);
                  options.onDone();
                }
              } catch (err) {
                if (!isAborted) abort("\n[流读取异常中断]");
              }
            }
          }
        },
        onload: (res: any) => {
          if (isAborted) return;
          if (!streamAttached && res.status >= 400) abort(`❌ 请求失败 [HTTP ${res.status}]: ${res.responseText}`);
        },
        onerror: () => { if (!isAborted) abort('❌ 网络请求被拦截或断开'); },
        onabort: () => {  }
      });
    } else {
      try {
        console.warn('[Linkual] GM_xmlhttpRequest 不可用，正在使用 fetch 请求 LLM:', options.apiUrl);
        const res = await fetch(options.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${options.apiKey}` },
          body: JSON.stringify(payload),
          signal: abortController.signal
        });
        if (isAborted) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!res.body) throw new Error("无响应流");
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        while (true) {
          if (isAborted) break;
          const { done, value } = await reader.read();
          if (done || isAborted) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const t = line.trim();
            if (t.startsWith('data: ') && t !== 'data: [DONE]') {
              try {
                const json = JSON.parse(t.substring(6));
                const chunk = json.choices?.[0]?.delta?.content || '';
                if (chunk && !isAborted) {
                  if (timeoutId) clearTimeout(timeoutId);
                  options.onData(chunk);
                }
              } catch (e) {
                console.warn('[Linkual] fetch 数据块解析异常', t);
              }
            }
          }
        }
        if (!isAborted) {
          if (timeoutId) clearTimeout(timeoutId);
          options.onDone();
        }
      } catch (e: any) {
        if (isAborted || e.name === 'AbortError') return;
        abort(e.message || "请求异常");
      }
    }
  };

  execute();
  return { abort: () => abort('ABORTED') };
}
