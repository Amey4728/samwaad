import { LANGS, UI_EN, langByCode } from './langs.js';

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const newUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- state ----------
const S = {
  room: (new URLSearchParams(location.search).get('r') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8),
  name: localStorage.getItem('sv_name') || '',
  lang: localStorage.getItem('sv_lang') || guessLang(),
  voiceOn: localStorage.getItem('sv_voice') !== 'off',
  ui: { ...UI_EN },
  me: null,
  peers: new Map(),
  ws: null,
  stopped: false,
};
const t = (k) => S.ui[k] || UI_EN[k] || k;

function guessLang() {
  for (const n of navigator.languages || [navigator.language || 'en-IN']) {
    const exact = LANGS.find((l) => l.code.toLowerCase() === n.toLowerCase());
    if (exact) return exact.code;
    const base = LANGS.find((l) => l.code.split('-')[0] === n.split('-')[0]);
    if (base) return base.code;
  }
  return 'en-IN';
}

// ---------- UI language ----------
let uiReq = 0;
async function loadUi() {
  const mine = ++uiReq;
  const lang = S.lang;
  document.documentElement.lang = lang.split('-')[0];
  document.documentElement.dir = langByCode(lang)?.rtl ? 'rtl' : 'ltr';
  if (lang.startsWith('en')) { S.ui = { ...UI_EN }; applyUi(); return; }
  try {
    const r = await fetch(`/api/ui?lang=${encodeURIComponent(lang)}`);
    const ui = await r.json();
    if (mine === uiReq) { S.ui = { ...UI_EN, ...ui }; applyUi(); }
  } catch { /* stay in English */ }
}
function applyUi() {
  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  $('#name').placeholder = t('yourName');
  $('#typeBox').placeholder = t('typeHere');
  renderMic();
  renderVoice();
  renderPeers();
}

// ---------- status + feed ----------
let statusTimer;
function status(msg, sticky = false) {
  const n = $('#status');
  clearTimeout(statusTimer);
  if (!msg) { n.classList.add('hidden'); return; }
  n.textContent = msg;
  n.classList.remove('hidden');
  if (!sticky) statusTimer = setTimeout(() => n.classList.add('hidden'), 4000);
}
const feedEl = () => $('#feed');
function stickTo(fn) {
  const f = feedEl();
  const stick = f.scrollHeight - f.scrollTop - f.clientHeight < 140;
  fn();
  if (stick) f.scrollTop = f.scrollHeight;
}
const note = (text) => stickTo(() => feedEl().append(el('div', 'sys', text)));
const buzz = () => navigator.vibrate?.([60, 40, 60]);

// ---------- bubbles ----------
const bubbles = new Map();

class Bubble {
  constructor(uid, mine, peer) {
    this.uid = uid;
    this.mine = mine;
    this.from = peer?.id;
    this.isFinal = false;
    this.root = el('article', `b ${mine ? 'mine' : 'them'} live c${(peer?.color ?? 0) % 4}`);
    const who = el('div', 'who');
    who.append(el('span', 'nm', mine ? t('you') : peer?.name || '…'));
    this.tags = el('span', 'tags');
    who.append(this.tags);
    this.main = el('div', 'main'); this.main.dir = 'auto';
    this.sub = el('div', 'sub'); this.sub.dir = 'auto';
    this.flags = el('div', 'flags');
    this.acts = el('div', 'acts');
    this.root.append(who, this.main, this.sub, this.flags, this.acts);
    stickTo(() => feedEl().append(this.root));
    bubbles.set(uid, this);
  }

  // --- my own lines ---
  setMine(text, live) {
    stickTo(() => { this.main.textContent = text; });
    if (!live && !this.isFinal) {
      this.isFinal = true;
      this.root.classList.remove('live');
      const b = el('button', 'act', t('takeBack'));
      b.onclick = () => { send({ type: 'retract', uid: this.uid }); this.retracted(); };
      this.acts.append(b);
    }
    updateOverlap();
  }
  landed(m) {
    stickTo(() => {
      this.setHeat(m);
      if (m.back) this.sub.replaceChildren(el('span', 'lbl', `${t('landed')}: `), document.createTextNode(m.back));
      if (m.failed) this.flag(t('failed'), 'warn');
    });
  }

