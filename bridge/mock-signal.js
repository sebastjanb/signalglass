'use strict';

/* Stand-in for signal-cli-rest-api, for trying the bridge with no Signal
   account: `node bridge/mock-signal.js` (port 8797), then start the bridge with
   SIGNAL_API=http://127.0.0.1:8797. POST /mock/incoming {"from","text"} plays
   an incoming message. Sent messages are kept in memory at GET /mock/sent. */

const http = require('node:http');
const { createHash } = require('node:crypto');

const NUMBER = '+38600000000';
const sockets = new Set();
const sent = [];

const frame = (text) => {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length])
    : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([head, data]);
};

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/v1/accounts') return send(200, [NUMBER]);
    if (req.url.startsWith('/v1/contacts/')) {
      return send(200, [
        { number: '+38611111111', uuid: 'aaaa-1', name: 'Ana Sample', profile_name: 'Ana' },
        { number: '+38622222222', uuid: 'bbbb-2', name: '', profile_name: 'Marko Example' },
      ]);
    }
    if (req.url.startsWith('/v1/groups/')) return send(200, [{ id: 'group.R1JPVVAx', internal_id: 'GROUP1', name: 'Sample Family' }]);
    if (req.url === '/v2/send' && req.method === 'POST') {
      sent.push(body);
      return send(201, { timestamp: String(Date.now()) });
    }
    if (req.url === '/mock/sent') return send(200, sent);
    if (req.url === '/mock/incoming' && req.method === 'POST') {
      const ana = body.from !== 'marko';
      const envelope = {
        source: ana ? '+38611111111' : '+38622222222', sourceNumber: ana ? '+38611111111' : '+38622222222',
        sourceUuid: ana ? 'aaaa-1' : 'bbbb-2', sourceName: ana ? 'Ana' : 'Marko Example', timestamp: Date.now(),
        dataMessage: { timestamp: Date.now(), message: body.text, groupInfo: body.group ? { groupId: 'GROUP1', type: 'DELIVER' } : undefined },
      };
      for (const s of sockets) s.write(frame(JSON.stringify({ envelope, account: NUMBER })));
      return send(200, { ok: true, listeners: sockets.size });
    }
    send(404, { error: 'not found' });
  });
});

server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => sockets.delete(socket));
});

server.listen(8797, '127.0.0.1', () => console.log('mock Signal API on 127.0.0.1:8797'));
