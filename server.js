#!/usr/bin/env node
/**
 * Google Sheet -> vMix JSON proxy
 *
 * Serves every tab of one or more Google Sheets as its own JSON endpoint,
 * shaped the way vMix Data Sources expects (an array of row objects keyed by
 * the header row). Sheets are managed from the web interface at / and stored
 * in config.json.
 *
 * Zero dependencies — requires Node.js 18+ (built-in fetch).
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Environment (.env next to this script, overridden by real env vars)
// ---------------------------------------------------------------------------
loadDotEnv(path.join(__dirname, '.env'));

const env = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  apiBase: process.env.SHEETS_API_BASE || 'https://sheets.googleapis.com/v4',
  configFile: process.env.CONFIG_FILE || path.join(__dirname, 'config.json'),
  adminPassword: process.env.ADMIN_PASSWORD || '',
};

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// ---------------------------------------------------------------------------
// Persistent config (config.json)
//   { sheets: [{ id, slug, name, spreadsheetId, apiKey, cacheSeconds, refresh }] }
//   id is internal and never changes; slug is the name used in URLs.
// ---------------------------------------------------------------------------
const DEFAULT_CACHE_SECONDS = 5;
let config = loadConfig();

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function loadConfig() {
  if (fs.existsSync(env.configFile)) {
    const c = { sheets: [], ...JSON.parse(fs.readFileSync(env.configFile, 'utf8')) };
    const before = JSON.stringify(c);
    // Migrate older configs: global key and global cache become per-sheet settings.
    for (const s of c.sheets) {
      if (!s.apiKey && c.apiKey) s.apiKey = c.apiKey;
      if (s.cacheSeconds === undefined) s.cacheSeconds = c.cacheSeconds ?? DEFAULT_CACHE_SECONDS;
      if (s.refresh === undefined) s.refresh = true;
      if (!s.id) s.id = newId();
    }
    delete c.apiKey;
    delete c.cacheSeconds;
    if (JSON.stringify(c) !== before) saveConfig(c);
    return c;
  }
  // First run: seed from .env so the single-sheet setup keeps working.
  const c = { sheets: [] };
  if (process.env.SPREADSHEET_ID) {
    c.sheets.push({
      id: newId(),
      slug: 'main',
      name: 'Main',
      spreadsheetId: extractSpreadsheetId(process.env.SPREADSHEET_ID),
      apiKey: process.env.GOOGLE_API_KEY || '',
      cacheSeconds: process.env.CACHE_SECONDS !== undefined ? Number(process.env.CACHE_SECONDS) : DEFAULT_CACHE_SECONDS,
      refresh: true,
    });
  }
  saveConfig(c);
  return c;
}

function saveConfig(c = config) {
  const tmp = env.configFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, env.configFile);
}

/** Accept either a bare spreadsheet ID or a full docs.google.com URL. */
function extractSpreadsheetId(input) {
  const m = String(input).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : String(input).trim();
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sheet';
}

function findSheet(slug) {
  const s = config.sheets.find((x) => x.slug === slug) ||
    config.sheets.find((x) => x.slug.toLowerCase() === String(slug).toLowerCase());
  if (!s) throw httpError(404, `Sheet "${slug}" not found. Available: ${config.sheets.map((x) => x.slug).join(', ') || '(none)'}`);
  return s;
}

function keyFor(sheet) {
  if (!sheet.apiKey) throw httpError(400, `Sheet "${sheet.slug}" has no Google API key. Add one in the web interface.`);
  return sheet.apiKey;
}

