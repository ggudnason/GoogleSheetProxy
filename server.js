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
  if (!s) throw httpError(404, `Spreadsheet "${slug}" not found. Available: ${config.sheets.map((x) => x.slug).join(', ') || '(none)'}`);
  return s;
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
// Google Sheets access
//
// * Background poller: every live sheet is re-read from Google every
//   `cacheSeconds` (one batch call for all tabs), whether or not vMix is asking.
//   If a poll fails it waits a moment and tries again (2s, 4s, 8s ... up to 30s),
//   forever. It never stops polling because of an error.
// * Requests from vMix are answered from the cache straight away. If the
//   cached copy is old (because Google is failing), the old data is served and
//   a refresh is attempted in the background, so vMix never waits on Google
//   and graphics never go blank.
// * Paused sheets (refresh off) are not polled; their last data is held.
// * Every Google call updates the sheet's health record, which the web
//   interface shows.
// ---------------------------------------------------------------------------
const GOOGLE_TIMEOUT_MS = Number(process.env.GOOGLE_TIMEOUT_MS) || 10000;
const TABS_REFRESH_MS = 60000; // how often the tab list itself is re-read
const MAX_RETRY_MS = 30000;
const ERROR_WINDOW_MS = 10 * 60 * 1000; // "recent errors" window used for suggestions
const QUOTA_PER_MINUTE = 300; // Google Sheets API read quota per Cloud project

const cache = new Map(); // "<sheet id>|<kind>|..." -> { time, data }
const inFlight = new Map(); // de-duplicates concurrent fetches of the same thing

const ttlMs = (sheet) => Math.max(1, sheet.cacheSeconds ?? DEFAULT_CACHE_SECONDS) * 1000;

/** True if a cache entry can be served without asking Google. */
function isFresh(sheet, entry, maxAgeMs = ttlMs(sheet)) {
  if (!entry || entry.data === undefined) return false;
  if (sheet.refresh === false) return true;
  // A little slack so a vMix request arriving just before the poller's next run
  // doesn't trigger a second, duplicate fetch.
  return Date.now() - entry.time < maxAgeMs + 2000;
}

/** Drop cached entries for a sheet; kind = 'tabs' or 'values' to drop only those. */
function clearCache(sheet, kind) {
  const prefix = `${sheet.id}|${kind ? kind + '|' : ''}`;
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

/** When this sheet's cell data was last fetched from Google (null if never). */
function dataUpdatedAt(sheet) {
  let latest = 0;
  for (const [k, v] of cache) {
    if (k.startsWith(`${sheet.id}|values|`) && v.data !== undefined && v.time > latest) latest = v.time;
  }
  return latest ? new Date(latest).toISOString() : null;
}

// ---- health -----------------------------------------------------------------
const health = new Map(); // sheet id -> record

function healthOf(sheet) {
  if (!health.has(sheet.id)) {
    health.set(sheet.id, {
      lastSuccessAt: 0,
      lastErrorAt: 0,
      lastError: null, // Error with a plain-language message
      consecutiveFailures: 0,
      nextRetryAt: 0,
      recentErrors: [], // [{ at, kind }] within ERROR_WINDOW_MS
      cacheChangedAt: 0, // suggestions only count errors after the cache time last changed
    });
  }
  return health.get(sheet.id);
}

function recordSuccess(sheet) {
  const h = healthOf(sheet);
  h.lastSuccessAt = Date.now();
  h.consecutiveFailures = 0;
  h.nextRetryAt = 0;
}

function recordFailure(sheet, err) {
  const h = healthOf(sheet);
  const now = Date.now();
  h.lastErrorAt = now;
  h.lastError = err;
  h.consecutiveFailures += 1;
  h.nextRetryAt = now + retryDelayMs(h.consecutiveFailures);
  h.recentErrors = h.recentErrors.filter((e) => now - e.at < ERROR_WINDOW_MS);
  h.recentErrors.push({ at: now, kind: err.kind });
  console.warn(`[${sheet.slug}] ${err.message} (failure ${h.consecutiveFailures}, retrying in ${Math.round(retryDelayMs(h.consecutiveFailures) / 1000)}s)`);
}

/** Wait between retries after n failures in a row: 2s, 4s, 8s, 16s, then 30s. */
function retryDelayMs(n) {
  return Math.min(MAX_RETRY_MS, 2000 * 2 ** Math.max(0, n - 1));
}

/** Whether a request may call Google now, or should wait for the retry delay. */
function mayCallGoogle(sheet) {
  return Date.now() >= healthOf(sheet).nextRetryAt;
}

// ---- talking to Google ------------------------------------------------------

/** Turn any fetch/HTTP failure into an Error with a message a person can act on. */
function friendlyGoogleError(err, res, body) {
  let e;
  if (res) {
    const detail = body?.error?.message || res.statusText;
    const s = res.status;
    let msg;
    let kind = 'google';
    if (s === 429) {
      msg = 'Google’s request limit was reached (too many requests). Increase the cache time.';
      kind = 'quota';
    } else if (s === 400 && /api key/i.test(detail)) {
      msg = 'The API key is not valid. Check it in Edit.';
      kind = 'config';
    } else if (s === 403) {
      msg = 'Google refused access. Check that the sheet is shared as “Anyone with the link → Viewer” and the Google Sheets API is enabled for this key.';
      kind = 'config';
    } else if (s === 404) {
      msg = 'Spreadsheet not found. Check the URL in Edit.';
      kind = 'config';
    } else if (s >= 500) {
      msg = `Google Sheets had a server problem (${s}). This is usually temporary.`;
    } else {
      msg = `Google returned an error (${s}).`;
    }
    e = httpError(s === 404 ? 404 : 502, msg);
    e.kind = kind;
    e.detail = detail;
    e.googleStatus = s;
    return e;
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    e = httpError(504, `Google Sheets did not respond within ${GOOGLE_TIMEOUT_MS / 1000} seconds.`);
    e.kind = 'timeout';
  } else {
    const code = err?.cause?.code || '';
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
      e = httpError(502, 'Can’t reach Google: no internet connection or DNS is not working.');
    } else if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
      e = httpError(502, `Can’t reach Google: the connection failed (${code}).`);
    } else if (['UND_ERR_SOCKET', 'UND_ERR_CLOSED'].includes(code)) {
      e = httpError(502, 'Can’t reach Google: the connection was cut off.');
    } else {
      e = httpError(502, `Can’t reach Google: ${err?.cause?.message || err?.message || 'unknown network error'}.`);
    }
    e.kind = 'network';
  }
  e.detail = err?.message;
  return e;
}

