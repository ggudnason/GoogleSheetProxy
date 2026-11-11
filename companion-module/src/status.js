// Turns the proxy's /api/state into simple statuses for buttons and variables.

/** Every status a spreadsheet (or the proxy as a whole) can be in. */
export const STATUSES = {
	live: { label: 'Live', color: 0xffffff, bgcolor: 0x15803d },
	paused: { label: 'Paused', color: 0xffffff, bgcolor: 0x4b5563 },
	starting: { label: 'Starting', color: 0x000000, bgcolor: 0xeab308 },
	stale: { label: 'Error, old data', color: 0x000000, bgcolor: 0xf97316 },
	error: { label: 'Error', color: 0xffffff, bgcolor: 0xb91c1c },
	offline: { label: 'Proxy offline', color: 0xffffff, bgcolor: 0x450a0a },
}

export const STATUS_CHOICES = Object.entries(STATUSES).map(([id, s]) => ({ id, label: s.label }))

/** Special option value meaning "every spreadsheet". */
export const ALL = '__all__'

/**
 * The status of one spreadsheet from the proxy.
 * paused: auto refresh is off. Otherwise the proxy's health: live, starting,
 * stale (Google is failing but old data is still served) or error.
 */
export function statusOf(sheet, connected = true) {
	if (!connected || !sheet) return 'offline'
	if (!sheet.refresh) return 'paused'
	const state = sheet.health?.state
	if (state === 'ok') return 'live'
	if (state === 'stale' || state === 'error' || state === 'starting') return state
	return 'starting'
}

/** True when Google is failing for this spreadsheet right now. */
export function hasErrors(sheet) {
	return Boolean(sheet && sheet.health && sheet.health.consecutiveFailures > 0)
}

/**
 * One status for all spreadsheets together: the worst one among live
 * spreadsheets, live if any is live, and paused only when all are paused.
 */
export function overallStatus(sheets, connected = true) {
	if (!connected) return 'offline'
	const statuses = sheets.map((s) => statusOf(s))
	for (const s of ['error', 'stale', 'starting', 'live']) if (statuses.includes(s)) return s
	return 'paused'
}

/** "12s ago", "3m ago", "2h ago" for an ISO time, or "" when there is none. */
export function ago(iso, now = Date.now()) {
	if (!iso) return ''
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
	if (s < 60) return `${s}s ago`
	if (s < 3600) return `${Math.floor(s / 60)}m ago`
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`
	return `${Math.floor(s / 86400)}d ago`
}

/** "in 12s" until an ISO time, "now" when it has passed, "" when there is none. */
export function until(iso, now = Date.now()) {
	if (!iso) return ''
	const s = Math.round((Date.parse(iso) - now) / 1000)
	return s > 0 ? `in ${s}s` : 'now'
}

/** "HH:MM:SS" in local time for an ISO time, or "". */
export function clock(iso) {
	if (!iso) return ''
	const d = new Date(iso)
	return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

/** "30s", "2m", "1m 30s", "1h" for a number of seconds. */
export function duration(seconds) {
	const s = Math.round(Number(seconds) || 0)
	if (s < 60) return `${s}s`
	if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`
	const m = Math.round((s % 3600) / 60)
	return m ? `${Math.floor(s / 3600)}h ${m}m` : `${s / 3600}h`
}

/** A spreadsheet slug as a safe variable id prefix, e.g. "news-desk" -> "news_desk". */
export function varPrefix(slug) {
	return String(slug).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'sheet'
}