function maskKey(k) {
  if (!k) return '';
  return k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '••••';
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------------------------------------------------------------------------
// Google Sheets API with a per-sheet TTL cache (protects your API quota when
// vMix polls every second). When a sheet's refresh is turned off, the last
// fetched data is served indefinitely and Google is not called again.
// ---------------------------------------------------------------------------
const cache = new Map(); // "<sheet id>|<kind>|..." -> { time, data, pending }

async function cached(sheet, key, loader) {
  key = `${sheet.id}|${key}`;
  const entry = cache.get(key);
  if (entry && entry.data !== undefined) {
    if (sheet.refresh === false) return entry.data;
    if (Date.now() - entry.time < (sheet.cacheSeconds ?? DEFAULT_CACHE_SECONDS) * 1000) return entry.data;
  }
  if (entry && entry.pending) return entry.pending; // de-duplicate concurrent requests

  const pending = loader()
    .then((data) => {
      cache.set(key, { time: Date.now(), data });
      return data;
    })
    .catch((err) => {
      // Serve stale data if Google is unreachable, so the vMix graphic doesn't blank out.
      if (entry && entry.data !== undefined && err.status !== 404) {
        console.warn(`[stale] ${key}: ${err.message}`);
        cache.set(key, { time: entry.time, data: entry.data });
        return entry.data;
      }
      cache.delete(key);
      throw err;
    });
  cache.set(key, { ...(entry || {}), pending });
  return pending;
}

/** Drop cached entries for a sheet; kind = 'tabs' or 'values' to drop only those. */
function clearCache(sheet, kind) {
  const prefix = `${sheet.id}|${kind ? kind + '|' : ''}`;
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

/** When this sheet's cell data was last fetched from Google (null if never). */
function dataUpdatedAt(sheet) {
  let latest = 0;
  for (const [k, v] of cache) if (k.startsWith(`${sheet.id}|values|`) && v.time > latest) latest = v.time;
  return latest ? new Date(latest).toISOString() : null;
}

async function googleGet(apiKey, urlPath, params = {}) {
  const url = new URL(env.apiBase + urlPath);
  url.searchParams.set('key', apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error?.message || res.statusText;
    throw httpError(res.status === 404 ? 404 : 502, `Google API ${res.status}: ${msg}`);
  }
  return body;
}

function getTabs(sheet) {
  const id = sheet.spreadsheetId;
  return cached(sheet, 'tabs|', async () => {
    const data = await googleGet(keyFor(sheet), `/spreadsheets/${encodeURIComponent(id)}`, {
      fields: 'properties.title,sheets.properties(sheetId,title,index,gridProperties)',
    });
    return {
      title: data.properties?.title || '',
      tabs: (data.sheets || []).map((s) => ({
        name: s.properties.title,
        index: s.properties.index,
        gid: s.properties.sheetId,
        rows: s.properties.gridProperties?.rowCount,
        columns: s.properties.gridProperties?.columnCount,
      })),
    };
  });
}

function getValues(sheet, tabName, range, render) {
  const id = sheet.spreadsheetId;
  const a1 = `'${tabName.replace(/'/g, "''")}'${range ? '!' + range : ''}`;
  return cached(sheet, `values|${a1}|${render}`, async () => {
    const data = await googleGet(
      keyFor(sheet),
      `/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(a1)}`,
      { valueRenderOption: render, majorDimension: 'ROWS' },
    );
    return data.values || [];
  });
}

/** Find a tab by exact name, case-insensitive name, then numeric index. */
async function resolveTab(sheet, requested) {
  const { tabs } = await getTabs(sheet);
  const tab =
    tabs.find((t) => t.name === requested) ||
    tabs.find((t) => t.name.toLowerCase() === requested.toLowerCase()) ||
    (/^\d+$/.test(requested) ? tabs.find((t) => t.index === Number(requested)) : undefined);
  if (!tab) throw httpError(404, `Tab "${requested}" not found. Available: ${tabs.map((t) => t.name).join(', ')}`);
  return tab;
}

// ---------------------------------------------------------------------------
// Shaping rows for vMix
// ---------------------------------------------------------------------------

/** Turn a 2D array into [{Header: value, ...}, ...] with consistent keys. */
function rowsToObjects(values, { skipEmpty = true } = {}) {
  if (values.length === 0) return [];
  const [headerRow, ...rows] = values;
  const width = Math.max(headerRow.length, ...rows.map((r) => r.length));

  const seen = new Map();
  const headers = [];
  for (let i = 0; i < width; i++) {
    let h = String(headerRow[i] ?? '').trim() || columnLetter(i);
    const count = seen.get(h) || 0;
    seen.set(h, count + 1);
    if (count > 0) h = `${h}_${count + 1}`;
    headers.push(h);
  }

  return rows
    .filter((r) => !skipEmpty || r.some((c) => String(c ?? '').trim() !== ''))
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => (obj[h] = r[i] === undefined || r[i] === null ? '' : String(r[i])));
      return obj;
    });
}

