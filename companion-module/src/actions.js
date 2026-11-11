import { ALL } from './status.js'

export const MIN_INTERVAL = 1
export const MAX_INTERVAL = 86400

/** The spreadsheet picker used by actions and feedbacks. */
export function sheetOption(self, { all = false, allLabel = 'All spreadsheets' } = {}) {
	const choices = self.sheets.map((s) => ({ id: s.slug, label: s.name }))
	if (all) choices.unshift({ id: ALL, label: allLabel })
	return {
		type: 'dropdown',
		id: 'sheet',
		label: 'Spreadsheet',
		choices,
		default: choices[0]?.id ?? '',
		allowCustom: true,
		description: 'Pick a spreadsheet, or type its URL name (the part after /sheet/ in its URLs).',
	}
}

const clampInterval = (n) => Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(Number(n))))

export function getActionDefinitions(self) {
	/** Run fn for one spreadsheet, or for each one when "All spreadsheets" is picked. */
	const forSheets = async (slug, fn) => {
		const targets = slug === ALL ? self.sheets : [self.findSheet(slug)]
		if (targets.some((s) => s === undefined)) throw new Error(`Spreadsheet "${slug}" was not found in the proxy`)
		const results = await Promise.allSettled(targets.map((s) => fn(s)))
		await self.refreshState()
		const failed = results.filter((r) => r.status === 'rejected')
		if (failed.length) throw failed[0].reason
	}
	const run = (name, fn) => async (action) => {
		try {
			await fn(action.options)
		} catch (err) {
			self.log('error', `${name}: ${err.message}`)
		}
	}

	return {
		set_refresh: {
			name: 'Auto refresh: on, off or toggle',
			description: 'Turn automatic refresh from Google on or off. When off, the proxy keeps serving the data it has.',
			options: [
				sheetOption(self, { all: true }),
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Set to',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Off' },
					],
					default: 'toggle',
				},
			],
			callback: run('Auto refresh', async ({ sheet, mode }) => {
				// "Toggle" for all spreadsheets: turn all off if any is on, otherwise all on.
				const allOn = sheet === ALL && mode === 'toggle' ? !self.sheets.some((s) => s.refresh) : null
				await forSheets(sheet, (s) => {
					const on = mode === 'on' ? true : mode === 'off' ? false : allOn ?? !s.refresh
					return on === s.refresh ? null : self.api.update(s.slug, { refresh: on })
				})
			}),
		},

		set_interval: {
			name: 'Refresh interval: set',
			description: 'How often the proxy asks Google for new data (its cache time).',
			options: [
				sheetOption(self, { all: true }),
				{
					type: 'number',
					id: 'seconds',
					label: 'Seconds',
					default: 10,
					min: MIN_INTERVAL,
					max: MAX_INTERVAL,
					step: 1,
				},
			],
			callback: run('Refresh interval', async ({ sheet, seconds }) => {
				const value = clampInterval(seconds)
				if (!Number.isFinite(value)) throw new Error('The interval must be a number of seconds')
				await forSheets(sheet, (s) => (s.cacheSeconds === value ? null : self.api.update(s.slug, { cacheSeconds: value })))
			}),
		},

		adjust_interval: {
			name: 'Refresh interval: increase or decrease',
			description: 'Add seconds to the interval, or use a negative number to shorten it.',
			options: [
				sheetOption(self, { all: true }),
				{
					type: 'number',
					id: 'step',
					label: 'Seconds to add (negative to subtract)',
					default: 5,
					min: -MAX_INTERVAL,
					max: MAX_INTERVAL,
					step: 1,
				},
			],
			callback: run('Refresh interval', async ({ sheet, step }) => {
				const delta = Math.round(Number(step) || 0)
				await forSheets(sheet, (s) => {
					const value = clampInterval((s.cacheSeconds ?? 5) + delta)
					return value === s.cacheSeconds ? null : self.api.update(s.slug, { cacheSeconds: value })
				})
			}),
		},

		fetch_now: {
			name: 'Fetch latest data now',
			description: 'Read every sheet from Google straight away. For a spreadsheet with auto refresh off, this replaces its held data once.',
			options: [sheetOption(self, { all: true })],
			callback: run('Fetch now', ({ sheet }) => forSheets(sheet, (s) => self.api.reload(s.slug))),
		},

		check_now: {
			name: 'Check connection to Google',
			description: 'Try Google now and update the status (the Check button in the proxy).',
			options: [sheetOption(self, { all: true })],
			callback: run('Check', ({ sheet }) => forSheets(sheet, (s) => self.api.check(s.slug))),
		},

		clear_errors: {
			name: 'Clear errors',
			description: 'Reset the error counter. If Google is still failing, the proxy tries again straight away.',
			options: [sheetOption(self, { all: true })],
			callback: run('Clear errors', ({ sheet }) => forSheets(sheet, (s) => self.api.clearErrors(s.slug))),
		},
	}
}
