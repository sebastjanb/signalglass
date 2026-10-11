'use strict';

/* Signal Glass bridge. Runs next to signal-cli-rest-api on the home NAS:

     Signal  ⇄  signal-cli-rest-api  ⇄  this bridge  ⇄  relay Worker  ⇄  glasses

   Signal keeps no history for a linked device and the REST API stores none, so
   the bridge keeps the recent messages itself. It dials out to the relay; no
   port has to be opened to the internet. Everything it sends through the relay
   is AES-GCM encrypted with a key only the paired glasses hold.

   Node 22 or newer, no dependencies. */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { webcrypto: wc, randomBytes, timingSafeEqual } = require('node:crypto');

const DATA = process.env.DATA_DIR || '/data';
const SIGNAL = (process.env.SIGNAL_API || 'http://signal-api:8080').replace(/\/$/, '');
const RELAY = (process.env.RELAY_URL || '').replace(/\/$/, '');
const ADMIN_PORT = +(process.env.ADMIN_PORT || 8790);
const KEEP = 200;            // messages kept per chat
const HOLD = 20000;          // how long a "wait" call is held open
const SKEW = 10 * 60 * 1000; // accepted clock difference to the glasses
const CONTEXT = 'signalglass v1';

const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

/* ------------------------------------------------------------------ files */

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch (e) { return fallback; }
}

function writeJson(name, value) {
  const file = path.join(DATA, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

fs.mkdirSync(DATA, { recursive: true });
const state = readJson('state.json', null) || {
  bridgeId: randomBytes(16).toString('hex'),
  secret: randomBytes(32).toString('hex'),
  adminKey: randomBytes(12).toString('hex'),
  devices: {},
};
const saveState = () => writeJson('state.json', state);
saveState();

/** id -> { id, kind: 'dm'|'group', name, number, uuid, group, msgs: [{ts, me, from, text}], unread } */
const chats = new Map(readJson('chats.json', []).map((c) => [c.id, c]));
let saveTimer = null;
function saveChats() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { writeJson('chats.json', [...chats.values()]); } catch (e) { log('could not save chats:', e.message); }
  }, 2000);
}

/* ----------------------------------------------------------------- Signal */

let account = process.env.SIGNAL_NUMBER || null;
let signalUp = false;
let receiving = false;
const names = new Map();     // 'u:<uuid>' / 'n:<number>' -> display name
const contacts = new Map();  // chat id -> { id, name, number, uuid }
const groups = new Map();    // internal group id -> { name, sendId }

async function signal(pathname, opts) {
  const o = opts || {};
  const r = await fetch(SIGNAL + pathname, {
    method: o.method || 'GET',
    headers: o.body ? { 'Content-Type': 'application/json' } : undefined,
    body: o.body ? JSON.stringify(o.body) : undefined,
    signal: AbortSignal.timeout(o.timeout || 30000),
  });
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch (e) { /* plain text answer */ }
  if (!r.ok) throw new Error((j && j.error) || text.slice(0, 200) || 'Signal API answered ' + r.status);
  return j;
}

const enc = (s) => encodeURIComponent(s);

async function refreshBook() {
  if (!account) return;
  try {
    const list = await signal(`/v1/contacts/${enc(account)}`);
    for (const c of list || []) {
      const p = c.profile || {};
      const name = c.name || c.profile_name || [p.given_name, p.lastname].filter(Boolean).join(' ') || c.username || c.number;
      if (!name) continue;
      if (c.uuid) names.set('u:' + c.uuid, name);
      if (c.number) names.set('n:' + c.number, name);
      const id = c.uuid ? 'u:' + c.uuid : 'n:' + c.number;
      if (!c.blocked) contacts.set(id, { id, name, number: c.number || null, uuid: c.uuid || null });
    }
  } catch (e) { log('contacts:', e.message); }
  try {
    const list = await signal(`/v1/groups/${enc(account)}`);
    for (const g of list || []) {
      if (g.internal_id) groups.set(g.internal_id, { name: g.name || 'Group', sendId: g.id });
    }
  } catch (e) { log('groups:', e.message); }
  // Chats seen before their names were known pick them up here.
  for (const c of chats.values()) {
    const n = c.kind === 'group' ? (groups.get(c.group) || {}).name
      : (c.uuid && names.get('u:' + c.uuid)) || (c.number && names.get('n:' + c.number));
    if (n && n !== c.name) { c.name = n; saveChats(); }
  }
}

