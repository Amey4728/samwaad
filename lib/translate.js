import { UI_EN, TONES, SHIFTS, langByCode } from '../public/langs.js';

const env = process.env;

function resolveProvider() {
  const want = (env.LLM_PROVIDER || '').toLowerCase();
  if (want === 'anthropic' && env.ANTHROPIC_API_KEY) return 'anthropic';
  if (want === 'openai' && env.LLM_API_KEY) return 'openai';
  if (!want && env.ANTHROPIC_API_KEY) return 'anthropic';
  if (!want && env.LLM_API_KEY) return 'openai';
  return 'free';
}
const PROVIDER = resolveProvider();
export const providerName = () => PROVIDER;

const langName = (code) => langByCode(code)?.name || code;

// ---------- prompts ----------
const FINAL_SYSTEM = `You are the live interpreter inside a heated, real-time argument between people who share no language. Your only job is to carry each line across exactly as it was meant.

Rules:
- Be faithful, not polite. Never soften, censor, summarise, mediate, apologise or add anything. Insults stay insults, sarcasm stays sarcasm, swearing stays swearing at the same strength.
- Translate meaning and force, not words. Use natural spoken phrasing a native speaker would use in a fight. Idioms become equivalent idioms.
- Keep it as short as the original. Fragments and unfinished sentences stay unfinished.
- The input comes from speech recognition and may contain misheard words. Translate what was clearly meant.
- Code-mixed speech (Hinglish, Tanglish and so on) is normal. Translate all of it.
- Use the recent lines to work out who "you", "he" and "that" refer to, and to read sarcasm.

Return a single JSON object and nothing else, with these keys:
- "translation": the line in the listener's language.
- "back": your translation rendered literally back into the speaker's language, so the speaker can see how it landed.
- "intensity": 0 calm, 1 firm, 2 heated, 3 shouting or furious.
- "tone": one of ${TONES.join(', ')}.
- "shift": "concedes" if the speaker gives ground or agrees with the other side, "reverses" if they change their own earlier position, "retracts" if they take back what they just said, otherwise "none".`;

const PARTIAL_SYSTEM = `You interpret live speech in a heated argument while the speaker is still talking. Translate the fragment as it stands, faithfully, keeping its force. Do not complete the sentence or guess what comes next. Reply with only the translation, no quotes, no notes.`;

const UI_SYSTEM = (lang) => `You localise short interface strings for a live voice-translation app that people use during arguments. Translate every value into ${lang}. Keep the keys exactly as they are. Keep each string short and natural, the way a native app in ${lang} would say it. Reply with a JSON object only.`;

// ---------- providers ----------
async function callLLM({ system, user, maxTokens = 300, json = false }) {
  if (PROVIDER === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    return (d.content || []).map((c) => c.text || '').join('').trim();
  }

  const base = (env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.LLM_API_KEY}` },
    body: JSON.stringify({
      model: env.LLM_MODEL || 'llama-3.3-70b-versatile',
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`llm ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d.choices?.[0]?.message?.content || '').trim();
}

// Free fallback so the live link never fully dies. No tone, no context.
const mmCode = (code) => { const b = code.split('-')[0]; return b === 'zh' ? 'zh-CN' : b; };
async function freeTranslate(text, from, to) {
  const pair = encodeURIComponent(`${mmCode(from)}|${mmCode(to)}`);
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 480))}&langpair=${pair}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  const d = await r.json();
  const out = d?.responseData?.translatedText;
  if (Number(d?.responseStatus) !== 200 || !out) throw new Error(`mymemory ${d?.responseStatus}`);
  return out;
}

function parseJSON(s) {
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('model did not return JSON');
  return JSON.parse(s.slice(a, b + 1));
}

function guessIntensity(text) {
  const bangs = (text.match(/[!！]/g) || []).length;
  const letters = text.replace(/[^A-Za-z]/g, '');
  const caps = letters.length > 6 ? letters.replace(/[^A-Z]/g, '').length / letters.length : 0;
  return Math.min(3, bangs + (caps > 0.6 ? 2 : 0));
}

// ---------- public API ----------
export async function translateFinal({ text, from, to, context = [] }) {
  if (PROVIDER === 'free') {
    const translation = await freeTranslate(text, from, to);
    return { translation, back: '', intensity: guessIntensity(text), tone: 'neutral', shift: 'none' };
  }
  const ctx = context.length
    ? context.map((c) => `${c.name} (${langName(c.lang)}): ${c.text}`).join('\n')
    : '(this is the first line)';
  const user = `Recent lines, oldest first:
${ctx}

The speaker talks in ${langName(from)}. The listener understands only ${langName(to)}.
Translate this line:
"""${text}"""

Reply with the JSON object.`;
  const j = parseJSON(await callLLM({ system: FINAL_SYSTEM, user, maxTokens: 500, json: true }));
  if (typeof j.translation !== 'string' || !j.translation.trim()) throw new Error('empty translation');
  const intensity = Math.max(0, Math.min(3, Math.round(Number(j.intensity) || 0)));
  return {
    translation: j.translation.trim(),
    back: typeof j.back === 'string' ? j.back.trim() : '',
    intensity,
    tone: TONES.includes(j.tone) ? j.tone : 'neutral',
    shift: SHIFTS.includes(j.shift) ? j.shift : 'none',
  };
}

export async function translatePartial({ text, from, to }) {
  if (PROVIDER === 'free') throw new Error('live partials need an LLM');
  const out = await callLLM({
    system: PARTIAL_SYSTEM,
    user: `From ${langName(from)} into ${langName(to)}:\n${text}`,
    maxTokens: 200,
  });
  return out.replace(/^["“”'`]+|["“”'`]+$/g, '').trim();
}

const uiCache = new Map();
export function translateUi(code) {
  if (!langByCode(code) || code.startsWith('en')) return Promise.resolve(UI_EN);
  if (!uiCache.has(code)) {
    uiCache.set(code, buildUi(code).catch((err) => {
      console.warn('ui translation failed:', err.message);
      uiCache.delete(code);
      return UI_EN;
    }));
  }
  return uiCache.get(code);
}

async function buildUi(code) {
  if (PROVIDER === 'free') {
    const pairs = await Promise.all(Object.entries(UI_EN).map(async ([k, v]) => {
      try { return [k, await freeTranslate(v, 'en-IN', code)]; } catch { return [k, v]; }
    }));
    return Object.fromEntries(pairs);
  }
  const out = await callLLM({
    system: UI_SYSTEM(langName(code)),
    user: JSON.stringify(UI_EN, null, 1),
    maxTokens: 2500,
    json: true,
  });
  const j = parseJSON(out);
  const res = { ...UI_EN };
  for (const k of Object.keys(UI_EN)) {
    if (typeof j[k] === 'string' && j[k].trim()) res[k] = j[k].trim();
  }
  return res;
}