  // --- their lines ---
  original(text) {
    if (this.isFinal) return;
    stickTo(() => {
      this.sub.textContent = text;
      if (!this.main.textContent) this.main.textContent = '…';
    });
    updateOverlap();
  }
  liveTranslation(text) {
    if (this.isFinal) return;
    stickTo(() => { this.main.textContent = text; });
  }
  final(m) {
    this.isFinal = true;
    stickTo(() => {
      this.root.classList.remove('live');
      this.main.textContent = m.translation;
      this.sub.textContent = m.translation === m.text ? '' : m.text;
      this.setHeat(m);
      if (m.failed) this.flag(t('failed'), 'warn');
      const replay = el('button', 'act');
      replay.innerHTML = '<svg><use href="#i-vol"/></svg>';
      replay.setAttribute('aria-label', 'Play again');
      replay.onclick = () => speak({ text: m.translation, intensity: m.intensity }, true);
      const huh = el('button', 'act', t('huh'));
      huh.onclick = () => {
        send({ type: 'huh', uid: this.uid, author: this.from });
        huh.disabled = true;
        huh.textContent = t('huhSent');
      };
      this.acts.replaceChildren(replay, huh);
    });
    updateOverlap();
  }

  // --- shared ---
  setHeat(m) {
    const k = Math.max(0, Math.min(3, Number(m.intensity) | 0));
    this.root.classList.remove('i0', 'i1', 'i2', 'i3');
    this.root.classList.add(`i${k}`);
    this.tags.replaceChildren();
    if (m.tone && m.tone !== 'neutral') this.tags.append(el('span', `tag t-${m.tone}`, t(`tone_${m.tone}`)));
    if (m.shift && m.shift !== 'none') this.tags.append(el('span', 'tag shift', t(`shift_${m.shift}`)));
  }
  flag(text, cls) { stickTo(() => this.flags.append(el('div', `flag ${cls}`, text))); }
  retracted() { this.root.classList.add('retracted'); this.acts.replaceChildren(); this.flag(t('tookBack'), 'muted'); }
  stopLive() { if (!this.isFinal) { this.isFinal = true; this.root.classList.remove('live'); } }
  remove() { this.root.remove(); bubbles.delete(this.uid); updateOverlap(); }
}

const mineBubble = (uid) => bubbles.get(uid) || new Bubble(uid, true, S.me);
const theirBubble = (from, uid) =>
  bubbles.get(uid) || new Bubble(uid, false, S.peers.get(from) || { id: from, name: '…', color: 1 });

function updateOverlap() {
  let mine = false, theirs = false;
  for (const b of bubbles.values()) {
    if (b.isFinal) continue;
    if (b.mine) mine = true; else theirs = true;
  }
  $('#room').classList.toggle('clash', mine && theirs);
}

// ---------- peers + sharing ----------
function renderPeers() {
  const box = $('#peers');
  box.replaceChildren();
  for (const p of [S.me, ...S.peers.values()].filter(Boolean)) {
    const chip = el('span', `peer c${p.color % 4}`);
    chip.append(
      el('b', null, p.id === S.me?.id ? `${p.name} (${t('you')})` : p.name),
      el('span', 'pl', langByCode(p.lang)?.native || p.lang),
    );
    box.append(chip);
  }
  $('#share').classList.toggle('hidden', S.peers.size > 0 || !S.me);
}