function dmChat(uuid, number, hint) {
  let c = (uuid && chats.get('u:' + uuid)) || (number && chats.get('n:' + number));
  if (!c && number) c = [...chats.values()].find((x) => x.kind === 'dm' && x.number === number);
  if (!c) {
    const id = uuid ? 'u:' + uuid : 'n:' + number;
    c = { id, kind: 'dm', name: names.get(id) || hint || number || 'Unknown', number: number || null, uuid: uuid || null, msgs: [], unread: 0 };
    chats.set(id, c);
  }
  if (number && !c.number) c.number = number;
  if (uuid && !c.uuid) c.uuid = uuid;
  const known = (c.uuid && names.get('u:' + c.uuid)) || (c.number && names.get('n:' + c.number));
  if (known) c.name = known;
  else if (hint && (c.name === c.number || c.name === 'Unknown')) c.name = hint;
  return c;
}

function groupChat(internalId) {
  const id = 'g:' + internalId;
  let c = chats.get(id);
  if (!c) {
    c = { id, kind: 'group', name: 'Group', group: internalId, msgs: [], unread: 0 };
    chats.set(id, c);
    refreshBook();
  }
  const g = groups.get(internalId);
  if (g) c.name = g.name;
  return c;
}

function describe(dm) {
  if (!dm) return null;
  const parts = [];
  if (dm.sticker) parts.push('Sticker');
  const files = dm.attachments || [];
  if (files.length) parts.push(files.length === 1 ? 'Attachment' : `${files.length} attachments`);
  let text = dm.message || '';
  if (parts.length) text = `[${parts.join(', ')}]${text ? ' ' + text : ''}`;
  return text || null;
}

function push(chat, msg) {
  // The same message can arrive again after a reconnect.
  if (chat.msgs.some((m) => m.ts === msg.ts && m.me === msg.me && m.text === msg.text)) return false;
  chat.msgs.push(msg);
  chat.msgs.sort((a, b) => a.ts - b.ts);
  if (chat.msgs.length > KEEP) chat.msgs.splice(0, chat.msgs.length - KEEP);
  saveChats();
  return true;
}

/* ---- events for the glasses' long poll */

let seq = 0;
const recent = [];      // last incoming messages: { seq, chat, name, from, text }
const waiters = new Set();

function announce(chat, msg) {
  seq++;
  recent.push({ seq, chat: chat.id, name: chat.name, from: chat.kind === 'group' ? msg.from : null, text: msg.text });
  if (recent.length > 30) recent.shift();
  for (const w of [...waiters]) w();
}

