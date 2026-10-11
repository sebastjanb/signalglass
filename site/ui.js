'use strict';

/* Shared screen kit for the glasses apps: 600×600 additive display, D-pad
   focus plus pinch (Enter), Back is browser history. Plain globals, no build. */

function makeStore(prefix) {
  return {
    get(k, d) {
      try {
        const v = localStorage.getItem(prefix + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    set(k, v) { try { localStorage.setItem(prefix + k, JSON.stringify(v)); } catch (e) { /* storage may be gone */ } },
    del(k) { try { localStorage.removeItem(prefix + k); } catch (e) { /* same */ } },
  };
}

function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let toastTimer;
function toast(text, ms) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms || 2200);
}

/* ---------------------------------------------------------------- screens */

const ROWS = 5;
const root = document.getElementById('root');
let current = null;

function mount(screen) {
  if (current && current.destroy) current.destroy();
  current = screen;
  root.replaceChildren(screen.el);
  if (screen.focus) screen.focus();
}

function focusables(el) {
  return Array.prototype.slice.call(el.querySelectorAll('.f'));
}

// Screen made of a handful of real buttons. axis 'y' walks them with Up/Down, 'x' with Left/Right.
function panel(el, axis) {
  const prev = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
  const next = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
  return {
    el,
    focus() {
      const f = focusables(el);
      if (f.length) (el.querySelector('.f[data-first]') || f[0]).focus({ preventScroll: true });
    },
    onKey(e) {
      if (e.key !== prev && e.key !== next) return e.key.startsWith('Arrow');
      const f = focusables(el);
      const i = f.indexOf(document.activeElement);
      const n = f[clamp(i + (e.key === next ? 1 : -1), 0, f.length - 1)];
      if (n) n.focus({ preventScroll: true });
      return true;
    },
  };
}

function message(title, opts) {
  const o = opts || {};
  const buttons = (o.buttons || []).map((b, i) =>
    h('button', { class: 'btn f', 'data-first': i === 0, onclick: b.act }, b.label));
  return panel(h('section', { class: 'screen' },
    h('div', { class: 'center' },
      o.spin && h('div', { class: 'spin' }),
      h('p', { class: 'big' }, title),
      o.text && h('p', {}, o.text)),
    buttons.length ? h('div', { class: 'stack' }, buttons) : null), 'y');
}

/* A list that keeps only ROWS real elements in the DOM. The focused row sits
   mid-window, so there is always a real neighbour to move to — this works both
   when the page gets arrow keydowns and when the browser moves focus itself. */
class VList {
  constructor(o) {
    this.o = o;
    this.count = o.count;
    this.index = clamp(o.index || 0, 0, Math.max(0, o.count - 1));
    this.nodes = new Map();
    this.pos = h('span', { class: 'pos' });
    this.body = h('div', { class: 'rows' });
    this.el = h('section', { class: 'screen' },
      h('header', { class: 'head' }, h('h1', {}, o.title), this.pos),
      this.body);
    this.body.addEventListener('focusin', (e) => {
      const n = e.target.closest('[data-i]');
      if (n && +n.dataset.i !== this.index) this.moveTo(+n.dataset.i);
    });
    this.body.addEventListener('click', (e) => {
      const n = e.target.closest('[data-i]');
      if (!n || n.tagName === 'INPUT') return;
      const i = +n.dataset.i;
      o.activate(o.item(i), i);
    });
    this.render();
  }

  render() {
    if (!this.count) {
      this.pos.textContent = '';
      this.body.replaceChildren(h('div', { class: 'center' }, h('p', {}, this.o.empty || 'Nothing here.')));
      return;
    }
    this.index = clamp(this.index, 0, this.count - 1);
    const top = clamp(this.index - 2, 0, Math.max(0, this.count - ROWS));
    const had = this.body.contains(document.activeElement);
    const next = new Map();
    const kids = [];
    for (let i = top; i < Math.min(this.count, top + ROWS); i++) {
      const item = this.o.item(i);
      let n = this.nodes.get(i);
      if (!n || n._item !== item) {
        n = this.o.row(item, i);
        n._item = item;
        n.dataset.i = i;
      }
      next.set(i, n);
      kids.push(n);
    }
    this.nodes = next;
    this.body.replaceChildren(...kids);
    this.pos.textContent = this.o.counter === false ? '' : `${this.index + 1} / ${this.count}`;
    if (had || this.wantFocus) this.focus();
  }

  focus() {
    this.wantFocus = true;
    const n = this.nodes.get(this.index);
    if (n && document.activeElement !== n) n.focus({ preventScroll: true });
  }

  moveTo(i) {
    i = clamp(i, 0, this.count - 1);
    if (i === this.index) return;
    this.index = i;
    if (this.o.onMove) this.o.onMove(i);
    this.wantFocus = true;
    this.render();
  }

  onKey(e) {
    if (e.key === 'ArrowUp') this.moveTo(this.index - 1);
    else if (e.key === 'ArrowDown') this.moveTo(this.index + 1);
    else if (e.key === 'ArrowLeft') this.moveTo(this.index - ROWS);
    else if (e.key === 'ArrowRight') this.moveTo(this.index + ROWS);
    else return false;
    return true;
  }
}

function plainRow(item) {
  if (item.input) {
    return h('input', {
      class: 'row f', type: 'search', placeholder: item.title, 'aria-label': item.title,
      autocomplete: 'off', onchange: (e) => item.submit(e.target.value.trim()),
    });
  }
  return h('button', { class: 'row plain f' },
    h('div', { class: 'txt' },
      h('div', { class: 't' }, item.title),
      item.sub && h('div', { class: 'sub' }, item.sub)),
    item.badge ? h('span', { class: 'badge' }, String(item.badge)) : null,
    item.chev !== false && h('span', { class: 'chev' }, '›'));
}

/* Long text with a row of buttons under it. Up/Down scroll the text,
   Left/Right walk the buttons. o.bottom starts at the end (chat threads). */
function reader(o) {
  const STEP = 240;
  const body = h('div', { class: 'scroll' }, o.body);
  const pos = h('span', { class: 'pos' });
  const btns = (o.buttons || []).map((b, i) =>
    h('button', { class: 'btn f', 'data-first': i === 0, onclick: b.act }, b.label));
  const el = h('section', { class: 'screen read' },
    h('header', { class: 'head' }, h('h1', {}, o.title), pos),
    o.meta ? h('div', { class: 'meta' }, o.meta) : null,
    body,
    h('div', { class: 'ctl' }, btns));
  const mark = () => {
    const max = body.scrollHeight - body.clientHeight;
    pos.textContent = max > 4 ? (body.scrollTop >= max - 2 ? 'end' : '▼ more') : '';
  };
  return {
    el,
    body,
    mark,
    toEnd() { body.scrollTop = body.scrollHeight; mark(); },
    focus() {
      if (btns.length) btns[0].focus({ preventScroll: true });
      if (o.bottom) body.scrollTop = body.scrollHeight;
      mark();
    },
    onKey(e) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        body.scrollTop += e.key === 'ArrowDown' ? STEP : -STEP;
        mark();
        return true;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const i = btns.indexOf(document.activeElement);
        const n = btns[clamp(i + (e.key === 'ArrowRight' ? 1 : -1), 0, btns.length - 1)];
        if (n) n.focus({ preventScroll: true });
        return true;
      }
      return false;
    },
  };
}

