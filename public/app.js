'use strict';

const CATEGORIES = ['Produce', 'Dairy', 'Bakery', 'Meat & Fish', 'Pantry', 'Frozen', 'Drinks', 'Snacks', 'Household', 'Personal care', 'Other'];

const $ = (id) => document.getElementById(id);
const store = {
  get(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

let me = store.get('grocery.name');
let code = store.get('grocery.code');
let items = [];
let lastSeen = new Map(); // id -> updatedAt, to highlight changes made by others
let events = null;

// ---------- network ----------

function headers() {
  return { 'Content-Type': 'application/json', 'X-Family-Code': code };
}

async function checkAccess() {
  const res = await fetch('/api/list', { headers: headers() });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error('Server error');
  return true;
}

async function send(op) {
  try {
    const res = await fetch('/api/ops', { method: 'POST', headers: headers(), body: JSON.stringify({ ...op, by: me }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not save');
  } catch (err) {
    toast(navigator.onLine ? err.message : 'You are offline, change not saved');
  }
}

function connect() {
  if (events) events.close();
  setStatus('connecting');
  events = new EventSource('/api/events?code=' + encodeURIComponent(code));
  events.addEventListener('state', (e) => {
    setStatus('live');
    const state = JSON.parse(e.data);
    render(state.items);
  });
  events.onerror = () => setStatus(navigator.onLine ? 'connecting' : 'offline');
}

// Phones suspend background tabs; reconnect when the app comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && events && events.readyState === EventSource.CLOSED) connect();
});
window.addEventListener('online', () => { if (events) connect(); });
window.addEventListener('offline', () => setStatus('offline'));

// ---------- UI ----------

function setStatus(kind) {
  const el = $('status');
  el.className = 'status ' + (kind === 'live' ? 'live' : kind === 'offline' ? 'offline' : '');
  el.textContent = kind === 'live' ? 'Live' : kind === 'offline' ? 'Offline' : 'Connecting…';
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function itemRow(item, changedByOther) {
  const li = document.createElement('li');
  li.className = 'item' + (item.done ? ' done' : '') + (changedByOther ? ' flash' : '');

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'check';
  check.checked = item.done;
  check.setAttribute('aria-label', (item.done ? 'Uncheck ' : 'Check off ') + item.name);
  check.addEventListener('change', () => send({ type: 'toggle', id: item.id, done: check.checked }));

  const body = document.createElement('div');
  body.className = 'body';
  body.title = 'Tap to edit';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = item.name;
  if (item.qty) {
    const q = document.createElement('span');
    q.className = 'qty-tag';
    q.textContent = item.qty;
    name.appendChild(q);
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = item.done
    ? `Got by ${item.updatedBy} · ${timeAgo(item.updatedAt)}`
    : `Added by ${item.addedBy} · ${timeAgo(item.createdAt)}`;
  body.append(name, meta);
  body.addEventListener('click', () => editItem(item));

  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = '×';
  del.setAttribute('aria-label', 'Delete ' + item.name);
  del.addEventListener('click', () => send({ type: 'delete', id: item.id }));

  li.append(check, body, del);
  return li;
}

function editItem(item) {
  const name = prompt('Item name', item.name);
  if (name === null) return;
  if (!name.trim()) return send({ type: 'delete', id: item.id });
  const qty = prompt('Quantity (optional)', item.qty || '');
  send({ type: 'edit', id: item.id, name, qty: qty === null ? item.qty : qty });
}

function render(next) {
  const seen = new Map();
  const isFirst = lastSeen.size === 0 && items.length === 0;
  items = next;

  const todo = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done).sort((a, b) => b.updatedAt - a.updatedAt);

  const groups = new Map();
  for (const item of todo) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  const order = (c) => { const i = CATEGORIES.indexOf(c); return i === -1 ? CATEGORIES.length : i; };
  const sortedCats = [...groups.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b));

  const changed = (item) => {
    seen.set(item.id, item.updatedAt);
    return !isFirst && lastSeen.get(item.id) !== item.updatedAt && item.updatedBy !== me;
  };

  const list = $('list');
  list.replaceChildren();
  for (const cat of sortedCats) {
    const h = document.createElement('h2');
    h.textContent = cat;
    const ul = document.createElement('ul');
    ul.className = 'items';
    for (const item of groups.get(cat).sort((a, b) => a.createdAt - b.createdAt)) ul.appendChild(itemRow(item, changed(item)));
    list.append(h, ul);
  }

  const doneList = $('done-list');
  doneList.replaceChildren(...done.map((item) => itemRow(item, changed(item))));
  $('done-section').hidden = done.length === 0;

  $('empty').hidden = items.length > 0;
  $('summary').textContent = items.length ? `${todo.length} to buy · ${done.length} in the cart` : '';
  lastSeen = seen;
}

// ---------- setup ----------

async function start() {
  $('setup').hidden = true;
  $('app').hidden = false;
  $('who').textContent = me;
  connect();
}

async function showSetup(error) {
  $('app').hidden = true;
  $('setup').hidden = false;
  $('setup-name').value = me;
  $('setup-code').value = code;
  $('setup-error').hidden = !error;
  $('setup-error').textContent = error || '';
}

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  me = $('setup-name').value.trim().slice(0, 40);
  code = $('setup-code').value;
  if (!me) return;
  try {
    if (!(await checkAccess())) return showSetup('That family code is not right.');
  } catch {
    return showSetup('Cannot reach the server. Check your connection.');
  }
  store.set('grocery.name', me);
  store.set('grocery.code', code);
  start();
});

$('who').addEventListener('click', () => {
  if (events) events.close();
  showSetup();
});

$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('add-name').value.trim();
  if (!name) return;
  send({ type: 'add', name, qty: $('add-qty').value.trim(), category: $('add-cat').value });
  $('add-name').value = '';
  $('add-qty').value = '';
  $('add-name').focus();
});

$('clear-done').addEventListener('click', () => {
  if (confirm('Remove everything that is already in the cart?')) send({ type: 'clearDone' });
});

for (const c of CATEGORIES) {
  const opt = document.createElement('option');
  opt.value = opt.textContent = c;
  $('add-cat').appendChild(opt);
}
$('add-cat').value = 'Other';

// Refresh the "5m ago" labels once a minute.
setInterval(() => { if (items.length) { lastSeen = new Map(items.map((i) => [i.id, i.updatedAt])); render(items); } }, 60000);

(async () => {
  if (!me) return showSetup();
  try {
    if (!(await checkAccess())) return showSetup('Enter the family code to continue.');
  } catch {
    // Server unreachable right now; open anyway, EventSource will keep retrying.
  }
  start();
})();