function onEnvelope(env) {
  if (!env) return;
  const name = env.sourceName || null;

  const edited = env.editMessage && env.editMessage.dataMessage;
  const dm = env.dataMessage || edited;
  if (dm) {
    const text = describe(dm);
    if (!text) return;   // reactions, deletes, group changes
    const chat = dm.groupInfo && dm.groupInfo.groupId
      ? groupChat(dm.groupInfo.groupId)
      : dmChat(env.sourceUuid, env.sourceNumber, name);
    const from = (env.sourceUuid && names.get('u:' + env.sourceUuid)) || name || env.sourceNumber || 'Unknown';
    const msg = { ts: dm.timestamp || env.timestamp, me: false, from, text: edited ? '(edited) ' + text : text };
    if (push(chat, msg)) {
      chat.unread = (chat.unread || 0) + 1;
      announce(chat, msg);
    }
    return;
  }

  const sync = env.syncMessage;
  if (!sync) return;
  const sent = sync.sentMessage && (sync.sentMessage.editMessage ? sync.sentMessage.editMessage.dataMessage : sync.sentMessage);
  if (sent) {
    // Written on the phone or another linked device.
    const text = describe(sent);
    if (!text) return;
    const s = sync.sentMessage;
    const chat = sent.groupInfo && sent.groupInfo.groupId
      ? groupChat(sent.groupInfo.groupId)
      : dmChat(s.destinationUuid, s.destinationNumber, null);
    push(chat, { ts: sent.timestamp || s.timestamp || env.timestamp, me: true, from: null, text });
    chat.unread = 0;
    saveChats();
    seq++;
    for (const w of [...waiters]) w();
    return;
  }
  if (Array.isArray(sync.readMessages)) {
    // Read on the phone: clear the badge here too.
    for (const r of sync.readMessages) {
      const c = (r.senderUuid && chats.get('u:' + r.senderUuid)) || (r.senderNumber && chats.get('n:' + r.senderNumber));
      if (c && c.unread) { c.unread = 0; saveChats(); }
    }
  }
}

function receiveLoop() {
  if (receiving || !account) return;
  receiving = true;
  const url = SIGNAL.replace(/^http/, 'ws') + `/v1/receive/${enc(account)}`;
  const ws = new WebSocket(url);
  ws.onopen = () => log('receiving for', account.slice(0, 4) + '…');
  ws.onmessage = (e) => {
    try {
      const j = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8'));
      onEnvelope(j.envelope);
    } catch (err) { log('bad envelope:', err.message); }
  };
  const again = () => {
    if (!receiving) return;
    receiving = false;
    setTimeout(receiveLoop, 5000);
  };
  ws.onclose = again;
  ws.onerror = again;
}

async function watchSignal() {
  try {
    const list = await signal('/v1/accounts', { timeout: 15000 });
    signalUp = true;
    if (!account && Array.isArray(list) && list.length) {
      account = list[0];
      log('Signal account found');
    }
    if (account && !names.size && !groups.size) await refreshBook();
    receiveLoop();
  } catch (e) {
    signalUp = false;
  }
  setTimeout(watchSignal, account ? 60000 : 5000);
}
setInterval(refreshBook, 10 * 60 * 1000);

async function sendText(chat, text) {
  let target = chat.number || chat.uuid;
  if (chat.kind === 'group') {
    if (!groups.has(chat.group)) await refreshBook();
    const g = groups.get(chat.group);
    target = g ? g.sendId : 'group.' + Buffer.from(chat.group).toString('base64');
  }
  const r = await signal('/v2/send', { method: 'POST', body: { number: account, recipients: [target], message: text }, timeout: 60000 });
  const ts = +(r && r.timestamp) || Date.now();
  push(chat, { ts, me: true, from: null, text });
  chat.unread = 0;
  return ts;
}

/* ----------------------------------------------------------------- crypto */

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(String(s), 'base64');
const keys = new Map();   // device id -> CryptoKey