async function googleGet(sheet, urlPath, params = {}) {
  if (!sheet.apiKey) {
    const e = httpError(400, 'This spreadsheet has no Google API key. Add one in Edit.');
    e.kind = 'config';
    recordFailure(sheet, e);
    throw e;
  }
  const url = new URL(env.apiBase + urlPath);
  url.searchParams.set('key', sheet.apiKey);
  for (const [k, v] of Object.entries(params)) {
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
  }

  let res;
  let body;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    const e = friendlyGoogleError(err);
    recordFailure(sheet, e);
    throw e;
  }
  if (!res.ok) {
    const e = friendlyGoogleError(null, res, body);
    recordFailure(sheet, e);
    throw e;
  }
  recordSuccess(sheet);
  return body;
}

/** Run a fetch once even if several callers ask at the same time. */
function once(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * Serve key from cache. Fresh: return it. Old but present: return it now and
 * refresh in the background. Missing: wait for Google (unless we're in a
 * retry pause after errors, in which case report the last error).
 */
async function cached(sheet, key, fetcher, maxAgeMs) {
  const full = `${sheet.id}|${key}`;
  const entry = cache.get(full);
  if (isFresh(sheet, entry, maxAgeMs)) return entry.data;

  const refresh = () => once(full, async () => {
    const data = await fetcher();
    cache.set(full, { time: Date.now(), data });
    return data;
  });

  if (entry?.data !== undefined) {
    if (mayCallGoogle(sheet)) refresh().catch(() => {}); // failure is recorded in health
    return entry.data;
  }
  if (!mayCallGoogle(sheet) && healthOf(sheet).lastError) throw healthOf(sheet).lastError;
  return refresh();
}

const tabsKey = 'tabs|';
const a1For = (tabName, range) => `'${tabName.replace(/'/g, "''")}'${range ? '!' + range : ''}`;
const valuesKey = (a1, render) => `values|${a1}|${render}`;

async function fetchTabs(sheet) {
  const data = await googleGet(sheet, `/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}`, {
    fields: 'properties.title,sheets.properties(sheetId,title,index,hidden,gridProperties)',
  });
  return {
    title: data.properties?.title || '',
    tabs: (data.sheets || []).map((s) => ({
      name: s.properties.title,
      index: s.properties.index,
      gid: s.properties.sheetId,
      hidden: !!s.properties.hidden,
      rows: s.properties.gridProperties?.rowCount,
      columns: s.properties.gridProperties?.columnCount,
    })),
  };
}

/**
 * The tabs /all serves and the poller reads. Tabs hidden in Google Sheets are
 * left out unless the sheet's "Show hidden tabs" setting is on: hiding a tab
 * looks like deleting it in the Sheets UI, so by default it shouldn't keep
 * feeding vMix. A hidden tab's own URL always works (read on demand).
 */
const servedTabs = (sheet, tabs) => (sheet.showHidden ? tabs : tabs.filter((t) => !t.hidden));

function getTabs(sheet) {
  return cached(sheet, tabsKey, () => fetchTabs(sheet), Math.max(TABS_REFRESH_MS, ttlMs(sheet)));
}

/** Re-read the tab list now (keeps the old list if Google fails). */
function refreshTabs(sheet) {
  const full = `${sheet.id}|${tabsKey}`;
  return once(full, async () => {
    const data = await fetchTabs(sheet);
    cache.set(full, { time: Date.now(), data });
    return data;
  });
}

function getValues(sheet, tabName, range, render) {
  const a1 = a1For(tabName, range);
  return cached(sheet, valuesKey(a1, render), async () => {
    const data = await googleGet(
      sheet,
      `/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(a1)}`,
      { valueRenderOption: render, majorDimension: 'ROWS' },
    );
    return data.values || [];
  });
}

/**
 * Fetch every tab's cells in one batchGet call and store each tab in the
 * per-tab cache the single-tab endpoints use, so /all and /sheet/... always
 * serve the same snapshot.
 */
function fetchAllValues(sheet, tabs, render) {
  return once(`${sheet.id}|batch|${render}`, async () => {
    if (!tabs.length) return;
    const data = await googleGet(sheet, `/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values:batchGet`, {
      ranges: tabs.map((t) => a1For(t.name, '')),
      valueRenderOption: render,
      majorDimension: 'ROWS',
    });
    const now = Date.now();
    tabs.forEach((t, i) => {
      cache.set(`${sheet.id}|${valuesKey(a1For(t.name, ''), render)}`, { time: now, data: data.valueRanges?.[i]?.values || [] });
    });
  });
}

/** Cell values for every tab of a sheet, as { tabName: values[][] }. */
async function getAllValues(sheet, render) {
  const tabs = servedTabs(sheet, (await getTabs(sheet)).tabs);
  const entryOf = (t) => cache.get(`${sheet.id}|${valuesKey(a1For(t.name, ''), render)}`);
  const haveAll = tabs.every((t) => entryOf(t)?.data !== undefined);
  const allFresh = haveAll && tabs.every((t) => isFresh(sheet, entryOf(t)));

  if (!allFresh) {
    if (haveAll) {
      // Serve what we have; refresh in the background.
      if (mayCallGoogle(sheet)) fetchAllValues(sheet, tabs, render).catch(() => {});
    } else {
      if (!mayCallGoogle(sheet) && healthOf(sheet).lastError) throw healthOf(sheet).lastError;
      await fetchAllValues(sheet, tabs, render);
    }
  }

  const out = {};
  for (const t of tabs) out[t.name] = entryOf(t)?.data ?? [];
  return out;
}

// ---- background poller --------------------------------------------------------
const pollTimers = new Map(); // sheet id -> timeout

/**
 * One poll: refresh the tab list when it's due, then read every tab in one call.
 * force = true re-reads the tab list too (used by the Check button).
 */
async function pollSheet(sheet, { force = false } = {}) {
  const tabsEntry = cache.get(`${sheet.id}|${tabsKey}`);
  let tabsData = tabsEntry?.data;
  if (force || !tabsData || Date.now() - tabsEntry.time > TABS_REFRESH_MS) {
    tabsData = await refreshTabs(sheet);
  }
  try {
    await fetchAllValues(sheet, servedTabs(sheet, tabsData.tabs), 'FORMATTED_VALUE');
  } catch (err) {
    // A tab was probably renamed or deleted: re-read the tab list and try once more.
    if (err.googleStatus === 400 && /parse range/i.test(err.detail || '')) {
      tabsData = await refreshTabs(sheet);
      await fetchAllValues(sheet, servedTabs(sheet, tabsData.tabs), 'FORMATTED_VALUE');
    } else {
      throw err;
    }
  }
}

function stopPoller(sheet) {
  clearTimeout(pollTimers.get(sheet.id));
  pollTimers.delete(sheet.id);
}

/** (Re)start polling a sheet. Called at startup and whenever its settings change. */
function startPoller(sheet, delayMs = 0) {
  stopPoller(sheet);
  if (sheet.refresh === false || !config.sheets.includes(sheet)) return;
  const timer = setTimeout(async () => {
    let next = ttlMs(sheet);
    try {
      await pollSheet(sheet);
    } catch (err) {
      // Usually a Google failure, already recorded in health. Wait a moment and
      // try again (2s, 4s, 8s ... 30s); never give up.
      if (!err?.kind) console.error(`[${sheet.slug}] poll error: ${err?.stack || err}`);
      next = retryDelayMs(Math.max(1, healthOf(sheet).consecutiveFailures));
    } finally {
      if (pollTimers.get(sheet.id) === timer) startPoller(sheet, next);
    }
  }, delayMs);
  timer.unref?.();
  pollTimers.set(sheet.id, timer);
}

// ---- suggestions -------------------------------------------------------------

/** Rough Google read requests per minute that the pollers make. */
function estimatedReadsPerMinute() {
  let total = 0;
  for (const s of config.sheets) {
    if (s.refresh === false) continue;
    total += 60000 / ttlMs(s) + 60000 / Math.max(TABS_REFRESH_MS, ttlMs(s));
  }
  return Math.round(total);
}

/** A cache-time suggestion when a sheet keeps failing, or null. */
function suggestionFor(sheet) {
  const h = healthOf(sheet);
  const now = Date.now();
  const recent = h.recentErrors.filter((e) => now - e.at < ERROR_WINDOW_MS && e.at > h.cacheChangedAt);
  if (recent.length < 3 || sheet.refresh === false) return null;
  // Problems a longer cache time won't fix.
  if (recent.every((e) => e.kind === 'config')) return null;

  const current = sheet.cacheSeconds ?? DEFAULT_CACHE_SECONDS;
  const quota = recent.some((e) => e.kind === 'quota');
  let suggested = Math.min(300, Math.max(10, Math.ceil(current * 2)));
  if (quota) {
    // Bring the total for all sheets comfortably under the quota.
    const total = estimatedReadsPerMinute();
    const target = QUOTA_PER_MINUTE * 0.6;
    if (total > target) suggested = Math.max(suggested, Math.ceil(current * (total / target)));
  }
  if (suggested <= current) return null;
  return {
    cacheSeconds: suggested,
    reason: quota
      ? `Google rejected requests for going over its limit ${recent.length} times in the last 10 minutes.`
      : `Google failed ${recent.length} times in the last 10 minutes.`,
    message: `${quota ? 'Google keeps rejecting requests for going over its limit.' : 'Google has failed several times in the last 10 minutes.'} `
      + `Raise the cache time from ${current}s to ${suggested}s to ask Google less often. vMix keeps getting the last good data in between.`,
  };
}

/** Everything the interface needs about one sheet's connection, without calling Google. */
function sheetHealth(sheet) {
  const h = healthOf(sheet);
  const now = Date.now();
  const tabs = cache.get(`${sheet.id}|${tabsKey}`)?.data || null;
  const updated = dataUpdatedAt(sheet);
  const failing = h.consecutiveFailures > 0;
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  return {
    state: !h.lastSuccessAt && !failing ? 'starting' : failing ? (updated ? 'stale' : 'error') : 'ok',
    title: tabs?.title || '',
    tabs: tabs?.tabs || null,
    dataUpdatedAt: updated,
    lastSuccessAt: iso(h.lastSuccessAt),
    lastErrorAt: iso(h.lastErrorAt),
    lastError: h.lastError ? h.lastError.message : null,
    // Google's own wording, only when Google actually answered (not for timeouts/network errors).
    lastErrorDetail: h.lastError?.googleStatus ? h.lastError.detail || null : null,
    consecutiveFailures: h.consecutiveFailures,
    errorsLast10Min: h.recentErrors.filter((e) => now - e.at < ERROR_WINDOW_MS).length,
    nextRetryAt: failing ? iso(h.nextRetryAt) : null,
    suggestion: suggestionFor(sheet),
  };
}

/** Shape every tab of a sheet for vMix: { tabName: [row objects] }. */
async function allTabsData(sheet, q) {
  const render = renderOption(q);
  const values = await getAllValues(sheet, render);
  if (q.has('raw')) return values;
  const { tabs } = await getTabs(sheet);
  const out = {};
  for (const [name, v] of Object.entries(values)) {
    const columns = columnSettings(sheet, tabs.find((t) => t.name === name), q);
    let rows = rowsToObjects(v, { skipEmpty: q.get('empty') !== '1', vmixKeys: q.get('keys') !== 'original', columns });
    if (q.has('limit')) rows = rows.slice(0, Math.max(0, Number(q.get('limit')) || 0));
    out[name] = rows;
  }
  return out;
}

/**
 * Merge every tab's rows into one array for vMix. Each row starts with
 * Sheet (only on /all), Tab and Row (1-based position within its tab, the same
 * number /sheet/<sheet>/<tab>/<n> uses), followed by the union of all columns
 * so every row has the same keys. Columns whose names differ only in case
 * ("Date" in one tab, "DATE" in another) are merged, because vMix treats them
 * as the same column. A sheet column that clashes with Sheet/Tab/Row gets a
 * _2 suffix.
 */
function flattenForVmix(results, { includeSheet }) {
  const meta = includeSheet ? ['Sheet', 'Tab', 'Row'] : ['Tab', 'Row'];
  const metaLower = meta.map((m) => m.toLowerCase());
  const canonical = new Map(); // lower-case name -> the spelling first seen
  const columns = [];
  const rename = (k) => {
    let name = k;
    for (let i = 2; metaLower.includes(name.toLowerCase()); i++) name = `${k}_${i}`;
    const lower = name.toLowerCase();
    if (!canonical.has(lower)) {
      canonical.set(lower, name);
      columns.push(name);
    }
    return canonical.get(lower);
  };
  const rows = [];
  for (const { sheet, tabs } of results) {
    for (const [tab, tabRows] of Object.entries(tabs)) {
      tabRows.forEach((r, i) => {
        const row = includeSheet ? { Sheet: sheet.slug, Tab: tab, Row: String(i + 1) } : { Tab: tab, Row: String(i + 1) };
        for (const [k, v] of Object.entries(r)) {
          const name = rename(k);
          // Two differently-cased columns in the same tab: keep the first non-empty value.
          if (row[name] === undefined || row[name] === '') row[name] = v;
        }
        rows.push(row);
      });
    }
  }
  return rows.map((r) => {
    const full = {};
    for (const m of meta) full[m] = r[m];
    for (const c of columns) full[c] = r[c] ?? '';
    return full;
  });
}

const renderOption = (q) => (q.get('render') === 'unformatted' ? 'UNFORMATTED_VALUE'
  : q.get('render') === 'formula' ? 'FORMULA' : 'FORMATTED_VALUE');

/** Find a tab by exact name, case-insensitive name, then numeric index. */
async function resolveTab(sheet, requested) {
  const { tabs } = await getTabs(sheet);
  const tab =
    tabs.find((t) => t.name === requested) ||
    tabs.find((t) => t.name.toLowerCase() === requested.toLowerCase()) ||
    (/^\d+$/.test(requested) ? tabs.find((t) => t.index === Number(requested)) : undefined);
  if (!tab) throw httpError(404, `Sheet "${requested}" not found. Available: ${servedTabs(sheet, tabs).map((t) => t.name).join(', ')}`);
  return tab;
}

// ---------------------------------------------------------------------------
// Shaping rows for vMix
// ---------------------------------------------------------------------------

/**
 * Make a column name vMix can use. vMix reads JSON through XML, so a name with
 * spaces, #, /, |, brackets, line breaks etc. is renamed to "a:item" and all but
 * the first such column are dropped. Only letters, digits and _ are kept:
 * "Start Time" -> "Start_Time", "SESSION #" -> "SESSION_Number",
 * "DURATION\nhh:mm:ss" -> "DURATION_hh_mm_ss". Returns '' if nothing is left.
 */
const TRANSLIT = { þ: 'th', Þ: 'Th', ð: 'd', Ð: 'D', æ: 'ae', Æ: 'Ae', ø: 'o', Ø: 'O', ß: 'ss', œ: 'oe', Œ: 'Oe', ł: 'l', Ł: 'L' };

function vmixName(name) {
  let k = String(name)
    .replace(/[þÞðÐæÆøØßœŒłŁ]/g, (c) => TRANSLIT[c])
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // á -> a, ö -> o
    .replace(/#/g, ' Number ')
    .replace(/&/g, ' and ')
    .replace(/%/g, ' Percent ')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (/^[0-9]/.test(k)) k = `_${k}`; // names can't start with a digit
  return k;
}

/**
 * A stable id for each column, used to store column settings: the header text
 * as written in the sheet (trimmed), or the column letter when the header is
 * blank. Repeated headers get a suffix: "Name", "Name_2".
 */
function columnIds(values) {
  if (!values.length) return [];
  const [headerRow, ...rows] = values;
  const width = Math.max(headerRow.length, ...rows.map((r) => r.length));
  const seen = new Map();
  const ids = [];
  for (let i = 0; i < width; i++) {
    let id = String(headerRow[i] ?? '').trim() || columnLetter(i);
    const count = seen.get(id) || 0;
    seen.set(id, count + 1);
    if (count > 0) id = `${id}_${count + 1}`;
    ids.push(id);
  }
  return ids;
}

/**
 * The columns a sheet serves, in order: [{ index, id, header, name }].
 * columns = the sheet's saved settings { hide: [id], rename: { id: name } }.
 * vmixKeys (default): make the names vMix-safe and unique ignoring case, because
 * vMix treats "Name" and "NAME" as the same column. A custom name goes through
 * the same conversion, so it is always safe for vMix.
 */
function servedColumns(values, { vmixKeys = true, columns } = {}) {
  if (!values.length) return [];
  const hide = new Set(columns?.hide || []);
  const rename = columns?.rename || {};
  const headerRow = values[0];
  const seen = new Map();
  const out = [];
  columnIds(values).forEach((id, i) => {
    if (hide.has(id)) return;
    const header = String(headerRow[i] ?? '').trim();
    const wanted = rename[id] ?? header;
    let name = (vmixKeys ? vmixName(wanted) : wanted) || columnLetter(i);
    const key = vmixKeys ? name.toLowerCase() : name;
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (count > 0) name = `${name}_${count + 1}`;
    out.push({ index: i, id, header, name });
  });
  return out;
}

/** Turn a 2D array into [{Header: value, ...}, ...] with consistent keys. */
function rowsToObjects(values, { skipEmpty = true, vmixKeys = true, columns } = {}) {
  if (values.length === 0) return [];
  const cols = servedColumns(values, { vmixKeys, columns });
  return values.slice(1)
    // A row counts as empty when every column it serves is empty.
    .filter((r) => !skipEmpty || cols.some((c) => String(r[c.index] ?? '').trim() !== ''))
    .map((r) => {
      const obj = {};
      for (const c of cols) obj[c.name] = r[c.index] === undefined || r[c.index] === null ? '' : String(r[c.index]);
      return obj;
    });
}

/**
 * Saved column settings for one sheet (tab) of a spreadsheet, keyed by the
 * sheet's gid so they survive renaming the sheet. ?columns=all ignores them.
 */
function columnSettings(sheet, tab, q) {
  if (!tab || q?.get('columns') === 'all') return undefined;
  return sheet.columns?.[tab.gid];
}

function columnLetter(i) {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

async function tabData(sheet, tabName, rowParam, q) {
  const tab = await resolveTab(sheet, tabName);
  const values = await getValues(sheet, tab.name, q.get('range') || '', renderOption(q));
  if (q.has('raw')) return values;

  let rows = rowsToObjects(values, {
    skipEmpty: q.get('empty') !== '1', vmixKeys: q.get('keys') !== 'original', columns: columnSettings(sheet, tab, q),
  });
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
function publicSheet(s) {
  return {
    slug: s.slug,
    name: s.name,
    spreadsheetId: s.spreadsheetId,
    apiKeySet: Boolean(s.apiKey),
    apiKeyMasked: maskKey(s.apiKey),
    cacheSeconds: s.cacheSeconds,
    refresh: s.refresh !== false,
    showHidden: s.showHidden === true,
    columns: s.columns || {}, // { gid: { hide: [id], rename: { id: name } } }
  };
}

function publicConfig() {
  return { sheets: config.sheets.map(publicSheet) };
}

/** Config plus live connection health for every sheet. Never calls Google. */
function publicState() {
  return {
    sheets: config.sheets.map((s) => ({ ...publicSheet(s), health: sheetHealth(s) })),
    usage: { readsPerMinute: estimatedReadsPerMinute(), quotaPerMinute: QUOTA_PER_MINUTE },
    serverTime: new Date().toISOString(),
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
  const showHidden = body.showHidden === undefined ? existing?.showHidden === true : Boolean(body.showHidden);
  return { name, spreadsheetId, cacheSeconds, refresh, showHidden };
}

/** Check { hide, rename } from the Columns dialog. Returns null for "no settings". */
function validateColumnSettings(body) {
  const hide = [...new Set((Array.isArray(body.hide) ? body.hide : []).map(String))];
  const rename = {};
  for (const [id, name] of Object.entries(body.rename && typeof body.rename === 'object' ? body.rename : {})) {
    const n = String(name ?? '').trim();
    if (!n) continue;
    if (n.length > 100) throw httpError(400, `The name for "${id}" is too long (100 characters at most).`);
    if (!vmixName(n)) throw httpError(400, `"${n}" has no letters or digits, so vMix can't use it as a column name.`);
    rename[id] = n;
  }
  if (!hide.length && !Object.keys(rename).length) return null;
  return { ...(hide.length && { hide }), ...(Object.keys(rename).length && { rename }) };
}

/** Every column of one sheet as the Columns dialog shows it. */
async function columnsInfo(sheet, tab) {
  const values = await getValues(sheet, tab.name, '', 'FORMATTED_VALUE');
  const settings = sheet.columns?.[tab.gid] || {};
  const served = new Map(servedColumns(values, { columns: settings }).map((c) => [c.id, c.name]));
  const defaults = servedColumns(values);
  const sampleRow = values.slice(1).find((r) => r.some((c) => String(c ?? '').trim() !== '')) || [];
  const ids = columnIds(values);
  return {
    sheet: { name: tab.name, gid: tab.gid },
    settings,
    // Saved settings for columns that are no longer in the sheet (kept in case they come back).
    missing: [...new Set([...(settings.hide || []), ...Object.keys(settings.rename || {})])].filter((id) => !ids.includes(id)),
    columns: ids.map((id, i) => ({
      id,
      letter: columnLetter(i),
      header: String(values[0][i] ?? ''),
      defaultName: defaults[i].name,
      rename: settings.rename?.[id] || '',
      hidden: (settings.hide || []).includes(id),
      name: served.get(id) || null, // the name vMix gets, or null when hidden
      sample: String(sampleRow[i] ?? ''),
    })),
  };
}

async function handleAdmin(req, res, parts) {
  const method = req.method;
  const body = ['POST', 'PUT'].includes(method) ? await readJson(req) : {};

  // GET /api/config
  if (parts[1] === 'config' && method === 'GET') return sendJson(res, 200, publicConfig());

  // GET /api/state — config + health; the interface polls this every few seconds
  if (parts[1] === 'state' && method === 'GET') return sendJson(res, 200, publicState());

  if (parts[1] === 'sheets') {
    // POST /api/sheets  { name, spreadsheetId, apiKey, slug?, cacheSeconds?, refresh? }
    if (parts.length === 2 && method === 'POST') {
      const fields = validateSheetInput(body);
      const apiKey = String(body.apiKey ?? '').trim();
      if (!apiKey) throw httpError(400, 'API key is required');
      const sheet = { id: newId(), slug: uniqueSlug(body.slug || fields.name), ...fields, apiKey };
      config.sheets.push(sheet);
      saveConfig();
      if (sheet.refresh) startPoller(sheet);
      else refreshTabs(sheet).catch(() => {}); // paused: still show its tabs
      return sendJson(res, 201, { ...publicState(), saved: sheet.slug });
    }

    const sheet = findSheet(parts[2]);

    // POST /api/sheets/:slug/check — try Google right now (the Check button).
    // Live sheet: a full poll. Paused sheet: only the tab list, so its held data is untouched.
    // Errors are reported in the returned health, never as a failed request.
    if (parts[3] === 'check' && method === 'POST') {
      try {
        if (sheet.refresh) await pollSheet(sheet, { force: true });
        else await refreshTabs(sheet);
      } catch {
        // recorded in health
      }
      if (sheet.refresh) startPoller(sheet, healthOf(sheet).consecutiveFailures ? retryDelayMs(healthOf(sheet).consecutiveFailures) : ttlMs(sheet));
      return sendJson(res, 200, { ...publicSheet(sheet), health: sheetHealth(sheet) });
    }

    // GET /api/sheets/:slug/columns/:gid — every column of one sheet, with its
    // saved setting and a sample value (the Columns dialog and the Preview).
    // PUT /api/sheets/:slug/columns/:gid  { hide: [id], rename: { id: name } }
    if (parts[3] === 'columns' && parts.length === 5 && ['GET', 'PUT'].includes(method)) {
      const { tabs } = await getTabs(sheet);
      const tab = tabs.find((t) => String(t.gid) === parts[4]);
      if (!tab) throw httpError(404, 'That sheet no longer exists in the spreadsheet. Check the spreadsheet and try again.');
      if (method === 'PUT') {
        const settings = validateColumnSettings(body);
        sheet.columns = { ...sheet.columns };
        if (settings) sheet.columns[tab.gid] = settings;
        else delete sheet.columns[tab.gid];
        if (!Object.keys(sheet.columns).length) delete sheet.columns;
        saveConfig();
      }
      return sendJson(res, 200, await columnsInfo(sheet, tab));
    }

    // POST /api/sheets/:slug/clear-errors — forget the error history (the Clear button).
    // Resets the error counter, so the 10-minute count and any cache suggestion start
    // over. If Google is failing right now, the retry wait is reset too and the sheet
    // is tried again straight away; the error stays shown until that try succeeds.
    if (parts[3] === 'clear-errors' && method === 'POST') {
      const h = healthOf(sheet);
      h.recentErrors = [];
      if (h.consecutiveFailures > 0) {
        h.consecutiveFailures = 1; // still failing, but the next wait starts short again
        h.nextRetryAt = 0;
        if (sheet.refresh) startPoller(sheet);
      } else {
        h.lastError = null;
        h.lastErrorAt = 0;
      }
      return sendJson(res, 200, { ...publicSheet(sheet), health: sheetHealth(sheet) });
    }

    // POST /api/sheets/:slug/reload — fetch every tab from Google now (Fetch latest once).
    // For a paused sheet this replaces its held data once. If Google fails, the
    // old data is kept and the error is returned.
    if (parts[3] === 'reload' && method === 'POST') {
      const tabsData = await refreshTabs(sheet);
      await fetchAllValues(sheet, servedTabs(sheet, tabsData.tabs), 'FORMATTED_VALUE');
      // Other ranges/formats (?range=, ?render=) are re-read on their next request.
      const keep = new Set(servedTabs(sheet, tabsData.tabs).map((t) => `${sheet.id}|${valuesKey(a1For(t.name, ''), 'FORMATTED_VALUE')}`));
      for (const k of cache.keys()) if (k.startsWith(`${sheet.id}|values|`) && !keep.has(k)) cache.delete(k);
      return sendJson(res, 200, { ...publicSheet(sheet), health: sheetHealth(sheet) });
    }

    // PUT /api/sheets/:slug  { name?, spreadsheetId?, slug?, apiKey?, cacheSeconds?, refresh? }
    // Any field left out keeps its current value; a blank apiKey keeps the saved key.
    if (parts.length === 3 && method === 'PUT') {
      const fields = validateSheetInput(body, sheet);
      const newKey = String(body.apiKey ?? '').trim();
      // Only throw away cached data (and the error history) when the source itself changes.
      const sourceChanged = fields.spreadsheetId !== sheet.spreadsheetId || (newKey && newKey !== sheet.apiKey);
      const resumed = sheet.refresh === false && fields.refresh;
      const hiddenChanged = fields.showHidden !== (sheet.showHidden === true);
      if (fields.cacheSeconds !== sheet.cacheSeconds) healthOf(sheet).cacheChangedAt = Date.now();
      if (sourceChanged) {
        clearCache(sheet);
        health.delete(sheet.id);
        // Column settings belong to the old spreadsheet's sheets.
        if (fields.spreadsheetId !== sheet.spreadsheetId) delete sheet.columns;
      }
      Object.assign(sheet, fields);
      if (body.slug && slugify(body.slug) !== sheet.slug) sheet.slug = uniqueSlug(body.slug, sheet.slug);
      if (newKey) sheet.apiKey = newKey;
      saveConfig();
      if (sheet.refresh) {
        // Poll now if the source changed or the sheet was just resumed; otherwise keep the rhythm.
        const entry = cache.get(`${sheet.id}|${tabsKey}`);
        startPoller(sheet, sourceChanged || resumed || hiddenChanged || !entry ? 0 : ttlMs(sheet));
      } else {
        stopPoller(sheet);
        if (sourceChanged) refreshTabs(sheet).catch(() => {});
      }
      return sendJson(res, 200, { ...publicState(), saved: sheet.slug });
    }

    // DELETE /api/sheets/:slug
    if (parts.length === 3 && method === 'DELETE') {
      config.sheets = config.sheets.filter((s) => s !== sheet);
      stopPoller(sheet);
      clearCache(sheet);
      health.delete(sheet.id);
      saveConfig();
      return sendJson(res, 200, publicState());
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

    // GET /all          -> every tab of every sheet
    // GET /all/:slug    -> every tab of one sheet
    // vMix only accepts an array of row objects at the top level, so by default every
    // row is returned in one flat array with Sheet/Tab/Row columns added.
    // ?format=object returns the grouped shape { sheet: { tab: [rows] } } instead.
    if (parts[0] === 'all' && parts.length <= 2) {
      const grouped = q.get('format') === 'object' || q.has('raw');
      const sheets = parts.length === 2 ? [findSheet(parts[1])] : config.sheets;
      const results = await Promise.all(sheets.map(async (s) => {
        try {
          return { sheet: s, tabs: await allTabsData(s, q) };
        } catch (err) {
          if (parts.length === 2) throw err; // a single requested sheet: report the error
          console.error(`/all: ${s.slug}: ${err.message}`);
          return { sheet: s, tabs: {}, error: err.message };
        }
      }));

      if (grouped) {
        if (parts.length === 2) return sendJson(res, 200, results[0].tabs);
        const out = {};
        const errors = {};
        for (const r of results) {
          out[r.sheet.slug] = r.tabs;
          if (r.error) errors[r.sheet.slug] = r.error;
        }
        if (Object.keys(errors).length) out._errors = errors;
        return sendJson(res, 200, out);
      }
      return sendJson(res, 200, flattenForVmix(results, { includeSheet: parts.length === 1 }));
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

    return sendJson(res, 404, { error: 'Not found. Try / , /all, /sheets or /sheet/<sheet>/<tab>' });
  } catch (err) {
    if (err.status !== 404) console.error(`${req.method} ${req.url} -> ${err.message}`);
    return sendJson(res, err.status || 500, { error: err.message });
  }
});

function defaultSheet(q) {
  if (q.get('sheet')) return findSheet(q.get('sheet'));
  if (!config.sheets[0]) throw httpError(400, 'No spreadsheets configured. Add one in the web interface.');
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
  // Start polling every live sheet, staggered so they don't all hit Google at once.
  config.sheets.forEach((s, i) => {
    if (s.refresh) startPoller(s, i * 300);
    else refreshTabs(s).catch(() => {}); // paused: load the tab list so the interface can show it
  });
});

// A bug in one request must never take the proxy (and every vMix input) down.
process.on('uncaughtException', (err) => console.error('Unexpected error:', err));
process.on('unhandledRejection', (err) => console.error('Unexpected error:', err));
