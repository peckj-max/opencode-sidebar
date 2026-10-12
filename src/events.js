'use strict';

/**
 * Minimal SSE reader over a fetch response body.
 * The opencode server emits frames like:
 *   data: {"id":"evt_...","type":"server.connected","data":{}}
 *   <blank line>
 *   : heartbeat
 */
async function* readSse(url, headers, signal) {
  const res = await fetch(url, { headers, signal });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = [];
        for (const line of block.split('\n')) {
          // Ignore comments (": heartbeat") and fields other than data.
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length) continue;
        const payload = dataLines.join('\n');
        try {
          yield JSON.parse(payload);
        } catch {
          /* skip malformed frame */
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
      await res.body.cancel();
    } catch {
      /* ignored */
    }
  }
}

/**
 * Keep an SSE subscription alive with exponential backoff until aborted.
 * @param {string} url
 * @param {Record<string,string>} headers
 * @param {(ev:any)=>void} onEvent
 * @param {()=>boolean} isAborted
 * @param {(msg:string)=>void} [log]
 */
async function runEvents(url, headers, onEvent, isAborted, log) {
  let backoff = 500;
  while (!isAborted()) {
    try {
      for await (const ev of readSse(url, headers, undefined)) {
        backoff = 500;
        onEvent(ev);
      }
      if (log) log('event stream ended');
    } catch (err) {
      if (log) log(`event stream error: ${err.message}`);
    }
    if (isAborted()) break;
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 10000);
  }
}

module.exports = { readSse, runEvents };