async function deviceKey(id) {
  if (keys.has(id)) return keys.get(id);
  const d = state.devices[id];
  if (!d) return null;
  const k = await wc.subtle.importKey('raw', unb64(d.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
  keys.set(id, k);
  return k;
}

async function seal(key, value) {
  const iv = randomBytes(12);
  const ct = await wc.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(JSON.stringify(value)));
  return { iv: b64(iv), ct: b64(ct) };
}

async function open(key, box) {
  const pt = await wc.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(Buffer.from(pt).toString('utf8'));
}

async function sha(...parts) {
  return Buffer.from(await wc.subtle.digest('SHA-256', Buffer.concat(parts.map((p) => Buffer.from(p)))));
}

// Glasses show a 6-digit code; the owner types it on the admin page. Both sides
// then show the same 4-digit check number, which a swapped key would change.
async function pair(code) {
  if (!RELAY) throw new Error('RELAY_URL is not set');
  const base = RELAY.replace(/^ws/, 'http') + `/pair/${code}`;
  const r = await fetch(base + '/offer', { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('No glasses are showing that code right now.');
  const offer = await r.json();
  const theirRaw = unb64(offer.pub);
  const their = await wc.subtle.importKey('raw', theirRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const mine = await wc.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const bits = await wc.subtle.deriveBits({ name: 'ECDH', public: their }, mine.privateKey, 256);
  const raw = await sha(Buffer.from(bits), CONTEXT);
  const id = (await sha(theirRaw)).toString('hex').slice(0, 16);
  const key = await wc.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const box = await seal(key, { bridge: state.bridgeId });
  const answer = { pub: b64(await wc.subtle.exportKey('raw', mine.publicKey)), iv: box.iv, ct: box.ct };
  const put = await fetch(base + '/answer', { method: 'POST', body: JSON.stringify(answer), signal: AbortSignal.timeout(15000) });
  if (!put.ok) throw new Error('The relay refused the answer (' + put.status + ').');
  state.devices[id] = { key: b64(raw), added: Date.now(), seen: 0 };
  keys.delete(id);
  saveState();
  log('paired glasses', id);
  return { id, check: checkCode(await sha(raw, 'check')) };
}

const checkCode = (digest) => String(digest.readUInt32BE(0) % 10000).padStart(4, '0');

/* -------------------------------------------------------------------- rpc */

const preview = (c) => {
  const m = c.msgs[c.msgs.length - 1];
  return { id: c.id, name: c.name, kind: c.kind, unread: c.unread || 0, last: m ? { ts: m.ts, me: m.me, from: m.from, text: m.text.slice(0, 120) } : null };
};

function findChat(id) {
  let c = chats.get(id);
  if (!c && contacts.has(id)) {
    const k = contacts.get(id);
    c = dmChat(k.uuid, k.number, k.name);
  }
  if (!c) throw new Error('Unknown chat');
  return c;
}

const methods = {
  async state() {
    return { linked: !!account, signal: signalUp, seq };
  },
  async chats() {
    const list = [...chats.values()].filter((c) => c.msgs.length).map(preview)
      .sort((a, b) => (b.last ? b.last.ts : 0) - (a.last ? a.last.ts : 0));
    return { linked: !!account, signal: signalUp, seq, chats: list.slice(0, 60) };
  },
  async chat(a) {
    const c = findChat(a.id);
    if (c.unread) { c.unread = 0; saveChats(); }
    return { id: c.id, name: c.name, kind: c.kind, seq, msgs: c.msgs.slice(-(a.limit || 40)) };
  },
  async contacts() {
    return { contacts: [...contacts.values()].map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)) };
  },
  async send(a) {
    const text = String(a.text || '').trim();
    if (!text) throw new Error('Empty message');
    if (!account) throw new Error('Signal is not linked yet');
    return { ts: await sendText(findChat(a.id), text.slice(0, 2000)) };
  },
  // Held open until something arrives, so the glasses hear of it at once.
  async wait(a) {
    if (!(a.since >= 0 && a.since < seq)) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(t); waiters.delete(done); resolve(); };
        const t = setTimeout(done, HOLD);
        waiters.add(done);
      });
    }
    return { seq, events: a.since >= 0 ? recent.filter((e) => e.seq > a.since) : [] };
  },
};

async function handle(body) {
  let req;
  try { req = JSON.parse(body); } catch (e) { return JSON.stringify({ e: 'bad_request' }); }
  const key = await deviceKey(req.d);
  if (!key) return JSON.stringify({ e: 'unpaired' });
  let call;
  try { call = await open(key, req); } catch (e) { return JSON.stringify({ e: 'unpaired' }); }
  if (Math.abs(Date.now() - call.t) > SKEW) return JSON.stringify({ e: 'clock' });
  const dev = state.devices[req.d];
  if (Date.now() - (dev.seen || 0) > 60000) { dev.seen = Date.now(); saveState(); }
  let out;
  try {
    if (!Object.prototype.hasOwnProperty.call(methods, call.m)) throw new Error('Unknown method');
    out = { ok: true, r: await methods[call.m](call.a || {}) };
  } catch (e) {
    out = { ok: false, e: String(e.message || e).slice(0, 300) };
  }
  return JSON.stringify(await seal(key, out));
}

