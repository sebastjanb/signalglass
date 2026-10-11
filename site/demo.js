'use strict';

/* Sample chats behind the "Open demo" button and ?demo=1. Answers the same
   calls the bridge does, so every screen can be tried with no bridge. */

const demoChats = (() => {
  const ago = (min) => Date.now() - min * 60000;
  const m = (min, me, from, text) => ({ ts: ago(min), me, from, text });
  return [
    { id: 'u:1', kind: 'dm', name: 'Ana Sample', unread: 2, msgs: [
      m(60 * 26, false, 'Ana Sample', 'Did the package arrive?'),
      m(60 * 25, true, null, 'Yes, this morning. Thanks!'),
      m(14, false, 'Ana Sample', 'Are you coming on Saturday?'),
      m(12, false, 'Ana Sample', 'We start at six. Bring nothing, there is plenty of food.'),
    ] },
    { id: 'g:1', kind: 'group', name: 'Sample Family', unread: 0, msgs: [
      m(60 * 50, false, 'Marko Example', 'Who picks up the kids tomorrow?'),
      m(60 * 49, true, null, 'I can.'),
      m(60 * 3, false, 'Eva Example', 'Photos from the weekend are in the album.'),
      m(60 * 2, false, 'Marko Example', 'Great, thanks!'),
    ] },
    { id: 'u:2', kind: 'dm', name: 'Sample Plumber', unread: 0, msgs: [
      m(60 * 24 * 4, true, null, 'Can you come on Tuesday?'),
      m(60 * 24 * 4 - 30, false, 'Sample Plumber', 'Tuesday at 9 works.'),
    ] },
  ];
})();

async function demoRpc(method, a) {
  await new Promise((r) => setTimeout(r, 150));
  const preview = (c) => ({ id: c.id, name: c.name, kind: c.kind, unread: c.unread, last: c.msgs[c.msgs.length - 1] || null });
  const find = (id) => demoChats.find((c) => c.id === id);
  if (method === 'chats') {
    const chats = demoChats.filter((c) => c.msgs.length).map(preview).sort((x, y) => y.last.ts - x.last.ts);
    return { linked: true, signal: true, seq: 0, chats };
  }
  if (method === 'chat') {
    const c = find(a.id);
    c.unread = 0;
    return { id: c.id, name: c.name, kind: c.kind, seq: 0, msgs: c.msgs.slice() };
  }
  if (method === 'contacts') return { contacts: demoChats.filter((c) => c.kind === 'dm').map((c) => ({ id: c.id, name: c.name })) };
  if (method === 'send') {
    find(a.id).msgs.push({ ts: Date.now(), me: true, from: null, text: a.text });
    return { ts: Date.now() };
  }
  return { seq: 0, events: [] };
}
