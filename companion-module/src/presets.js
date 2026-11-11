import { ALL, STATUSES, varPrefix } from './status.js'

const WHITE = 0xffffff
const DARK = 0x1f2937
const BLUE = 0x1d4ed8

const press = (actionId, options) => [{ down: [{ actionId, options }], up: [] }]
const noPress = () => [{ down: [], up: [] }]

/**
 * Presets for every spreadsheet in the proxy, plus a section for all of them.
 * Returns [structure, presets] for setPresetDefinitions.
 */
export function getPresets(self) {
	const v = (id) => `$(${self.label}:${id})`
	const presets = {}
	const structure = []
	const add = (id, def) => {
		presets[id] = { type: 'simple', ...def }
		return id
	}
	const statusColor = (sheet) => ({ feedbackId: 'status_color', options: { sheet } })

	// ---- All spreadsheets ------------------------------------------------
	structure.push({
		id: 'all',
		name: 'All spreadsheets',
		description: 'Control and watch every spreadsheet in the proxy at once.',
		definitions: [
			{
				id: 'all-status',
				type: 'simple',
				name: 'Status',
				presets: [
					add('all_status', {
						name: 'Overall status',
						notes: 'Green when live, orange or red when any spreadsheet has errors. Press to check every spreadsheet now.',
						style: { text: `Sheets\\n${v('status')}`, size: 'auto', color: WHITE, bgcolor: DARK },
						steps: press('check_now', { sheet: ALL }),
						feedbacks: [statusColor(ALL)],
					}),
					add('all_errors', {
						name: 'Error count (press to clear)',
						notes: 'Shows how many spreadsheets have errors and turns red while any does. Press to clear the errors.',
						style: { text: `Errors\\n${v('error_count')}`, size: 'auto', color: WHITE, bgcolor: DARK },
						steps: press('clear_errors', { sheet: ALL }),
						feedbacks: [{ feedbackId: 'has_errors', options: { sheet: ALL }, style: { color: WHITE, bgcolor: STATUSES.error.bgcolor } }],
					}),
					add('all_connected', {
						name: 'Proxy connection',
						style: { text: `Proxy\\nOFFLINE`, size: 'auto', color: WHITE, bgcolor: STATUSES.offline.bgcolor },
						steps: noPress(),
						feedbacks: [{ feedbackId: 'connected', options: {}, style: { text: 'Proxy\\nOK', color: WHITE, bgcolor: STATUSES.live.bgcolor } }],
					}),
				],
			},
			{
				id: 'all-refresh',
				type: 'simple',
				name: 'Auto refresh',
				presets: [
					add('all_refresh_toggle', {
						name: 'Toggle auto refresh for all',
						notes: 'Turns every spreadsheet off if any is on, otherwise turns them all on.',
						style: { text: `All auto\\n${v('live_count')}/${v('sheet_count')} on`, size: 'auto', color: WHITE, bgcolor: DARK },
						steps: press('set_refresh', { sheet: ALL, mode: 'toggle' }),
						feedbacks: [statusColor(ALL)],
					}),
					add('all_refresh_on', {
						name: 'All auto refresh on',
						style: { text: 'All auto\\nON', size: 'auto', color: WHITE, bgcolor: DARK },
						steps: press('set_refresh', { sheet: ALL, mode: 'on' }),
						feedbacks: [{ feedbackId: 'refresh_on', options: { sheet: ALL }, style: { color: WHITE, bgcolor: STATUSES.live.bgcolor } }],
					}),
					add('all_refresh_off', {
						name: 'All auto refresh off',
						style: { text: 'All auto\\nOFF', size: 'auto', color: WHITE, bgcolor: DARK },
						steps: press('set_refresh', { sheet: ALL, mode: 'off' }),
						feedbacks: [{ feedbackId: 'status_is', options: { sheet: ALL, status: 'paused' }, style: { color: WHITE, bgcolor: STATUSES.paused.bgcolor } }],
					}),
					add('all_fetch', {
						name: 'Fetch all now',
						style: { text: 'Fetch all\\nnow', size: 'auto', color: WHITE, bgcolor: DARK },
						steps: press('fetch_now', { sheet: ALL }),
						feedbacks: [],
					}),
				],
			},
		],
	})

	// ---- One section per spreadsheet --------------------------------------
	for (const s of self.sheets) {
		const p = varPrefix(s.slug)
		const id = (name) => `${p}__${name}`
		const sheet = s.slug
		const name = v(`${p}_name`)
		const refreshOn = { feedbackId: 'refresh_on', options: { sheet }, style: { color: WHITE, bgcolor: STATUSES.live.bgcolor } }

		const intervals = [5, 10, 30, 60].map((sec) =>
			add(id(`interval_${sec}`), {
				name: `Interval ${sec}s`,
				style: { text: `Every\\n${sec < 60 ? `${sec}s` : `${sec / 60}m`}`, size: 'auto', color: WHITE, bgcolor: DARK },
				steps: press('set_interval', { sheet, seconds: sec }),
				feedbacks: [{ feedbackId: 'interval_is', options: { sheet, seconds: sec }, style: { color: WHITE, bgcolor: BLUE } }],
			}),
		)

		structure.push({
			id: `sheet-${p}`,
			name: s.name,
			description: `Presets for the spreadsheet "${s.name}" (/sheet/${s.slug}).`,
			keywords: [s.slug],
			definitions: [
				{
					id: `sheet-${p}-refresh`,
					type: 'simple',
					name: 'Auto refresh',
					presets: [
						add(id('refresh_toggle'), {
							name: 'Toggle auto refresh',
							notes: 'Press to turn auto refresh on or off. The color shows the status: green live, grey paused, orange or red on errors.',
							style: { text: `${name}\\n${v(`${p}_status`)}`, size: 'auto', color: WHITE, bgcolor: DARK },
							steps: press('set_refresh', { sheet, mode: 'toggle' }),
							feedbacks: [statusColor(sheet)],
						}),
						add(id('refresh_on'), {
							name: 'Auto refresh on',
							style: { text: `${name}\\nAuto ON`, size: 'auto', color: WHITE, bgcolor: DARK },
							steps: press('set_refresh', { sheet, mode: 'on' }),
							feedbacks: [refreshOn],
						}),
						add(id('refresh_off'), {
							name: 'Auto refresh off',
							style: { text: `${name}\\nAuto OFF`, size: 'auto', color: WHITE, bgcolor: DARK },
							steps: press('set_refresh', { sheet, mode: 'off' }),
							feedbacks: [{ feedbackId: 'status_is', options: { sheet, status: 'paused' }, style: { color: WHITE, bgcolor: STATUSES.paused.bgcolor } }],
						}),
						add(id('fetch'), {
							name: 'Fetch latest now',
							notes: 'Reads every sheet from Google now. With auto refresh off, this replaces the held data once.',
							style: { text: `${name}\\nFetch now`, size: 'auto', color: WHITE, bgcolor: DARK },
							steps: press('fetch_now', { sheet }),
							feedbacks: [],
						}),
					],
				},
				{
					id: `sheet-${p}-interval`,
					type: 'simple',
					name: 'Refresh interval',
					presets: [
						add(id('interval_down'), {
							name: 'Interval −5s',
							style: { text: 'Interval\\n−5s', size: 'auto', color: WHITE, bgcolor: DARK },
							steps: press('adjust_interval', { sheet, step: -5 }),
							feedbacks: [],
						}),
						add(id('interval_show'), {
							name: 'Show interval',
							style: { text: `${name}\\nEvery ${v(`${p}_interval_text`)}`, size: 'auto', color: WHITE, bgcolor: DARK },
							steps: noPress(),
							feedbacks: [refreshOn],
						}),
						add(id('interval_up'), {
							name: 'Interval +5s',
							style: { text: 'Interval\\n+5s', size: 'auto', color: WHITE, bgcolor: DARK },
							steps: press('adjust_interval', { sheet, step: 5 }),
							feedbacks: [],
						}),
						...intervals,
					],
				},
				{
					id: `sheet-${p}-status`,
					type: 'simple',
					name: 'Status',
					presets: [
						add(id('status'), {
							name: 'Status and last update',
							notes: 'Shows the status and how long ago the data last changed. Press to check Google now.',
							style: { text: `${name}\\n${v(`${p}_status`)}\\n${v(`${p}_updated`)}`, size: 'auto', color: WHITE, bgcolor: DARK },
							steps: press('check_now', { sheet }),
							feedbacks: [statusColor(sheet)],
						}),
						add(id('errors'), {
							name: 'Errors (press to clear)',
							notes: 'Shows failed tries in a row and the next retry, and turns red while Google is failing. Press to clear the errors.',
							style: { text: `${name}\\nErrors ${v(`${p}_failures`)}\\n${v(`${p}_next_retry`)}`, size: 'auto', color: WHITE, bgcolor: DARK },
							steps: press('clear_errors', { sheet }),
							feedbacks: [{ feedbackId: 'has_errors', options: { sheet }, style: { color: WHITE, bgcolor: STATUSES.error.bgcolor } }],
						}),
						add(id('updated'), {
							name: 'Last update time',
							style: { text: `Updated\\n${v(`${p}_updated_time`)}`, size: 'auto', color: WHITE, bgcolor: DARK },
							steps: noPress(),
							feedbacks: [statusColor(sheet)],
						}),
					],
				},
			],
		})
	}

	return [structure, presets]
}
