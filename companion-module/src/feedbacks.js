import { sheetOption } from './actions.js'
import { ALL, STATUSES, STATUS_CHOICES, hasErrors, overallStatus, statusOf } from './status.js'

const ANY_LABEL = 'Any spreadsheet (overall)'

export function getFeedbackDefinitions(self) {
	/** The status of the picked spreadsheet, or the overall status for "Any spreadsheet". */
	const statusFor = (slug) => (slug === ALL ? overallStatus(self.sheets, self.connected) : statusOf(self.findSheet(slug), self.connected))

	return {
		status_color: {
			type: 'advanced',
			name: 'Status color',
			description:
				'Colors the button by status: green live, grey paused, yellow starting, orange error with old data still served, red error, dark red proxy offline.',
			options: [sheetOption(self, { all: true, allLabel: ANY_LABEL })],
			affectedProperties: ['color', 'bgcolor'],
			callback: (feedback) => {
				const s = STATUSES[statusFor(feedback.options.sheet)]
				return { color: s.color, bgcolor: s.bgcolor }
			},
		},

		refresh_on: {
			type: 'boolean',
			name: 'Auto refresh is on',
			description: 'True while the proxy refreshes this spreadsheet from Google automatically.',
			options: [sheetOption(self, { all: true, allLabel: 'All spreadsheets (all must be on)' })],
			defaultStyle: { color: 0xffffff, bgcolor: STATUSES.live.bgcolor },
			callback: (feedback) => {
				if (!self.connected) return false
				if (feedback.options.sheet === ALL) return self.sheets.length > 0 && self.sheets.every((s) => s.refresh)
				return Boolean(self.findSheet(feedback.options.sheet)?.refresh)
			},
		},

		has_errors: {
			type: 'boolean',
			name: 'Has errors',
			description: 'True while Google is failing for this spreadsheet, or while the proxy cannot be reached. For any spreadsheet, only those with auto refresh on count.',
			options: [sheetOption(self, { all: true, allLabel: ANY_LABEL })],
			defaultStyle: { color: 0xffffff, bgcolor: STATUSES.error.bgcolor },
			callback: (feedback) => {
				if (!self.connected) return true
				if (feedback.options.sheet === ALL) return self.sheets.some((s) => s.refresh && hasErrors(s))
				return hasErrors(self.findSheet(feedback.options.sheet))
			},
		},

		status_is: {
			type: 'boolean',
			name: 'Status is…',
			description: 'True when the spreadsheet is in the chosen status.',
			options: [
				sheetOption(self, { all: true, allLabel: ANY_LABEL }),
				{ type: 'dropdown', id: 'status', label: 'Status', choices: STATUS_CHOICES, default: 'live' },
			],
			defaultStyle: { color: 0xffffff, bgcolor: STATUSES.live.bgcolor },
			callback: (feedback) => statusFor(feedback.options.sheet) === feedback.options.status,
		},

		interval_is: {
			type: 'boolean',
			name: 'Refresh interval is…',
			description: 'True when the spreadsheet refreshes at this interval.',
			options: [
				sheetOption(self),
				{ type: 'number', id: 'seconds', label: 'Seconds', default: 10, min: 1, max: 86400, step: 1 },
			],
			defaultStyle: { color: 0xffffff, bgcolor: 0x1d4ed8 },
			callback: (feedback) => {
				const s = self.findSheet(feedback.options.sheet)
				return Boolean(self.connected && s && s.cacheSeconds === Number(feedback.options.seconds))
			},
		},

		connected: {
			type: 'boolean',
			name: 'Proxy is reachable',
			description: 'True while Companion can reach the proxy.',
			options: [],
			defaultStyle: { color: 0xffffff, bgcolor: STATUSES.live.bgcolor },
			callback: () => self.connected,
		},
	}
}
