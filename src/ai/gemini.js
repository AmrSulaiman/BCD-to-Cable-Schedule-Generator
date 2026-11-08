// gemini.js — talks to Google's Gemini API. This is the only file that knows about Google:
// to use another provider, write another file with the same `generate` function.
//
// generate({ system, text, images, schema }) -> parsed JSON matching `schema`
//   images: [{ name, box, mime, data(base64) }]

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class AIError extends Error {
  constructor(message, { status, retryable } = {}) { super(message); this.status = status; this.retryable = !!retryable; }
}

// Pick the newest general "Flash" model this key can use (free tier friendly).
// Free-tier model names change over time, so they are looked up rather than hard-coded.
export async function pickModel(apiKey, fetchImpl = fetch) {
  const res = await fetchImpl(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } });
  if (!res.ok) throw await toError(res);
  const { models = [] } = await res.json();
  const ok = models
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /^gemini-\d+(\.\d+)?-flash(-preview(-[\w-]+)?)?$/.test(n) && !/image|tts|audio|live|thinking/.test(n));
  if (!ok.length) throw new AIError('No suitable Gemini Flash model is available for this key.');
  const ver = n => parseFloat(n.match(/gemini-(\d+(\.\d+)?)/)[1]);
  // newest version first; prefer a stable name over a preview of the same version
  ok.sort((a, b) => (ver(b) - ver(a)) || (/preview/.test(a) - /preview/.test(b)));
  return ok[0];
}

async function toError(res) {
  let msg = `${res.status}`;
  try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
  if (res.status === 400 && /api key/i.test(msg)) return new AIError('The AI key was rejected. Check it was copied completely.', { status: 400 });
  if (res.status === 403) return new AIError(`The AI key is not allowed to use this service: ${msg}`, { status: 403 });
  if (res.status === 429) return new AIError('The free AI limit was reached. Wait a minute and try again.', { status: 429, retryable: true });
  if (res.status >= 500) return new AIError(`The AI service had a problem (${res.status}).`, { status: res.status, retryable: true });
  return new AIError(`AI request failed: ${msg}`, { status: res.status });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function geminiProvider({ apiKey, model, fetchImpl = (...a) => fetch(...a) }) {
  let chosen = model;
  return {
    name: 'Google Gemini',
    async model() { return chosen || (chosen = await pickModel(apiKey, fetchImpl)); },
    async generate({ system, text, images = [], schema }) {
      const m = await this.model();
      const parts = [{ text }];
      for (const im of images) {
        parts.push({ text: `Image "${im.name}": shows x ${im.box[0]}–${im.box[2]}, y ${im.box[1]}–${im.box[3]} of the sheet.` });
        parts.push({ inline_data: { mime_type: im.mime, data: im.data } });
      }
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
      };
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await sleep(2000 * 2 ** (attempt - 1));
        let res;
        try {
          res = await fetchImpl(`${BASE}/models/${m}:generateContent`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body),
          });
        } catch (e) { lastErr = new AIError(`Could not reach the AI service: ${e.message}`, { retryable: true }); continue; }
        if (!res.ok) { lastErr = await toError(res); if (lastErr.retryable) continue; throw lastErr; }
        const j = await res.json();
        const cand = j.candidates?.[0];
        const out = cand?.content?.parts?.map(p => p.text || '').join('') || '';
        if (!out) { lastErr = new AIError(`The AI returned no answer (${cand?.finishReason || j.promptFeedback?.blockReason || 'unknown reason'}).`, { retryable: true }); continue; }
        try { return { json: JSON.parse(out), model: m, usage: j.usageMetadata }; }
        catch { lastErr = new AIError('The AI answer was not valid JSON.', { retryable: true }); continue; }
      }
      throw lastErr;
    },
  };
}
