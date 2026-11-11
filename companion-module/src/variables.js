import { STATUSES, ago, clock, duration, hasErrors, overallStatus, statusOf, until, varPrefix } from './status.js'

/** Variable definitions: a few for the proxy as a whole, and a set per spreadsheet. */
export function getVariableDefinitions(self) {
	const defs = {
		connected: { name: 'Proxy reachable (Yes/No)' },
		status: { name: 'Overall status (Live, Paused, Error, …)' },
		sheet_count: { name: 'Number of spreadsheets' },
		live_count: { name: 'Spreadsheets with auto refresh on' },
		error_count: { name: 'Spreadsheets with auto refresh on that have errors' },
		last_error: { name: 'Proxy connection error' },
	}
	for (const s of self.sheets) {
		const p = varPrefix(s.slug)
		const n = s.name
		Object.assign(defs, {
			[`${p}_name`]: { name: `${n}: name` },
			[`${p}_refresh`]: { name: `${n}: auto refresh (On/Off)` },
			[`${p}_status`]: { name: `${n}: status (Live, Paused, Error, …)` },
			[`${p}_interval`]: { name: `${n}: refresh interval in seconds` },
			[`${p}_interval_text`]: { name: `${n}: refresh interval, e.g. 30s or 2m` },
			[`${p}_updated`]: { name: `${n}: time since the data last changed, e.g. 12s ago` },
			[`${p}_updated_time`]: { name: `${n}: time the data last changed (HH:MM:SS)` },
			[`${p}_failures`]: { name: `${n}: failed tries in a row` },
			[`${p}_errors_10min`]: { name: `${n}: errors in the last 10 minutes` },
			[`${p}_error`]: { name: `${n}: last error message` },
			[`${p}_next_retry`]: { name: `${n}: next try after an error, e.g. in 12s` },
		})
	}
	return defs
}

export function getVariableValues(self) {
	const now = Date.now()
	const c = self.connected
	const values = {
		connected: c ? 'Yes' : 'No',
		status: STATUSES[overallStatus(self.sheets, c)].label,
		sheet_count: self.sheets.length,
		live_count: self.sheets.filter((s) => s.refresh).length,
		error_count: self.sheets.filter((s) => s.refresh && hasErrors(s)).length,
		last_error: self.lastError || '',
	}
	for (const s of self.sheets) {
		const p = varPrefix(s.slug)
		const h = s.health || {}
		Object.assign(values, {
			[`${p}_name`]: s.name,
			[`${p}_refresh`]: s.refresh ? 'On' : 'Off',
			[`${p}_status`]: STATUSES[statusOf(s, c)].label,
			[`${p}_interval`]: s.cacheSeconds,
			[`${p}_interval_text`]: duration(s.cacheSeconds),
			[`${p}_updated`]: ago(h.dataUpdatedAt, now),
			[`${p}_updated_time`]: clock(h.dataUpdatedAt),
			[`${p}_failures`]: h.consecutiveFailures ?? 0,
			[`${p}_errors_10min`]: h.errorsLast10Min ?? 0,
			[`${p}_error`]: h.consecutiveFailures > 0 ? h.lastError || '' : '',
			[`${p}_next_retry`]: until(h.nextRetryAt, now),
		})
	}
	return values
}
