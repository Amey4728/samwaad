import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { langByCode } from './public/langs.js';
import { translateFinal, translatePartial, translateUi, providerName } from './lib/translate.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MAX_PEOPLE = 4;
const CONTEXT_LINES = 8;
const LIVE_PARTIALS = providerName() !== 'free';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** code -> { code, peers: Map<id, peer>, history: [], partials: Map<uid, state> } */
const rooms = new Map();

// ---------- HTTP: static files + two tiny endpoints ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, translation: providerName(), rooms: rooms.size });
    }
    if (url.pathname === '/api/ui') {
      return json(res, 200, await translateUi(url.searchParams.get('lang') || ''));
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = normalize(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return json(res, 404, { error: 'not found' });
    console.error(err);
    json(res, 500, { error: 'server error' });
  }
});

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- helpers ----------
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const publicPeer = (p) => ({ id: p.id, name: p.name, lang: p.lang, color: p.color });
const others = (room, me) => [...room.peers.values()].filter((p) => p.id !== me.id);
// "how much new speech is there" — words for spaced languages, ~chars/2 for Chinese/Japanese
const units = (text, lang) => (/^(ja|zh)/.test(lang)
  ? Math.floor(text.length / 2)
  : text.split(/\s+/).filter(Boolean).length);

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) { r = { code, peers: new Map(), history: [], partials: new Map() }; rooms.set(code, r); }
  return r;
}

function groupByLang(room, me) {
  const m = new Map();
  for (const p of others(room, me)) {
    if (!m.has(p.lang)) m.set(p.lang, []);
    m.get(p.lang).push(p);
  }
  return m;
}

function allow(peer, perMinute = 60) {
  const now = Date.now();
  peer.hits = peer.hits.filter((t) => now - t < 60_000);
  if (peer.hits.length >= perMinute) return false;
  peer.hits.push(now);
  return true;
}

// ---------- WebSocket: the argument itself ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let me = null;
  let room = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'join' && !me) return join(msg);
    if (!me) return;
    const uid = clean(msg.uid, 40);

    switch (msg.type) {
      case 'partial': return onPartial(uid, clean(msg.text, 600));
      case 'final': return onFinal(uid, clean(msg.text, 1200));
      case 'drop':
      case 'retract': {
        const st = room.partials.get(uid);
        if (st && st.owner === me.id) { st.done = true; room.partials.delete(uid); }
        if (msg.type === 'retract') {
          const h = room.history.find((x) => x.uid === uid && x.from === me.id);
          if (h) h.retracted = true;
        }
        for (const p of others(room, me)) send(p.ws, { type: msg.type, from: me.id, uid });
        return;
      }
      case 'huh':      // "I didn't understand this line"
      case 'cutoff': { // "I interrupted before hearing the end of this line"
        const author = room.peers.get(clean(msg.author, 40));
        if (author && author.id !== me.id) send(author.ws, { type: msg.type, from: me.id, uid });
        return;
      }
    }
  });

  function join(msg) {
    const code = clean(msg.room, 8).toUpperCase();
    const lang = langByCode(msg.lang) ? msg.lang : null;
    if (!/^[A-Z0-9]{4,8}$/.test(code) || !lang) {
      return send(ws, { type: 'error', code: 'bad_join', message: 'Bad room code or language.' });
    }
    const r = getRoom(code);
    if (r.peers.size >= MAX_PEOPLE) {
      return send(ws, { type: 'error', code: 'full', message: 'This room is full.' });
    }
    room = r;
    const used = new Set([...r.peers.values()].map((p) => p.color));
    let color = 0;
    while (used.has(color)) color++;
    me = { id: randomUUID().slice(0, 8), name: clean(msg.name, 24) || 'Guest', lang, color, ws, hits: [] };
    r.peers.set(me.id, me);
    send(ws, { type: 'joined', you: publicPeer(me), peers: others(r, me).map(publicPeer), translation: providerName() });
    for (const p of others(r, me)) send(p.ws, { type: 'peer_join', peer: publicPeer(me) });
  }

  // While someone is still talking: relay raw text instantly, translate every few new words.
  function onPartial(uid, text) {
    if (!uid || !text) return;
    for (const p of others(room, me)) send(p.ws, { type: 'partial', from: me.id, uid, text });
    if (!LIVE_PARTIALS) return;
    let st = room.partials.get(uid);
    if (!st) {
      st = { owner: me.id, latest: '', sentUnits: 0, inflight: false, done: false };
      room.partials.set(uid, st);
    }
    if (st.owner !== me.id || st.done) return;
    st.latest = text;
    if (!st.inflight && units(text, me.lang) - st.sentUnits >= 3) runPartial(uid, st);
  }

  async function runPartial(uid, st) {
    st.inflight = true;
    const text = st.latest;
    st.sentUnits = units(text, me.lang);
    await Promise.all([...groupByLang(room, me)].map(async ([lang, peers]) => {
      if (lang === me.lang) return;
      try {
        const translation = await translatePartial({ text, from: me.lang, to: lang });
        if (st.done || !translation) return;
        for (const p of peers) send(p.ws, { type: 'partial_tr', from: me.id, uid, translation });
      } catch { /* live partials are best effort */ }
    }));
    st.inflight = false;
    if (!st.done && units(st.latest, me.lang) - st.sentUnits >= 3) {
      setTimeout(() => { if (!st.done && !st.inflight) runPartial(uid, st); }, 300);
    }
  }

  // A finished line: translate with context, tone and back-translation.
  async function onFinal(uid, text) {
    if (!uid || !text) return;
    const st = room.partials.get(uid);
    if (st) st.done = true;
    room.partials.delete(uid);
    if (!allow(me)) return send(ws, { type: 'error', code: 'slow_down', message: 'Too fast.' });

    const context = room.history.filter((h) => !h.retracted).slice(-CONTEXT_LINES);
    room.history.push({ uid, from: me.id, name: me.name, lang: me.lang, text });
    if (room.history.length > 40) room.history.shift();

    await Promise.all([...groupByLang(room, me)].map(async ([lang, peers]) => {
      if (lang === me.lang) {
        for (const p of peers) {
          send(p.ws, { type: 'final', from: me.id, uid, text, translation: text, back: '', intensity: 0, tone: 'neutral', shift: 'none' });
        }
        return;
      }
      let out;
      try {
        out = await translateFinal({ text, from: me.lang, to: lang, context });
      } catch (err) {
        console.warn('translate failed:', err.message);
        out = { translation: text, back: '', intensity: 0, tone: 'neutral', shift: 'none', failed: true };
      }
      for (const p of peers) send(p.ws, { type: 'final', from: me.id, uid, text, ...out });
      send(ws, { type: 'landed', uid, lang, ...out });
    }));
  }

  ws.on('close', () => {
    if (!me || !room) return;
    room.peers.delete(me.id);
    for (const [uid, st] of room.partials) {
      if (st.owner === me.id) { st.done = true; room.partials.delete(uid); }
    }
    for (const p of room.peers.values()) send(p.ws, { type: 'peer_leave', id: me.id });
    if (room.peers.size === 0) rooms.delete(room.code);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Samvaad on http://localhost:${PORT}  (translation: ${providerName()})`);
});