function setupShare() {
  const link = `${location.origin}/?r=${S.room}`;
  $('#link').value = link;
  $('#roomCode').textContent = S.room;
  $('#qr').src = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=8&data=${encodeURIComponent(link)}`;
  $('#copy').onclick = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: 'Samvaad', url: link }); return; } catch { /* fall through to copy */ }
    }
    try { await navigator.clipboard.writeText(link); } catch { $('#link').select(); document.execCommand('copy'); }
    $('#copy').textContent = t('copied');
    setTimeout(() => { $('#copy').textContent = t('copy'); }, 1500);
  };
}

// ---------- socket ----------
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room: S.room, name: S.name, lang: S.lang }));
    status('');
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    handle(m);
  };
  ws.onclose = () => {
    if (S.stopped) return;
    status(t('reconnecting'), true);
    setTimeout(connect, 1500);
  };
}
const send = (o) => { if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(o)); };

function handle(m) {
  switch (m.type) {
    case 'joined':
      S.me = m.you;
      S.peers = new Map(m.peers.map((p) => [p.id, p]));
      renderPeers();
      break;
    case 'peer_join':
      S.peers.set(m.peer.id, m.peer);
      renderPeers();
      note(`${m.peer.name} ${t('joined')}`);
      break;
    case 'peer_leave': {
      const p = S.peers.get(m.id);
      S.peers.delete(m.id);
      renderPeers();
      if (p) note(`${p.name} ${t('left')}`);
      for (const b of bubbles.values()) if (!b.mine && b.from === m.id) b.stopLive();
      updateOverlap();
      break;
    }
    case 'partial':
      theirBubble(m.from, m.uid).original(m.text);
      break;
    case 'partial_tr':
      theirBubble(m.from, m.uid).liveTranslation(m.translation);
      break;
    case 'final':
      theirBubble(m.from, m.uid).final(m);
      if (!m.failed) speak({ uid: m.uid, from: m.from, text: m.translation, intensity: m.intensity });
      break;
    case 'drop':
      bubbles.get(m.uid)?.remove();
      break;
    case 'retract':
      bubbles.get(m.uid)?.retracted();
      speak({ text: t('tookBack') });
      break;
    case 'landed':
      bubbles.get(m.uid)?.landed(m);
      break;
    case 'huh':
      bubbles.get(m.uid)?.flag(t('huhToYou'), 'huh');
      speak({ text: t('huhToYou') });
      buzz();
      break;
    case 'cutoff':
      bubbles.get(m.uid)?.flag(t('cutoff'), 'cut');
      break;
    case 'error':
      status(m.code === 'full' ? t('full') : m.code === 'slow_down' ? t('slowDown') : m.message);
      if (m.code === 'full' || m.code === 'bad_join') { S.stopped = true; S.ws.close(); }
      break;
  }
}

// ---------- speaking (text to speech) ----------
const synth = window.speechSynthesis;
let voices = [];
const loadVoices = () => { voices = synth?.getVoices() || []; };
if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }

function pickVoice(lang) {
  const norm = (v) => v.lang.replace('_', '-').toLowerCase();
  const L = lang.toLowerCase();
  const base = L.split('-')[0];
  return voices.find((v) => norm(v) === L) || voices.find((v) => norm(v).split('-')[0] === base) || null;
}

// iOS only lets a page speak after a tap, so speak silence inside the Start tap.
function primeSpeech() {
  if (!synth) return;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); } catch { /* ignore */ }
}

const tts = { queue: [], current: null };
const echoes = []; // what this phone said recently, so the mic can ignore it

function speak(item, force = false) {
  if (!synth || !item.text || (!S.voiceOn && !force)) return;
  if (force) { tts.queue = []; tts.current = null; synth.cancel(); }
  tts.queue.push(item);
  // In a fight, late is worse than skipped. Keep at most two waiting; older ones stay on screen.
  if (tts.queue.length > 2) tts.queue.splice(0, tts.queue.length - 2);
  if (!tts.current) nextSpeech();
}

function nextSpeech() {
  const item = tts.queue.shift();
  tts.current = item || null;
  if (!item) return;
  const u = new SpeechSynthesisUtterance(item.text);
  u.lang = S.lang;
  const v = pickVoice(S.lang);
  if (v) u.voice = v;
  const k = Math.max(0, Math.min(3, Number(item.intensity) | 0));
  u.rate = 1.02 + 0.07 * k;   // heat travels: angrier lines come out faster
  u.pitch = 1 + 0.04 * k;
  const echo = { tokens: tokenSet(item.text), until: Infinity };
  echoes.push(echo);
  while (echoes.length > 6) echoes.shift();
  const done = () => {
    echo.until = Date.now() + 1800;
    if (tts.current === item) { tts.current = null; nextSpeech(); }
  };
  u.onend = done;
  u.onerror = done;
  synth.speak(u);
}

// The listener started talking over the voice: stop it, and tell the speaker they were cut off.
function bargeIn() {
  const cur = tts.current;
  if (!cur) return;
  tts.queue = [];
  tts.current = null;
  synth.cancel();
  if (cur.from && cur.uid) send({ type: 'cutoff', uid: cur.uid, author: cur.from });
}

// ---------- echo filter ----------
function tokenSet(text) {
  const s = text.toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ');
  const parts = /[぀-ヿ㐀-鿿가-힯]/.test(s) ? [...s.replace(/\s+/g, '')] : s.split(/\s+/);
  return new Set(parts.filter(Boolean));
}
function novelty(text) {
  const toks = [...tokenSet(text)];
  const now = Date.now();
  const active = echoes.filter((e) => e.until > now);
  if (!toks.length) return { total: 0, novel: 0 };
  if (!active.length) return { total: toks.length, novel: toks.length };
  const novel = toks.filter((w) => !active.some((e) => e.tokens.has(w))).length;
  return { total: toks.length, novel };
}
const isEcho = (text) => { const n = novelty(text); return n.total > 0 && n.novel / n.total < 0.4; };

// ---------- listening (speech to text) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recWanted = false;
let segUids = new Map();      // result index in this session -> utterance uid
const segText = new Map();    // uid -> latest text
const finalized = new Set();
const lastPartialAt = new Map();

function startMic() {
  if (!SR) { status(t('noMic')); renderMic(); return; }
  recWanted = true;
  if (!rec) {
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => { segUids = new Map(); renderMic(); };
    rec.onresult = onResult;
    rec.onerror = (e) => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
        recWanted = false;
        status(t('noMic'));
      }
      renderMic();
    };
    rec.onend = () => {
      closeOpenSegments();
      // Chrome stops after silence; an argument doesn't, so restart.
      if (recWanted) setTimeout(() => { if (recWanted) { try { rec.start(); } catch { /* already running */ } } }, 200);
      renderMic();
    };
  }
  rec.lang = S.lang;
  try { rec.start(); } catch { /* already running */ }
  renderMic();
}

function stopMic() {
  recWanted = false;
  try { rec?.stop(); } catch { /* ignore */ }
  renderMic();
}

function onResult(e) {
  for (let i = e.resultIndex; i < e.results.length; i++) {
    const res = e.results[i];
    const text = (res[0]?.transcript || '').trim();
    if (res.isFinal) finalSeg(i, text); else partialSeg(i, text);
  }
}

function segUid(i) {
  let u = segUids.get(i);
  if (!u) { u = newUid(); segUids.set(i, u); }
  return u;
}

function partialSeg(i, text) {
  if (!text) return;
  const uid = segUid(i);
  if (finalized.has(uid)) return;
  const n = novelty(text);
  if (n.total && n.novel / n.total < 0.4) return; // that's our own phone talking
  if (n.novel >= 2) bargeIn();
  segText.set(uid, text);
  mineBubble(uid).setMine(text, true);
  const now = performance.now();
  if (now - (lastPartialAt.get(uid) || 0) > 250) {
    lastPartialAt.set(uid, now);
    send({ type: 'partial', uid, text });
  }
}

function finalSeg(i, text) {
  const uid = segUid(i);
  if (finalized.has(uid)) return;
  finalized.add(uid);
  commit(uid, text);
}

function commit(uid, text) {
  if (!text || isEcho(text)) {
    const b = bubbles.get(uid);
    if (b) { b.remove(); send({ type: 'drop', uid }); }
    return;
  }
  bargeIn();
  mineBubble(uid).setMine(text, false);
  send({ type: 'final', uid, text });
}

function closeOpenSegments() {
  for (const uid of segUids.values()) {
    if (finalized.has(uid)) continue;
    finalized.add(uid);
    commit(uid, segText.get(uid) || '');
  }
}

// ---------- controls ----------
function renderMic() {
  const b = $('#mic');
  b.classList.toggle('on', recWanted);
  b.setAttribute('aria-pressed', String(recWanted));
  const label = !SR ? t('noMic') : recWanted ? t('listening') : t('micOff');
  $('#micLabel').textContent = label;
  b.setAttribute('aria-label', label);
}
function renderVoice() {
  const b = $('#voice');
  const label = S.voiceOn ? t('voiceOn') : t('voiceOff');
  b.classList.toggle('off', !S.voiceOn);
  b.querySelector('use').setAttribute('href', S.voiceOn ? '#i-vol' : '#i-mute');
  b.querySelector('.vl').textContent = label;
  b.setAttribute('aria-label', label);
}
function toggleVoice() {
  S.voiceOn = !S.voiceOn;
  localStorage.setItem('sv_voice', S.voiceOn ? 'on' : 'off');
  if (!S.voiceOn) { tts.queue = []; tts.current = null; synth?.cancel(); }
  renderVoice();
}
function onType(e) {
  e.preventDefault();
  const box = $('#typeBox');
  const text = box.value.trim();
  if (!text) return;
  box.value = '';
  const uid = newUid();
  finalized.add(uid);
  bargeIn();
  mineBubble(uid).setMine(text, false);
  send({ type: 'final', uid, text });
}

async function keepAwake() {
  try { await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || $('#room').classList.contains('hidden')) return;
  keepAwake();
  if (recWanted) { try { rec.start(); } catch { /* already running */ } }
});

// ---------- home ----------
function initHome() {
  const sel = $('#lang');
  for (const l of LANGS) {
    const o = el('option', null, l.native === l.name ? l.native : `${l.native} · ${l.name}`);
    o.value = l.code;
    sel.append(o);
  }
  sel.value = langByCode(S.lang) ? S.lang : 'en-IN';
  S.lang = sel.value;
  const grid = $('#langGrid');
  const tiles = LANGS.map((l) => {
    const b = el('button', 'lg');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.lang = l.code;
    b.append(el('span', 'n', l.native));
    if (l.native !== l.name) b.append(el('span', 'e', l.name));
    b.onclick = () => {
      if (sel.value === l.code) return;
      sel.value = l.code;
      sel.dispatchEvent(new Event('change'));
    };
    grid.append(b);
    return b;
  });
  const markLang = () => tiles.forEach((b) => b.setAttribute('aria-checked', String(b.lang === sel.value)));
  markLang();
  tiles.find((b) => b.lang === sel.value)?.scrollIntoView({ block: 'nearest' });
  $('#name').value = S.name;
  if (S.room) {
    $('#invite').classList.remove('hidden');
    $('#go').dataset.i18n = 'join';
  }
  sel.addEventListener('change', () => { S.lang = sel.value; markLang(); loadUi(); });
  $('#go').addEventListener('click', start);
  loadUi();
}

function makeCode() {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(5))].map((x) => a[x % a.length]).join('');
}

function start() {
  S.name = $('#name').value.trim().slice(0, 24) || 'Guest';
  S.lang = $('#lang').value;
  localStorage.setItem('sv_name', S.name);
  localStorage.setItem('sv_lang', S.lang);
  if (!S.room) {
    S.room = makeCode();
    history.replaceState(null, '', `?r=${S.room}`);
  }
  primeSpeech();
  keepAwake();
  $('#home').classList.add('hidden');
  $('#room').classList.remove('hidden');
  setupShare();
  connect();
  startMic();
}

$('#mic').addEventListener('click', () => (recWanted ? stopMic() : startMic()));
$('#voice').addEventListener('click', toggleVoice);
$('#typeForm').addEventListener('submit', onType);
initHome();