// Last look before something leaves the glasses. Mounted in place, so Back
// returns to the screen under the one that asked.
function confirmScreen(o) {
  return panel(h('section', { class: 'screen' },
    h('div', { class: 'center' },
      h('p', { class: 'big' }, o.title),
      o.text && h('p', { class: 'quote' }, o.text)),
    h('div', { class: 'stack' },
      h('button', { class: 'btn f', 'data-first': true, onclick: o.yes }, o.yesLabel || 'Send'),
      h('button', { class: 'btn f', onclick: o.no }, 'Cancel'))), 'y');
}

/* ----------------------------------------------------------------- router */

// The platform allows five history entries. Each app documents its deepest path.
let renderRoute = null;
let skipBack = 0;

function go(route) {
  history.pushState(route, '', '#' + route.name);
  renderRoute(route);
}

// history.go(-n) is not supported on the glasses: step back one entry at a time.
function back(n) {
  skipBack = (n || 1) - 1;
  history.back();
}

// On select the glasses can drop focus before Enter arrives; keep the last control.
let lastFocus = null;
document.addEventListener('focusin', (e) => {
  if (e.target.classList && e.target.classList.contains('f')) lastFocus = e.target;
});

function startUI(render) {
  renderRoute = render;

  window.addEventListener('popstate', (e) => {
    if (skipBack > 0) {
      skipBack--;
      history.back();
      return;
    }
    render(e.state || { name: 'home' });
  });

  document.addEventListener('keydown', (e) => {
    const a = document.activeElement;
    const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
    if (e.key === 'Escape' || (e.key === 'Backspace' && !typing)) {
      // Desktop stand-in for the glasses' Back gesture.
      e.preventDefault();
      if (history.state && history.state.name !== 'home') history.back();
      return;
    }
    if (current && current.onKey && current.onKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !typing) {
      e.preventDefault();
      if (e.repeat) return;
      const t = a && a !== document.body ? a : (lastFocus && document.contains(lastFocus) ? lastFocus : null);
      if (t) t.click();
    }
  });

  window.addEventListener('pagehide', () => { if (current && current.destroy) current.destroy(); });

  history.replaceState({ name: 'home' }, '', location.pathname + location.search);
  render({ name: 'home' });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
}
