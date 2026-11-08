// gemini.js — talks to Google's Gemini API. This is the only file that knows about Google:
// to use another provider, write another file with the same `generate` function.
//
// generate({ system, text, images, schema }) -> { json, model, usage }
//   images: [{ name, box, mime, data(base64) }]
//
// Safeguards (the AI must never break the tool):
//   - every request has a time limit (default 90 s)
//   - requests are spaced out so a big drawing set does not trip the per-minute limit
//   - "too many requests" waits as long as Google says (up to 65 s) and tries again
//   - a used-up free model (daily limit) or a missing model -> switch to the next free model
//   - each request has an overall budget (default 3 min) across all its retries
//   - the AI is asked to keep its "thinking" short (much faster for reading drawings);
//     models that do not accept that setting are asked again without it
//   - the caller can stop at any time (isStopped)
//   - every failure ends in an AIError with a plain-English message; nothing hangs

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class AIError extends Error {
  constructor(message, { status, retryable, quota, waitMs, stopped } = {}) {
    super(message); this.status = status; this.retryable = !!retryable; this.quota = !!quota; this.waitMs = waitMs; this.stopped = !!stopped;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Free-tier model names change over time, so they are looked up rather than hard-coded.
// Newest general "Flash" models first, then "Flash-Lite" ones as fallbacks.
export async function listModels(apiKey, fetchImpl = fetch, timeoutMs = 30000) {
  const res = await timedFetch(fetchImpl, `${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } }, timeoutMs);
  if (!res.ok) throw await toError(res);
  const { models = [] } = await res.json();
  const names = models
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /^gemini-\d+(\.\d+)?-flash(-lite)?(-preview(-[\w-]+)?)?$/.test(n) && !/image|tts|audio|live|thinking/.test(n));
  if (!names.length) throw new AIError('No suitable Gemini Flash model is available for this key.');
  const ver = n => parseFloat(n.match(/gemini-(\d+(\.\d+)?)/)[1]);
  const lite = n => /-lite/.test(n) ? 1 : 0, prev = n => /preview/.test(n) ? 1 : 0;
  return names.sort((a, b) => (lite(a) - lite(b)) || (ver(b) - ver(a)) || (prev(a) - prev(b)));
}
export async function pickModel(apiKey, fetchImpl = fetch) { return (await listModels(apiKey, fetchImpl))[0]; }

async function timedFetch(fetchImpl, url, opts, timeoutMs, isStopped = () => false) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer, poll;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => { ctl?.abort(); rej(new AIError(`The AI service did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, { retryable: true })); }, timeoutMs);
    poll = setInterval(() => { if (isStopped()) { ctl?.abort(); rej(new AIError('Stopped.', { stopped: true })); } }, 300);
  });
  try {
    return await Promise.race([fetchImpl(url, { ...opts, signal: ctl?.signal }), timeout]);
  } catch (e) {
    if (isStopped()) throw new AIError('Stopped.', { stopped: true });
    if (e instanceof AIError) throw e;
    throw new AIError(`Could not reach the AI service: ${e.message}`, { retryable: true });
  } finally { clearTimeout(timer); clearInterval(poll); }
}

async function toError(res) {
  let msg = `${res.status}`, details = [];
  try { const j = await res.json(); msg = j.error?.message || msg; details = j.error?.details || []; } catch {}
  if (res.status === 400 && /api key/i.test(msg)) return new AIError('The AI key was rejected. Check it was copied completely.', { status: 400 });
  if (res.status === 403) return new AIError(`The AI key is not allowed to use this service: ${msg}`, { status: 403 });
  if (res.status === 404) return new AIError(`This AI model is not available: ${msg}`, { status: 404, quota: true });
  if (res.status === 429) {
    // Google says how long to wait (RetryInfo) and which limit was hit (QuotaFailure)
    const retry = details.find(d => /RetryInfo/.test(d['@type'] || ''))?.retryDelay;
    const waitMs = retry ? Math.ceil(parseFloat(retry) * 1000) : null;
    const daily = /per\s*day|PerDay|daily/i.test(msg + JSON.stringify(details));
    if (daily) return new AIError('The free daily AI limit for this model is used up.', { status: 429, quota: true });
    return new AIError('The free per-minute AI limit was reached.', { status: 429, retryable: true, waitMs });
  }
  if (res.status >= 500) return new AIError(`The AI service had a problem (${res.status}).`, { status: res.status, retryable: true });
  return new AIError(`AI request failed: ${msg}`, { status: res.status });
}

