// Signal Glass relay on Cloudflare Workers. A blind pipe between the glasses
// and the bridge on the home NAS, so the NAS needs no open port:
//
//   GET  /bridge/<id>/ws?k=<secret>   the bridge holds this WebSocket open
//   POST /bridge/<id>/rpc             the glasses' request; answered by the bridge
//   POST /pair/<code>/offer|answer    one-time key exchange by 6-digit code
//   GET  /pair/<code>/offer|answer
//
// Requests and answers are AES-GCM encrypted between glasses and bridge. This
// Worker never holds the key, stores no messages and logs nothing.

import { DurableObject } from 'cloudflare:workers';

const BRIDGE = /^\/bridge\/([a-f0-9]{32})\/(ws|rpc)$/;
const PAIR = /^\/pair\/(\d{6})\/(offer|answer)$/;
const MAX_BODY = 64 * 1024;
const RPC_WAIT = 30000;
const PAIR_TTL = 10 * 60 * 1000;

const json = (body, status = 200, extra) => new Response(JSON.stringify(body), {
  status,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra),
});

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class Pipe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();
    // Keep-alives are answered without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  socket() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === 1).pop() || null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'upgrade_required' }, 426);
      // The first bridge to use an id owns it; later connections must know its secret.
      const hash = await sha256(url.searchParams.get('k') || '');
      const known = await this.ctx.storage.get('secret');
      if (!known) await this.ctx.storage.put('secret', hash);
      else if (known !== hash) return json({ error: 'forbidden' }, 403);
      for (const old of this.ctx.getWebSockets()) old.close(1012, 'replaced');
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const ws = this.socket();
    if (!ws) return json({ error: 'bridge_offline' }, 503);
    const body = await request.text();
    if (body.length > MAX_BODY) return json({ error: 'too_large' }, 413);
    const id = crypto.randomUUID();
    let timer;
    const answer = await new Promise((resolve) => {
      this.pending.set(id, resolve);
      timer = setTimeout(() => resolve(null), RPC_WAIT);
      ws.send(JSON.stringify({ id, body }));
    });
    clearTimeout(timer);
    this.pending.delete(id);
    if (answer == null) return json({ error: 'bridge_timeout' }, 504);
    return new Response(answer, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  webSocketMessage(ws, data) {
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    const resolve = this.pending.get(m.id);
    if (resolve) resolve(typeof m.body === 'string' ? m.body : '');
  }

  webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code); } catch (e) { /* already closed */ }
  }
}

export class Pair extends DurableObject {
  async fetch(request) {
    const what = new URL(request.url).pathname.endsWith('/offer') ? 'offer' : 'answer';
    if (request.method === 'POST') {
      const body = await request.text();
      if (body.length > 4096) return json({ error: 'too_large' }, 413);
      // An answer only makes sense for a code the glasses are showing right now.
      if (what === 'answer' && !(await this.ctx.storage.get('offer'))) return json({ error: 'no_such_code' }, 404);
      await this.ctx.storage.put(what, body);
      await this.ctx.storage.setAlarm(Date.now() + PAIR_TTL);
      return json({ ok: true });
    }
    const body = await this.ctx.storage.get(what);
    if (!body) return json({ error: 'not_ready' }, 404);
    if (what === 'answer') await this.ctx.storage.deleteAll();
    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
    // The bridge is not a browser and sends no Origin; pages must be on the list.
    if (origin && !allowed.includes(origin)) return json({ error: 'origin_not_allowed' }, 403);
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const path = new URL(request.url).pathname;
    let stub = null;
    let m = BRIDGE.exec(path);
    if (m && ((m[2] === 'ws' && request.method === 'GET') || (m[2] === 'rpc' && request.method === 'POST'))) {
      stub = env.PIPE.get(env.PIPE.idFromName(m[1]));
    } else if ((m = PAIR.exec(path)) && (request.method === 'GET' || request.method === 'POST')) {
      stub = env.PAIR.get(env.PAIR.idFromName(m[1]));
    }
    if (!stub) return json({ error: 'not_found' }, 404, cors);

    const response = await stub.fetch(request);
    if (response.status === 101) return response;
    const out = new Response(response.body, response);
    for (const k in cors) out.headers.set(k, cors[k]);
    return out;
  },
};
