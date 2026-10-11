'use strict';

/* Signal Glass — read and answer Signal messages on Meta Ray-Ban Display
   glasses. Signal has no web API, so the app talks to the owner's own bridge
   (bridge/ in this repo, on the home NAS) through the relay Worker. Every
   request and answer is AES-GCM encrypted; the relay only passes them on. */

const APP = { name: 'Signal Glass', version: '1.0.0' };
const CFG = window.APP_CONFIG || {};
const CONTEXT = 'signalglass v1';

// One pinch each. Edit freely; the first row of the reply screen takes dictation.
const QUICK_REPLIES = [
  'OK',
  'Yes',
  'No',
  'Thanks!',
  'On my way',
  'I will call you later',
  'Can not talk now',
  'Pridem čez 10 minut',
  'Pokličem kasneje',
  'Hvala!',
];

const store = makeStore('sg.');
let link = store.get('link', null);   // { bridge, dev, key } after pairing
let demo = /[?&]demo=1/.test(location.search);

/* ----------------------------------------------------------------- crypto */

const te = new TextEncoder();
const td = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function sha(...parts) {
  const bufs = parts.map((p) => (typeof p === 'string' ? te.encode(p) : new Uint8Array(p)));
  const all = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bufs) { all.set(b, at); at += b.length; }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
}

let aes = null;
async function aesKey() {
  if (!aes) aes = await crypto.subtle.importKey('raw', unb64(link.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return aes;
}

async function rpc(method, args, timeout) {
  if (demo) return demoRpc(method, args || {});
  const key = await aesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    te.encode(JSON.stringify({ m: method, a: args || {}, t: Date.now() })));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout || 20000);
  let r;
  try {
    // A plain-text body keeps this a "simple" request: no CORS preflight.
    r = await fetch(`${CFG.relay}/bridge/${link.bridge}/rpc`, {
      method: 'POST', body: JSON.stringify({ d: link.dev, iv: b64(iv), ct: b64(ct) }), signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const j = await r.json().catch(() => ({ e: 'bad_response' }));
  if (j.error === 'bridge_offline') throw Object.assign(new Error('The bridge at home is not connected.'), { offline: true });
  if (j.error) throw new Error(j.error === 'bridge_timeout' ? 'The bridge took too long to answer.' : j.error);
  if (j.e === 'unpaired') throw Object.assign(new Error('These glasses are no longer paired.'), { unpaired: true });
  if (j.e === 'clock') throw new Error('The clock on the glasses or the bridge is wrong.');
  if (j.e) throw new Error(j.e);
  const out = JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(j.iv) }, key, unb64(j.ct))));
  if (!out.ok) throw new Error(out.e);
  return out.r;
}

function unpair() {
  link = null;
  aes = null;
  demo = false;
  home = null;
  store.del('link');
  stopEvents();
  render({ name: 'home' });
}

/* ---------------------------------------------------------------- pairing */

// No typing on the glasses: they show a code, the owner types it on the
// bridge page at home. Both then show the same check number.
function pairScreen() {
  let dead = false;
  let timer = null;
  const code = h('div', { class: 'code wide', 'aria-live': 'polite' }, '······');
  const note = h('p', {}, 'Open the Signal Glass bridge page at home and enter this code under "Glasses".');
  const el = h('section', { class: 'screen' },
    h('div', { class: 'center' }, h('p', { class: 'big' }, 'Pair with your bridge'), code, note),
    h('div', { class: 'stack' },
      h('button', { class: 'btn f', 'data-first': true, onclick: fresh }, 'New code'),
      h('button', { class: 'btn f', onclick: () => { demo = true; render({ name: 'home' }); } }, 'Open demo')));

  async function fresh() {
    clearTimeout(timer);
    code.textContent = '······';
    try {
      const digits = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
      const mine = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const pub = new Uint8Array(await crypto.subtle.exportKey('raw', mine.publicKey));
      const r = await fetch(`${CFG.relay}/pair/${digits}/offer`, { method: 'POST', body: JSON.stringify({ pub: b64(pub) }) });
      if (!r.ok) throw new Error('relay ' + r.status);
      if (dead) return;
      code.textContent = digits;
      poll(digits, mine, pub, Date.now() + 9 * 60 * 1000);
    } catch (e) {
      if (dead) return;
      code.textContent = '––––––';
      note.textContent = CFG.relay ? 'No connection to the relay.' : 'No relay address is configured yet. See README.md.';
    }
  }

  function poll(digits, mine, pub, until) {
    timer = setTimeout(async () => {
      if (dead) return;
      if (Date.now() > until) return fresh();
      try {
        const r = await fetch(`${CFG.relay}/pair/${digits}/answer`);
        if (dead) return;
        if (r.ok) {
          const a = await r.json();
          const their = await crypto.subtle.importKey('raw', unb64(a.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
          const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: their }, mine.privateKey, 256);
          const raw = await sha(bits, CONTEXT);
          const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
          const box = JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(a.iv) }, key, unb64(a.ct))));
          const dev = Array.from((await sha(pub)).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
          const digest = await sha(raw, 'check');
          const check = String(new DataView(digest.buffer).getUint32(0) % 10000).padStart(4, '0');
          link = { bridge: box.bridge, dev, key: b64(raw) };
          aes = null;
          store.set('link', link);
          if (dead) return;
          return mount(message('Paired', {
            text: `Check number ${check}. The bridge page must show the same number.`,
            buttons: [{ label: 'Continue', act: () => render({ name: 'home' }) }],
          }));
        }
      } catch (e) { /* keep polling through a dropped request */ }
      poll(digits, mine, pub, until);
    }, 2000);
  }

  const screen = panel(el, 'y');
  screen.destroy = () => { dead = true; clearTimeout(timer); };
  fresh();
  return screen;
}