/**
 * options: apiKey, model (force one), fetchImpl, timeoutMs (per request), gapMs (spacing),
 *          maxWaitMs (longest single wait for a limit), onWait(message)
 */
export function geminiProvider({ apiKey, model, fetchImpl = (...a) => fetch(...a), timeoutMs = 90000, budgetMs = 180000, gapMs = 4000, maxWaitMs = 65000, onWait = () => {}, isStopped = () => false }) {
  let models = model ? [model] : null, current = 0, lastCall = 0, thinkingOk = true;
  const stopCheck = () => { if (isStopped()) throw new AIError('Stopped.', { stopped: true }); };
  return {
    name: 'Google Gemini',
    async model() {
      if (!models) models = await listModels(apiKey, fetchImpl, Math.min(timeoutMs, 30000));
      return models[current];
    },
    async generate({ system, text, images = [], schema }) {
      await this.model();
      const parts = [{ text }];
      for (const im of images) {
        parts.push({ text: `Image "${im.name}": shows x ${im.box[0]}–${im.box[2]}, y ${im.box[1]}–${im.box[3]} of the sheet.` });
        parts.push({ inline_data: { mime_type: im.mime, data: im.data } });
      }
      const makeBody = () => JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0, responseMimeType: 'application/json', responseSchema: schema,
          ...(thinkingOk ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
        },
      });
      const deadline = Date.now() + budgetMs;
      const left = () => deadline - Date.now();
      // wait in small steps so Stop works during waits
      const pause = async ms => { const end = Date.now() + Math.min(ms, Math.max(0, left())); while (Date.now() < end) { stopCheck(); await sleep(Math.min(500, end - Date.now())); } };
      let lastErr, timeouts = 0, sentThinking = thinkingOk;
      for (let attempt = 0; attempt < 6; attempt++) {
        stopCheck();
        if (left() < 5000) break;
        const since = Date.now() - lastCall;
        if (since < gapMs) await pause(gapMs - since);
        lastCall = Date.now();
        const m = models[current];
        let res;
        try {
          sentThinking = thinkingOk;
          res = await timedFetch(fetchImpl, `${BASE}/models/${m}:generateContent`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: makeBody(),
          }, Math.min(timeoutMs, left()), isStopped);
        } catch (e) {
          if (e.stopped) throw e;
          lastErr = e;
          if (/did not answer/.test(e.message) && ++timeouts >= 2) break;   // two slow answers in a row: give up on this one
          onWait(`${e.message} Trying again…`);
          await pause(2000 * 2 ** Math.min(attempt, 3)); continue;
        }
        if (!res.ok) {
          lastErr = await toError(res);
          // this model does not accept the "short thinking" setting: ask again without it
          if (lastErr.status === 400 && sentThinking && /think/i.test(lastErr.message)) { thinkingOk = false; continue; }
          if (lastErr.quota && current < models.length - 1) {
            current++;
            onWait(`${lastErr.message} Switching to ${models[current]}…`);
            continue;
          }
          if (lastErr.retryable) {
            const wait = Math.min(lastErr.waitMs ?? 2000 * 2 ** Math.min(attempt, 3), maxWaitMs);
            if (left() < wait + 5000) break;
            onWait(lastErr.status === 429 ? `${lastErr.message} Waiting ${Math.round(wait / 1000)} s…`
              : `Google's AI service is busy (${lastErr.status || 'no answer'}). Trying again in ${Math.round(wait / 1000)} s…`);
            await pause(wait);
            continue;
          }
          throw lastErr;
        }
        const j = await res.json();
        const cand = j.candidates?.[0];
        const out = cand?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('') || '';
        if (!out) { lastErr = new AIError(`The AI returned no answer (${cand?.finishReason || j.promptFeedback?.blockReason || 'unknown reason'}).`, { retryable: true }); continue; }
        try { return { json: JSON.parse(out), model: m, usage: j.usageMetadata }; }
        catch { lastErr = new AIError('The AI answer was not valid JSON.', { retryable: true }); continue; }
      }
      if (lastErr && !/gave up/.test(lastErr.message)) lastErr.message += ' Gave up on this sheet for now.';
      throw lastErr || new AIError('The AI request failed.');
    },
  };
}