/* ------------------------------------------------------------------ relay */

let relayUp = false;

function relayLoop() {
  if (!RELAY) return log('RELAY_URL is not set: the glasses cannot reach this bridge');
  const url = RELAY.replace(/^http/, 'ws') + `/bridge/${state.bridgeId}/ws?k=${state.secret}`;
  const ws = new WebSocket(url);
  let alive = true;
  let done = false;
  const beat = setInterval(() => {
    if (!alive) return ws.close();
    alive = false;
    try { ws.send('ping'); } catch (e) { /* closing */ }
  }, 30000);
  ws.onopen = () => { relayUp = true; log('relay connected'); };
  ws.onmessage = async (e) => {
    alive = true;
    if (e.data === 'pong') return;
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    const body = await handle(m.body).catch((err) => JSON.stringify({ e: 'bridge_error', detail: String(err.message) }));
    try { ws.send(JSON.stringify({ id: m.id, body })); } catch (err) { /* relay went away; the glasses retry */ }
  };
  const again = () => {
    if (done) return;
    done = true;
    relayUp = false;
    clearInterval(beat);
    setTimeout(relayLoop, 5000);
  };
  ws.onclose = again;
  ws.onerror = again;
}

/* ------------------------------------------------------------- admin page */

const page = fs.readFileSync(path.join(__dirname, 'admin.html'));

function allowed(url) {
  const k = Buffer.from(url.searchParams.get('k') || '');
  const want = Buffer.from(state.adminKey);
  return k.length === want.length && timingSafeEqual(k, want);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, body, type) => {
    res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  try {
    if (!allowed(url)) return send(403, 'Open this page with the full address the deploy script printed (it ends in ?k=…).', 'text/plain; charset=utf-8');
    if (url.pathname === '/') return send(200, page, 'text/html; charset=utf-8');
    if (url.pathname === '/admin/status') {
      return send(200, {
        signal: signalUp, linked: !!account, account: account ? account.slice(0, 4) + '…' + account.slice(-3) : null,
        relay: relayUp, relayUrl: RELAY || null, chats: [...chats.values()].filter((c) => c.msgs.length).length,
        devices: Object.keys(state.devices).map((id) => ({ id, added: state.devices[id].added, seen: state.devices[id].seen })),
      });
    }
    if (url.pathname === '/admin/qr') {
      const r = await fetch(SIGNAL + '/v1/qrcodelink?device_name=SignalGlass', { signal: AbortSignal.timeout(60000) });
      if (!r.ok) return send(502, (await r.text()).slice(0, 300), 'text/plain; charset=utf-8');
      return send(200, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') || 'image/png');
    }
    if (req.method === 'POST' && url.pathname === '/admin/pair') {
      const b = await readBody(req);
      if (!/^\d{6}$/.test(b.code || '')) return send(400, { error: 'The code has six digits.' });
      return send(200, await pair(b.code));
    }
    if (req.method === 'POST' && url.pathname === '/admin/unpair') {
      const b = await readBody(req);
      delete state.devices[b.id];
      keys.delete(b.id);
      saveState();
      return send(200, { ok: true });
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: String(e.message || e) });
  }
}).listen(ADMIN_PORT, () => {
  log(`admin page on port ${ADMIN_PORT}: /?k=${state.adminKey}`);
});

watchSignal();
relayLoop();

process.on('SIGTERM', () => {
  try { writeJson('chats.json', [...chats.values()]); } catch (e) { /* best effort */ }
  process.exit(0);
});