/* ------------------------------------------------------------------ dates */

const LOCALE = 'en-GB';
const fmtTime = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });
const fmtDate = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
const fmtLong = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });

function daysAgo(ts) {
  const a = new Date();
  a.setHours(0, 0, 0, 0);
  const b = new Date(ts);
  b.setHours(0, 0, 0, 0);
  return Math.round((a - b) / 86400000);
}

function when(ts) {
  const d = daysAgo(ts);
  if (d <= 0) return fmtTime.format(ts);
  if (d === 1) return 'Yesterday';
  if (d < 7) return fmtDay.format(ts);
  return fmtDate.format(ts);
}

/* ----------------------------------------------------------------- events */

let seq = -1;
let listening = false;
let listenSeq = 0;

// One long-held request at a time; the bridge answers the moment a message arrives.
async function listen() {
  if (listening || demo || !link) return;
  listening = true;
  const mine = ++listenSeq;
  while (mine === listenSeq && link && !document.hidden) {
    try {
      const r = await rpc('wait', { since: seq }, 35000);
      if (mine !== listenSeq) break;
      const changed = r.seq !== seq;
      seq = r.seq;
      const open = current && current.chatId;
      const news = (r.events || []).filter((e) => e.chat !== open);
      if (news.length) {
        const e = news[news.length - 1];
        toast(`${e.name}${e.from ? ' · ' + e.from : ''}: ${e.text}`, 4000);
      }
      if (changed && current && current.onEvent) current.onEvent();
    } catch (e) {
      if (e.unpaired) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (mine === listenSeq) listening = false;
}

function stopEvents() {
  listenSeq++;
  listening = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopEvents();
  else if (link) listen();
});

/* ------------------------------------------------------------------- home */

let home = null;   // { chats, index }

function chatRow(c) {
  if (c.action) return plainRow(c);
  const m = c.last;
  const lead = m ? (m.me ? 'You: ' : c.kind === 'group' && m.from ? m.from + ': ' : '') : '';
  return h('button', { class: 'row f' + (c.unread ? '' : ' read') },
    h('div', { class: 'txt' },
      h('div', { class: 'line' },
        h('div', { class: 't' }, c.name),
        m && h('span', { class: 'when' }, when(m.ts))),
      h('div', { class: 'sub' }, m ? lead + m.text.replace(/\s+/g, ' ') : '')),
    c.unread ? h('span', { class: 'badge' }, String(c.unread)) : null);
}

async function loadChats() {
  const r = await rpc('chats');
  seq = r.seq;
  return r;
}

async function homeScreen(live) {
  if (!home) {
    mount(message('Loading chats…', { spin: true }));
    const r = await loadChats();
    if (!live()) return;
    home = { data: r, index: 0 };
  }
  const build = () => home.data.chats.concat([
    { action: 'new', title: 'New message', sub: 'Pick a contact' },
    { action: 'unpair', title: demo ? 'Leave demo' : 'Unpair these glasses', chev: false },
  ]);
  let items = build();
  const list = new VList({
    title: 'Signal',
    counter: false,
    count: items.length,
    index: home.index,
    item: (i) => items[i],
    row: chatRow,
    onMove: (i) => { home.index = i; },
    activate: (it) => {
      if (it.action === 'new') return go({ name: 'contacts' });
      if (it.action === 'unpair') {
        if (demo) return unpair();
        return mount(confirmScreen({
          title: 'Unpair these glasses?',
          text: 'Messages stay on the bridge. Pairing again needs a new code.',
          yesLabel: 'Unpair',
          yes: unpair,
          no: () => render({ name: 'home' }),
        }));
      }
      go({ name: 'chat', id: it.id, title: it.name });
    },
  });
  const refresh = () => loadChats().then((r) => {
    home.data = r;
    if (!live()) return;
    items = build();
    list.count = items.length;
    list.render();
    hint();
  }).catch(() => {});
  const hint = () => {
    const d = home.data;
    if (!d.signal) toast('The Signal service on the bridge is not answering.', 4000);
    else if (!d.linked) toast('Signal is not linked yet. Open the bridge page at home.', 5000);
    else if (!d.chats.length) toast('No messages yet. They appear as they arrive.', 4000);
  };
  list.onEvent = refresh;
  mount(list);
  hint();
  refresh();
  listen();
}

/* ------------------------------------------------------------------- chat */

function thread(msgs, group) {
  if (!msgs.length) return [h('div', { class: 'day' }, 'No messages stored yet.')];
  const out = [];
  let lastDay = null;
  for (const m of msgs) {
    const d = daysAgo(m.ts);
    if (d !== lastDay) {
      lastDay = d;
      out.push(h('div', { class: 'day' }, d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : fmtLong.format(m.ts)));
    }
    out.push(h('div', { class: 'msg' + (m.me ? ' me' : '') },
      group && !m.me && m.from ? h('div', { class: 'who' }, m.from) : null,
      m.text,
      h('span', { class: 'at' }, fmtTime.format(m.ts))));
  }
  return out;
}

async function chatScreen(route, live) {
  mount(message(route.title || 'Opening…', { spin: true }));
  let c = await rpc('chat', { id: route.id });
  if (!live()) return;
  const body = h('div', {});
  const screen = reader({
    title: c.name,
    bottom: true,
    body,
    buttons: [{ label: 'Reply', act: () => go({ name: 'reply', id: c.id, title: c.name }) }],
  });
  screen.body.classList.add('chat');
  screen.body.replaceChildren(...thread(c.msgs, c.kind === 'group'));
  screen.chatId = c.id;
  screen.onEvent = () => rpc('chat', { id: c.id }).then((fresh) => {
    if (!live() || fresh.msgs.length === c.msgs.length) return;
    c = fresh;
    screen.body.replaceChildren(...thread(c.msgs, c.kind === 'group'));
    screen.toEnd();
  }).catch(() => {});
  // The unread badge on the list is stale now.
  if (home) {
    const row = home.data.chats.find((x) => x.id === c.id);
    if (row) home.data.chats[home.data.chats.indexOf(row)] = Object.assign({}, row, { unread: 0 });
  }
  mount(screen);
  listen();
}

function replyScreen(route) {
  const send = (text) => {
    if (!text) return;
    mount(confirmScreen({
      title: `Send to ${route.title}?`,
      text,
      no: () => render(route),
      yes: async () => {
        mount(message('Sending…', { spin: true }));
        try {
          await rpc('send', { id: route.id, text }, 70000);
          toast('Sent');
          back(1);
        } catch (e) {
          mount(message("Couldn't send", {
            text: e.message,
            buttons: [{ label: 'Try again', act: () => send(text) }, { label: 'Cancel', act: () => back(1) }],
          }));
        }
      },
    }));
  };
  const items = [{ input: true, title: 'Dictate or write a message…', submit: send }]
    .concat(QUICK_REPLIES.map((t) => ({ title: t, chev: false })));
  mount(new VList({
    title: route.title,
    counter: false,
    count: items.length,
    index: 1,
    item: (i) => items[i],
    row: plainRow,
    activate: (it) => send(it.title),
  }));
}

async function contactsScreen(live) {
  mount(message('Loading contacts…', { spin: true }));
  const r = await rpc('contacts');
  if (!live()) return;
  mount(new VList({
    title: 'New message',
    count: r.contacts.length,
    item: (i) => r.contacts[i],
    row: (c) => plainRow({ title: c.name }),
    empty: 'No contacts yet.',
    activate: (c) => go({ name: 'chat', id: c.id, title: c.name }),
  }));
}

/* ----------------------------------------------------------------- router */

// Deepest path is home → contacts → chat → reply: four of the platform's five
// history entries. The confirm step swaps in place inside "reply".
let renderSeq = 0;

async function render(route) {
  const seqNow = ++renderSeq;
  const live = () => seqNow === renderSeq;
  try {
    if (!demo && !link) return mount(pairScreen());
    if (route.name === 'chat') return await chatScreen(route, live);
    if (route.name === 'reply') return replyScreen(route);
    if (route.name === 'contacts') return await contactsScreen(live);
    return await homeScreen(live);
  } catch (e) {
    if (!live()) return;
    if (e.unpaired) {
      toast('Pair these glasses again.', 4000);
      return unpair();
    }
    mount(message(e.offline ? 'Bridge offline' : "Couldn't load this", {
      text: e.name === 'AbortError' ? 'No answer. Check the connection.' : e.message,
      buttons: [{ label: 'Try again', act: () => render(route) }],
    }));
  }
}

startUI(render);
