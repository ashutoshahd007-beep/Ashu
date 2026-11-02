'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-'));
process.env.DATA_FILE = path.join(dir, 'list.json');
process.env.FAMILY_CODE = 'secret';
const { createServer } = require('../server.js');

let server;
let base;
const H = { 'Content-Type': 'application/json', 'X-Family-Code': 'secret' };

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const op = (body) => fetch(base + '/api/ops', { method: 'POST', headers: H, body: JSON.stringify(body) });

// Reads SSE "state" events from an open stream.
async function openStream() {
  const controller = new AbortController();
  const res = await fetch(base + '/api/events?code=secret', { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  return {
    async next() {
      for (;;) {
        const idx = buf.indexOf('\n\n');
        if (idx !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (chunk.includes('event: state') && data) return JSON.parse(data.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buf += decoder.decode(value, { stream: true });
      }
    },
    close: () => controller.abort(),
  };
}

test('rejects wrong family code', async () => {
  const res = await fetch(base + '/api/list', { headers: { 'X-Family-Code': 'nope' } });
  assert.strictEqual(res.status, 401);
});

test('serves the app page', async () => {
  const res = await fetch(base + '/');
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /Family Groceries/);
});

test('blocks path traversal', async () => {
  const res = await fetch(base + '/..%2fserver.js');
  assert.notStrictEqual(res.status, 200);
});

test('a change by one device reaches every other device live', async () => {
  const phoneA = await openStream();
  const phoneB = await openStream();
  await phoneA.next(); // initial snapshot
  await phoneB.next();

  const res = await op({ type: 'add', name: '  Milk ', qty: '2 L', category: 'Dairy', by: 'Mom' });
  assert.strictEqual(res.status, 200);
  const { item } = await res.json();

  const seenA = await phoneA.next();
  const seenB = await phoneB.next();
  for (const s of [seenA, seenB]) {
    const milk = s.items.find((i) => i.id === item.id);
    assert.ok(milk);
    assert.strictEqual(milk.name, 'Milk');
    assert.strictEqual(milk.addedBy, 'Mom');
  }

  await op({ type: 'toggle', id: item.id, done: true, by: 'Dad' });
  const afterToggle = await phoneB.next();
  const milk = afterToggle.items.find((i) => i.id === item.id);
  assert.strictEqual(milk.done, true);
  assert.strictEqual(milk.updatedBy, 'Dad');

  phoneA.close();
  phoneB.close();
});

test('simultaneous adds from different people are all kept', async () => {
  const names = ['Eggs', 'Bread', 'Rice', 'Onions', 'Tea'];
  await Promise.all(names.map((name, i) => op({ type: 'add', name, by: 'P' + i })));
  const list = await (await fetch(base + '/api/list', { headers: H })).json();
  for (const n of names) assert.ok(list.items.some((i) => i.name === n), n + ' missing');
});

test('edit, delete, clear done, and validation', async () => {
  const { item } = await (await op({ type: 'add', name: 'Apples', by: 'Ashu' })).json();
  await op({ type: 'edit', id: item.id, name: 'Green apples', qty: '6', by: 'Ashu' });
  let list = await (await fetch(base + '/api/list', { headers: H })).json();
  assert.strictEqual(list.items.find((i) => i.id === item.id).name, 'Green apples');

  assert.strictEqual((await op({ type: 'add', name: '   ' })).status, 400);
  assert.strictEqual((await op({ type: 'delete', id: 'missing' })).status, 404);
  assert.strictEqual((await op({ type: 'explode' })).status, 400);

  await op({ type: 'toggle', id: item.id, done: true });
  await op({ type: 'clearDone' });
  list = await (await fetch(base + '/api/list', { headers: H })).json();
  assert.ok(!list.items.some((i) => i.done));
});

test('list is saved to disk', async () => {
  await op({ type: 'add', name: 'Saved item' });
  await new Promise((r) => setTimeout(r, 400));
  const saved = JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'));
  assert.ok(saved.items.some((i) => i.name === 'Saved item'));
});