function columnLetter(i) {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

async function tabData(sheet, tabName, rowParam, q) {
  const tab = await resolveTab(sheet, tabName);
  const render = q.get('render') === 'unformatted' ? 'UNFORMATTED_VALUE'
    : q.get('render') === 'formula' ? 'FORMULA' : 'FORMATTED_VALUE';
  const values = await getValues(sheet, tab.name, q.get('range') || '', render);
  if (q.has('raw')) return values;

  let rows = rowsToObjects(values, { skipEmpty: q.get('empty') !== '1' });
  rowParam = rowParam ?? q.get('row');
  if (rowParam !== undefined && rowParam !== null) {
    const n = Number(rowParam);
    if (!Number.isInteger(n) || n < 1) throw httpError(400, 'Row must be a positive integer (1 = first data row)');
    rows = rows[n - 1] ? [rows[n - 1]] : [];
  }
  if (q.has('limit')) rows = rows.slice(0, Math.max(0, Number(q.get('limit')) || 0));
  return rows;
}

// ---------------------------------------------------------------------------
// Admin API (used by the web interface)
// ---------------------------------------------------------------------------
function publicConfig() {
  return {
    sheets: config.sheets.map((s) => ({
      slug: s.slug,
      name: s.name,
      spreadsheetId: s.spreadsheetId,
      apiKeySet: Boolean(s.apiKey),
      apiKeyMasked: maskKey(s.apiKey),
      cacheSeconds: s.cacheSeconds,
      refresh: s.refresh !== false,
    })),
  };
}

function uniqueSlug(base, exceptSlug) {
  let slug = slugify(base);
  const taken = (x) => config.sheets.some((s) => s.slug === x && s.slug !== exceptSlug);
  for (let i = 2; taken(slug); i++) slug = `${slugify(base)}-${i}`;
  return slug;
}

function validateSheetInput(body, existing) {
  const name = String(body.name ?? existing?.name ?? '').trim();
  const spreadsheetId = extractSpreadsheetId(body.spreadsheetId ?? existing?.spreadsheetId ?? '');
  if (!name) throw httpError(400, 'Name is required');
  if (!/^[a-zA-Z0-9-_]{10,}$/.test(spreadsheetId)) throw httpError(400, 'Enter a valid spreadsheet URL or ID');

  let cacheSeconds = existing?.cacheSeconds ?? DEFAULT_CACHE_SECONDS;
  if (body.cacheSeconds !== undefined && body.cacheSeconds !== '') {
    cacheSeconds = Number(body.cacheSeconds);
    if (!Number.isFinite(cacheSeconds) || cacheSeconds < 0 || cacheSeconds > 86400) {
      throw httpError(400, 'Cache must be between 0 and 86400 seconds');
    }
  }
  const refresh = body.refresh === undefined ? existing?.refresh !== false : Boolean(body.refresh);
  return { name, spreadsheetId, cacheSeconds, refresh };
}

async function handleAdmin(req, res, parts) {
  const method = req.method;
  const body = ['POST', 'PUT'].includes(method) ? await readJson(req) : {};

  // GET /api/config
  if (parts[1] === 'config' && method === 'GET') return sendJson(res, 200, publicConfig());

  if (parts[1] === 'sheets') {
    // POST /api/sheets  { name, spreadsheetId, apiKey, slug?, cacheSeconds?, refresh? }
    if (parts.length === 2 && method === 'POST') {
      const fields = validateSheetInput(body);
      const apiKey = String(body.apiKey ?? '').trim();
      if (!apiKey) throw httpError(400, 'API key is required');
      const sheet = { id: newId(), slug: uniqueSlug(body.slug || fields.name), ...fields, apiKey };
      config.sheets.push(sheet);
      saveConfig();
      return sendJson(res, 201, { ...publicConfig(), saved: sheet.slug });
    }

    const sheet = findSheet(parts[2]);

    // GET /api/sheets/:slug/status — test the connection and list tabs.
    // Only the tab list is re-fetched; cell data (and a paused sheet's frozen data) is untouched.
    if (parts[3] === 'status' && method === 'GET') {
      clearCache(sheet, 'tabs');
      try {
        return sendJson(res, 200, { ok: true, ...(await getTabs(sheet)), dataUpdatedAt: dataUpdatedAt(sheet) });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message, dataUpdatedAt: dataUpdatedAt(sheet) });
      }
    }

    // POST /api/sheets/:slug/reload — drop cached data so the next request fetches fresh
    // data from Google. For a paused sheet this updates its frozen snapshot once.
    if (parts[3] === 'reload' && method === 'POST') {
      clearCache(sheet);
      // Pre-fetch every tab in the default format so the snapshot is updated right away.
      const { tabs } = await getTabs(sheet);
      await Promise.all(tabs.map((t) => getValues(sheet, t.name, '', 'FORMATTED_VALUE')));
      return sendJson(res, 200, { ok: true, dataUpdatedAt: dataUpdatedAt(sheet) });
    }

    // PUT /api/sheets/:slug  { name?, spreadsheetId?, slug?, apiKey?, cacheSeconds?, refresh? }
    // Any field left out keeps its current value; a blank apiKey keeps the saved key.
    if (parts.length === 3 && method === 'PUT') {
      const fields = validateSheetInput(body, sheet);
      const newKey = String(body.apiKey ?? '').trim();
      // Only throw away cached data when the source itself changes.
      if (fields.spreadsheetId !== sheet.spreadsheetId || (newKey && newKey !== sheet.apiKey)) clearCache(sheet);
      Object.assign(sheet, fields);
      if (body.slug && slugify(body.slug) !== sheet.slug) sheet.slug = uniqueSlug(body.slug, sheet.slug);
      if (newKey) sheet.apiKey = newKey;
      saveConfig();
      return sendJson(res, 200, { ...publicConfig(), saved: sheet.slug });
    }

    // DELETE /api/sheets/:slug
    if (parts.length === 3 && method === 'DELETE') {
      config.sheets = config.sheets.filter((s) => s !== sheet);
      clearCache(sheet);
      saveConfig();
      return sendJson(res, 200, publicConfig());
    }
  }

  throw httpError(404, 'Unknown admin endpoint');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) reject(httpError(413, 'Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Optional HTTP Basic auth for the interface and admin API (data endpoints stay open for vMix). */
function checkAdminAuth(req, res) {
  if (!env.adminPassword) return true;
  const [scheme, value] = String(req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && value) {
    const pass = Buffer.from(value, 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass);
    const b = Buffer.from(env.adminPassword);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Sheet Proxy"', 'Content-Type': 'text/plain' });
  res.end('Authentication required');
  return false;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let parts;
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return sendJson(res, 400, { error: 'Malformed URL' });
  }
  const q = url.searchParams;

  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');

    // Web interface
    if (parts.length === 0 && req.method === 'GET') {
      if (!checkAdminAuth(req, res)) return;
      return send(res, 200, fs.readFileSync(INDEX_FILE), 'text/html; charset=utf-8');
    }
    if (parts[0] === 'api') {
      if (!checkAdminAuth(req, res)) return;
      return await handleAdmin(req, res, parts);
    }

    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    if (parts[0] === 'health') return sendJson(res, 200, { ok: true });

    // GET /sheets                       -> list of configured sheets
    if (parts[0] === 'sheets' && parts.length === 1) {
      return sendJson(res, 200, config.sheets.map((s) => ({ slug: s.slug, name: s.name })));
    }

    // GET /sheet/:slug                  -> tabs of that sheet
    // GET /sheet/:slug/:tab             -> rows of a tab (vMix format)
    // GET /sheet/:slug/:tab/:row        -> single row, still wrapped in an array
    if (parts[0] === 'sheet' && parts.length >= 2 && parts.length <= 4) {
      const sheet = findSheet(parts[1]);
      if (parts.length === 2) return sendJson(res, 200, await getTabs(sheet));
      return sendJson(res, 200, await tabData(sheet, parts[2], parts[3], q));
    }

    // Legacy single-sheet routes -> first configured sheet (or ?sheet=<slug>)
    if (parts[0] === 'tabs' && parts.length === 1) {
      return sendJson(res, 200, await getTabs(defaultSheet(q)));
    }
    if (parts[0] === 'tab' && parts.length >= 2 && parts.length <= 3) {
      return sendJson(res, 200, await tabData(defaultSheet(q), parts[1], parts[2], q));
    }

    return sendJson(res, 404, { error: 'Not found. Try / , /sheets or /sheet/<sheet>/<tab>' });
  } catch (err) {
    if (err.status !== 404) console.error(`${req.method} ${req.url} -> ${err.message}`);
    return sendJson(res, err.status || 500, { error: err.message });
  }
});

function defaultSheet(q) {
  if (q.get('sheet')) return findSheet(q.get('sheet'));
  if (!config.sheets[0]) throw httpError(400, 'No sheets configured. Add one in the web interface.');
  return config.sheets[0];
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data, null, 2), 'application/json; charset=utf-8');
}

server.listen(env.port, env.host, () => {
  console.log(`Google Sheet proxy listening on http://localhost:${env.port}`);
  console.log(`Config: ${env.configFile} | ${config.sheets.length} sheet(s)`);
  const missing = config.sheets.filter((s) => !s.apiKey).map((s) => s.slug);
  if (missing.length) console.log(`Sheets without an API key: ${missing.join(', ')} — add one in the web interface.`);
});
