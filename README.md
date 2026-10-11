# Signal Glass

Read and answer Signal messages on Meta Ray-Ban Display glasses.

Signal has no web API and its messages are end-to-end encrypted, so a web page cannot talk to Signal by itself.
This project links a small bridge on your own NAS to your Signal account as a linked device:

    Signal  ⇄  signal-cli-rest-api  ⇄  bridge  ⇄  relay Worker  ⇄  glasses
               └──────── on your NAS ────────┘    (Cloudflare)

- `site/` — the glasses app (static page).
- `worker/` — relay on Cloudflare Workers. A blind pipe: it holds the bridge's outgoing WebSocket and passes
  requests through. It has no key, stores no messages and logs nothing. The NAS needs no open port.
- `bridge/` — runs on the NAS next to [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api).
  Keeps the last 200 messages per chat (Signal gives a linked device no history) and answers the glasses.

Glasses and bridge agree on a key when they are paired (ECDH P-256); everything between them is AES-GCM encrypted.

## What to know before using it

- signal-cli is an unofficial Signal client. A Signal protocol change can break it until it is updated.
- The bridge holds your messages in plain text in `/volume1/docker/signalglass/data` on the NAS, and the Signal
  keys of the linked device next to it. Anyone with access to that folder can read them.
- Only messages that arrive after linking are available. Text only: attachments and stickers show as a note.
- The bridge does not send read receipts.

## Setup

### 1. Relay Worker

```bash
npm install
npm run api:deploy
```

Put the printed `https://signalglass.<account>.workers.dev` address into `site/config.js` as `relay`.

### 2. Bridge on the NAS

```bash
bridge/deploy-nas.sh
```

It starts two containers and saves the address of the bridge's admin page (home network only) to a private file.
Open that page.

### 3. Link Signal

On the admin page press **Show QR code**. On the phone: Signal → Settings → Linked devices → Link new device, scan.
If the page still says "Not linked yet" after a minute, run `bridge/deploy-nas.sh restart`.

### 4. Publish and pair

Push to `main`; GitHub Pages publishes `site/`. On the glasses add `https://<user>.github.io/signalglass/` (with the
trailing slash). The app shows a six-digit code: type it on the admin page under **Glasses**. Both then show a
four-digit check number. If the numbers differ, remove the glasses on the admin page and pair again.

## Try it without Signal

- `?demo=1` or **Open demo**: sample chats in the page only.
- Whole chain on the Mac: `node bridge/mock-signal.js`, `npm run api:dev`, then
  `DATA_DIR=./data SIGNAL_API=http://127.0.0.1:8797 RELAY_URL=http://localhost:8789 node bridge/bridge.js`.
  `curl -X POST localhost:8797/mock/incoming -d '{"text":"Hello"}'` plays an incoming message.

## Notes

- Bump `CACHE` in `site/sw.js` with every release.
- Quick replies are the `QUICK_REPLIES` list at the top of `site/app.js`.
- History depth is home → contacts → chat → reply: four of the platform's five entries.
- Icons: `python3 make-icons.py chat site 111,155,255`.
