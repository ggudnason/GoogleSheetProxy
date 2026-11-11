import { InstanceBase, InstanceStatus } from '@companion-module/base'
import { getActionDefinitions } from './actions.js'
import { ProxyApi } from './api.js'
import { getFeedbackDefinitions } from './feedbacks.js'
import { getPresets } from './presets.js'
import { hasErrors } from './status.js'
import { UpgradeScripts } from './upgrades.js'
import { getVariableDefinitions, getVariableValues } from './variables.js'

export { UpgradeScripts }

export default class GoogleSheetProxyInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.sheets = [] // spreadsheets from the proxy's /api/state
		this.connected = false
		this.lastError = ''
		this.timer = null
		this.polling = false
		this.definitionsKey = null
		this.stateKey = null
		this.statusKey = null
	}

	async init(config, _isFirstInit, secrets) {
		await this.configUpdated(config, secrets)
	}

	async configUpdated(config, secrets) {
		this.config = config
		this.api = new ProxyApi(config, secrets?.password)
		this.stopPolling()
		this.connected = false
		this.definitionsKey = null
		this.stateKey = null
		this.statusKey = null
		this.setStatus(InstanceStatus.Connecting)
		this.updateDefinitions()
		// Don't wait for the first answer here: Companion expects init to return quickly.
		this.poll()
	}

	async destroy() {
		this.stopPolling()
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'intro',
				width: 12,
				label: '',
				value:
					'Connects to Google Sheet Proxy (github.com/ggudnason/GoogleSheetProxy). Enter the address of the computer running the proxy and the port its web interface uses.',
			},
			{ type: 'textinput', id: 'host', label: 'Proxy address', width: 8, default: '127.0.0.1', minLength: 1 },
			{ type: 'number', id: 'port', label: 'Port', width: 4, default: 3000, min: 1, max: 65535 },
			{
				type: 'checkbox',
				id: 'https',
				label: 'Use HTTPS',
				width: 4,
				default: false,
				description: 'Only when the proxy sits behind an HTTPS reverse proxy.',
			},
			{
				type: 'number',
				id: 'pollMs',
				label: 'Status update every (ms)',
				width: 4,
				default: 1000,
				min: 250,
				max: 60000,
				description: 'How often Companion asks the proxy for its status. This does not change how often the proxy asks Google.',
			},
			{
				type: 'secret-text',
				id: 'password',
				label: 'Admin password',
				width: 8,
				description: 'Only needed when the proxy was started with ADMIN_PASSWORD.',
			},
		]
	}

	// ---- polling ----------------------------------------------------------

	stopPolling() {
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
	}

	poll() {
		this.stopPolling()
		this.refreshState().finally(() => {
			const ms = Math.min(60000, Math.max(250, Number(this.config?.pollMs) || 1000))
			this.timer = setTimeout(() => this.poll(), ms)
		})
	}

	/** Read /api/state and update definitions, variables, feedbacks and the connection status. */
	async refreshState() {
		if (this.polling) return this.polling
		this.polling = (async () => {
			const api = this.api
			try {
				const state = await api.state()
				if (api !== this.api) return // the config changed while we waited
				this.sheets = Array.isArray(state?.sheets) ? state.sheets : []
				this.connected = true
				this.lastError = ''
				const errors = this.sheets.filter((s) => s.refresh && hasErrors(s)).length
				if (errors) this.setStatus(InstanceStatus.UnknownWarning, `${errors} spreadsheet${errors === 1 ? ' has' : 's have'} errors from Google`)
				else this.setStatus(InstanceStatus.Ok)
			} catch (err) {
				if (api !== this.api) return
				this.connected = false
				this.lastError = err.message
				this.setStatus(err.auth ? InstanceStatus.AuthenticationFailure : InstanceStatus.ConnectionFailure, err.message)
			}
			this.updateDefinitions()
			this.setVariableValues(getVariableValues(this))
			// Re-check feedbacks only when something they show has changed.
			const key = JSON.stringify([this.connected, this.sheets.map((s) => [s.slug, s.refresh, s.cacheSeconds, s.health?.state, s.health?.consecutiveFailures])])
			if (key !== this.stateKey) {
				this.stateKey = key
				this.checkAllFeedbacks()
			}
		})().finally(() => {
			this.polling = false
		})
		return this.polling
	}

	setStatus(status, message = null) {
		const key = `${status}|${message}`
		if (key === this.statusKey) return
		if (this.statusKey) this.log(status === InstanceStatus.Ok ? 'info' : 'warn', message || `Status: ${status}`)
		this.statusKey = key
		this.updateStatus(status, message)
	}

	/** Actions, feedbacks, variables and presets list the proxy's spreadsheets, so redefine them when that list changes. */
	updateDefinitions() {
		const key = JSON.stringify([this.label, this.sheets.map((s) => [s.slug, s.name])])
		if (key === this.definitionsKey) return
		this.definitionsKey = key
		this.setActionDefinitions(getActionDefinitions(this))
		this.setFeedbackDefinitions(getFeedbackDefinitions(this))
		this.setVariableDefinitions(getVariableDefinitions(this))
		const [structure, presets] = getPresets(this)
		this.setPresetDefinitions(structure, presets)
	}

	findSheet(slug) {
		return this.sheets.find((s) => s.slug === slug)
	}
}
