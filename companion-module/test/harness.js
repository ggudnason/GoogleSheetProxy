// Builds a module instance without Companion: its host calls are replaced by
// recorders, so tests can see what the module sends to Companion.

import GoogleSheetProxyInstance from '../src/main.js'

/** A module instance with Companion's host calls replaced by recorders. */
export function makeInstance(label = 'sheetproxy') {
	const inst = Object.create(GoogleSheetProxyInstance.prototype)
	Object.assign(inst, {
		sheets: [],
		connected: false,
		lastError: '',
		timer: null,
		polling: false,
		definitionsKey: null,
		stateKey: null,
		statusKey: null,
		rec: { status: null, logs: [], vars: {}, defs: {}, feedbackChecks: 0 },
	})
	Object.defineProperty(inst, 'label', { value: label })
	inst.updateStatus = (status, message) => (inst.rec.status = { status, message })
	inst.log = (level, message) => inst.rec.logs.push(`${level}: ${message}`)
	inst.setActionDefinitions = (d) => (inst.rec.defs.actions = d)
	inst.setFeedbackDefinitions = (d) => (inst.rec.defs.feedbacks = d)
	inst.setVariableDefinitions = (d) => (inst.rec.defs.variables = d)
	inst.setPresetDefinitions = (structure, presets) => (inst.rec.defs.presets = { structure, presets })
	inst.setVariableValues = (v) => Object.assign(inst.rec.vars, v)
	inst.checkAllFeedbacks = () => inst.rec.feedbackChecks++
	return inst
}
