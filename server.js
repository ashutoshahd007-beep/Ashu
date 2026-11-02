'use strict';

// Family Grocery List server.
// Zero dependencies: plain Node.js (>= 18). Holds the one shared list,
// saves it to a JSON file, and pushes every change to all connected
// devices over Server-Sent Events (SSE).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'list.json');
const FAMILY_CODE = process.env.FAMILY_CODE || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 16 * 1024;
const MAX_ITEMS = 1000;

// ---------- storage ----------

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw && Array.isArray(raw.items)) {
      return { version: Number(raw.version) || 0, items: raw.items };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read data file, starting empty:', err.message);
  }
  return { version: 0, items: [] };
}

let state = loadState();
let saveTimer = null;

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 200);
}

function saveNow() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DATA_FILE); // atomic replace, no half-written file
  } catch (err) {
    console.error('Failed to save list:', err.message);
  }
}

// ---------- live updates ----------

const clients = new Set();

function broadcast() {
  const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(payload);
}

function commit() {
  state.version += 1;
  saveSoon();
  broadcast();
}

// Keep connections alive through proxies that drop idle streams.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000).unref();

// ---------- helpers ----------

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function codeMatches(given) {
  if (!FAMILY_CODE) return true;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(FAMILY_CODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------- operations ----------
// Clients send small operations, never the whole list, so two people
// editing at the same time do not overwrite each other's changes.

function applyOp(op) {
  const by = cleanText(op.by, 40) || 'Someone';
  const now = Date.now();

  switch (op.type) {
    case 'add': {
      const name = cleanText(op.name, 80);
      if (!name) throw Object.assign(new Error('Item name is required'), { status: 400 });
      if (state.items.length >= MAX_ITEMS) throw Object.assign(new Error('List is full'), { status: 400 });
      const item = {
        id: crypto.randomUUID(),
        name,
        qty: cleanText(op.qty, 20),
        category: cleanText(op.category, 30) || 'Other',
        done: false,
        addedBy: by,
        updatedBy: by,
        createdAt: now,
        updatedAt: now,
      };
      state.items.push(item);
      return item;
    }
    case 'toggle':
    case 'edit': {
      const item = state.items.find((i) => i.id === op.id);
      if (!item) throw Object.assign(new Error('Item no longer exists'), { status: 404 });
      if (op.type === 'toggle') {
        item.done = typeof op.done === 'boolean' ? op.done : !item.done;
      } else {
        if (op.name !== undefined) {
          const name = cleanText(op.name, 80);
          if (!name) throw Object.assign(new Error('Item name is required'), { status: 400 });
          item.name = name;
        }
        if (op.qty !== undefined) item.qty = cleanText(op.qty, 20);
        if (op.category !== undefined) item.category = cleanText(op.category, 30) || 'Other';
      }
      item.updatedBy = by;
      item.updatedAt = now;
      return item;
    }
    case 'delete': {
      const before = state.items.length;
      state.items = state.items.filter((i) => i.id !== op.id);
      if (state.items.length === before) throw Object.assign(new Error('Item no longer exists'), { status: 404 });
      return null;
    }
    case 'clearDone': {
      state.items = state.items.filter((i) => !i.done);
      return null;
    }
    default:
      throw Object.assign(new Error('Unknown operation'), { status: 400 });
  }
}

// ---------- routing ----------

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (pathname.startsWith('/api/')) {
    const code = req.headers['x-family-code'] || url.searchParams.get('code');
    if (!codeMatches(code)) return sendJson(res, 401, { error: 'Wrong family code' });

    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (pathname === '/api/list' && req.method === 'GET') {
      return sendJson(res, 200, state);
    }

    if (pathname === '/api/ops' && req.method === 'POST') {
      try {
        const op = await readBody(req);
        const item = applyOp(op || {});
        commit();
        return sendJson(res, 200, { ok: true, item, version: state.version });
      } catch (err) {
        return sendJson(res, err.status || 500, { error: err.message });
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
  res.writeHead(405).end();
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
    });
  });
}

function flushAndExit() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveNow();
  process.exit(0);
}

if (require.main === module) {
  process.on('SIGINT', flushAndExit);
  process.on('SIGTERM', flushAndExit);
  createServer().listen(PORT, () => {
    console.log(`Grocery list running at http://localhost:${PORT}`);
    console.log(FAMILY_CODE ? 'Family code is required to open the list.' : 'WARNING: no FAMILY_CODE set, anyone with the link can edit.');
    console.log(`Saving to ${DATA_FILE}`);
  });
}

module.exports = { createServer };
