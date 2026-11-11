// End-to-end test against a running Google Sheet Proxy, without Companion.
// Companion's host connection is replaced by a stub that records what the module sends.
//
//   PROXY_PORT=3997 npm test
//
// The proxy must have at least one spreadsheet. The test changes auto refresh and
// intervals and puts them back at the end, so don't point it at a live show.

import assert from 'node:assert/strict'
import { makeInstance } from './harness.js'
import { ALL } from '../src/status.js'

const port = Number(process.env.PROXY_PORT) || 3997
const password = process.env.PROXY_PASSWORD || ''

const runAction = (inst, actionId, options) => inst.rec.defs.actions[actionId].callback({ actionId, options })
const feedback = (inst, feedbackId, options) => inst.rec.defs.feedbacks[feedbackId].callback({ feedbackId, options })

let passed = 0
async function step(name, fn) {
	await fn()
	passed++
	console.log(`ok  ${name}`)
}

const inst = makeInstance()
await inst.configUpdated({ host: '127.0.0.1', port, https: false, pollMs: 60000 }, { password })
await inst.refreshState()
inst.stopPolling()

const first = inst.sheets[0]
assert.ok(first, 'the proxy needs at least one spreadsheet')
const slug = first.slug
const p = slug.replace(/[^a-z0-9_]+/g, '_')
const original = inst.sheets.map((s) => ({ slug: s.slug, refresh: s.refresh, cacheSeconds: s.cacheSeconds }))

try {
	await step('connects and reports OK', () => {
		assert.equal(inst.connected, true)
		assert.ok(['ok', 'unknown_warning'].includes(inst.rec.status.status), JSON.stringify(inst.rec.status))
		assert.equal(inst.rec.vars.connected, 'Yes')
		assert.equal(inst.rec.vars.sheet_count, inst.sheets.length)
	})

	await step('defines actions, feedbacks, variables and presets for every spreadsheet', () => {
		const { actions, feedbacks, variables, presets } = inst.rec.defs
		for (const id of ['set_refresh', 'set_interval', 'adjust_interval', 'fetch_now', 'check_now', 'clear_errors']) assert.ok(actions[id], id)
		for (const id of ['status_color', 'refresh_on', 'has_errors', 'status_is', 'interval_is', 'connected']) assert.ok(feedbacks[id], id)
		for (const s of inst.sheets) {
			const vp = s.slug.replace(/[^a-z0-9_]+/g, '_')
			for (const k of ['name', 'refresh', 'status', 'interval', 'interval_text', 'updated', 'updated_time', 'failures', 'errors_10min', 'error', 'next_retry']) {
				assert.ok(variables[`${vp}_${k}`], `variable ${vp}_${k}`)
				assert.ok(`${vp}_${k}` in inst.rec.vars, `value ${vp}_${k}`)
			}
			assert.ok(presets.structure.some((sec) => sec.id === `sheet-${vp}`), `preset section for ${s.slug}`)
		}
		assert.equal(feedbacks.status_color.affectedProperties.join(), 'color,bgcolor')
	})

	await step('every preset is valid and uses real actions, feedbacks, options and variables', () => {
		const { actions, feedbacks, variables, presets } = inst.rec.defs
		const ids = new Set()
		const optionIds = (def) => new Set(def.options.map((o) => o.id))
		for (const section of presets.structure) {
			for (const group of section.definitions) {
				assert.equal(group.type, 'simple')
				for (const id of group.presets) {
					assert.ok(!ids.has(id), `preset ${id} listed once`)
					ids.add(id)
					const pre = presets.presets[id]
					assert.ok(pre, `preset ${id} exists`)
					assert.equal(pre.type, 'simple')
					for (const key of ['text', 'size', 'color', 'bgcolor']) assert.ok(key in pre.style, `${id} style.${key}`)
					for (const st of pre.steps) {
						for (const a of [...st.down, ...st.up]) {
							assert.ok(actions[a.actionId], `${id}: action ${a.actionId}`)
							for (const k of Object.keys(a.options)) assert.ok(optionIds(actions[a.actionId]).has(k), `${id}: option ${k}`)
						}
					}
					for (const f of pre.feedbacks) {
						const def = feedbacks[f.feedbackId]
						assert.ok(def, `${id}: feedback ${f.feedbackId}`)
						for (const k of Object.keys(f.options)) assert.ok(optionIds(def).has(k), `${id}: feedback option ${k}`)
						if (def.type === 'boolean') assert.ok(f.style, `${id}: boolean feedback ${f.feedbackId} needs a style`)
					}
					// Every $(label:variable) in the text must be a defined variable.
					for (const [, id2] of pre.style.text.matchAll(/\$\(sheetproxy:([^)]+)\)/g)) assert.ok(variables[id2], `${id}: variable ${id2}`)
				}
			}
		}
		assert.equal(ids.size, Object.keys(presets.presets).length, 'every preset is placed in the structure')
	})

	await step('turns auto refresh off and on', async () => {
		await runAction(inst, 'set_refresh', { sheet: slug, mode: 'off' })
		assert.equal(inst.findSheet(slug).refresh, false)
		assert.equal(inst.rec.vars[`${p}_refresh`], 'Off')
		assert.equal(inst.rec.vars[`${p}_status`], 'Paused')
		assert.equal(feedback(inst, 'refresh_on', { sheet: slug }), false)
		assert.equal(feedback(inst, 'status_is', { sheet: slug, status: 'paused' }), true)
		assert.equal(feedback(inst, 'status_color', { sheet: slug }).bgcolor, 0x4b5563)
		await runAction(inst, 'set_refresh', { sheet: slug, mode: 'toggle' })
		assert.equal(inst.findSheet(slug).refresh, true)
		assert.equal(inst.rec.vars[`${p}_refresh`], 'On')
		assert.equal(feedback(inst, 'refresh_on', { sheet: slug }), true)
	})

	await step('toggles all spreadsheets together', async () => {
		await runAction(inst, 'set_refresh', { sheet: ALL, mode: 'on' })
		assert.ok(inst.sheets.every((s) => s.refresh))
		assert.equal(feedback(inst, 'refresh_on', { sheet: ALL }), true)
		await runAction(inst, 'set_refresh', { sheet: ALL, mode: 'toggle' }) // some on -> all off
		assert.ok(inst.sheets.every((s) => !s.refresh))
		assert.equal(inst.rec.vars.status, 'Paused')
		assert.equal(feedback(inst, 'status_is', { sheet: ALL, status: 'paused' }), true)
		await runAction(inst, 'set_refresh', { sheet: ALL, mode: 'toggle' }) // none on -> all on
		assert.ok(inst.sheets.every((s) => s.refresh))
		assert.equal(inst.rec.vars.live_count, inst.sheets.length)
	})

	await step('sets and adjusts the interval, within 1 to 86400 seconds', async () => {
		await runAction(inst, 'set_interval', { sheet: slug, seconds: 30 })
		assert.equal(inst.findSheet(slug).cacheSeconds, 30)
		assert.equal(inst.rec.vars[`${p}_interval`], 30)
		assert.equal(inst.rec.vars[`${p}_interval_text`], '30s')
		assert.equal(feedback(inst, 'interval_is', { sheet: slug, seconds: 30 }), true)
		assert.equal(feedback(inst, 'interval_is', { sheet: slug, seconds: 10 }), false)
		await runAction(inst, 'adjust_interval', { sheet: slug, step: 90 })
		assert.equal(inst.rec.vars[`${p}_interval_text`], '2m')
		await runAction(inst, 'adjust_interval', { sheet: slug, step: -5 })
		assert.equal(inst.findSheet(slug).cacheSeconds, 115)
		assert.equal(inst.rec.vars[`${p}_interval_text`], '1m 55s')
		await runAction(inst, 'adjust_interval', { sheet: slug, step: -1000 })
		assert.equal(inst.findSheet(slug).cacheSeconds, 1)
		await runAction(inst, 'set_interval', { sheet: slug, seconds: 999999 })
		assert.equal(inst.findSheet(slug).cacheSeconds, 86400)
	})

	await step('fetch now, check and clear errors run without errors', async () => {
		const before = inst.rec.logs.length
		await runAction(inst, 'fetch_now', { sheet: slug })
		await runAction(inst, 'check_now', { sheet: ALL })
		await runAction(inst, 'clear_errors', { sheet: slug })
		assert.deepEqual(inst.rec.logs.slice(before), [])
		assert.ok(inst.rec.vars[`${p}_updated`].endsWith('ago'), inst.rec.vars[`${p}_updated`])
		assert.match(inst.rec.vars[`${p}_updated_time`], /^\d\d:\d\d:\d\d$/)
	})

	await step('an unknown spreadsheet is logged, not thrown', async () => {
		await runAction(inst, 'set_refresh', { sheet: 'no-such-sheet', mode: 'on' })
		assert.match(inst.rec.logs.at(-1), /^error: Auto refresh: Spreadsheet "no-such-sheet" was not found/)
	})
} finally {
	// Put the spreadsheets back the way they were.
	for (const o of original) await inst.api.update(o.slug, { refresh: o.refresh, cacheSeconds: o.cacheSeconds })
	await inst.refreshState()
}

await step('settings are restored', () => {
	for (const o of original) {
		const s = inst.findSheet(o.slug)
		assert.equal(s.refresh, o.refresh)
		assert.equal(s.cacheSeconds, o.cacheSeconds)
	}
})

console.log(`\n${passed} checks passed against http://127.0.0.1:${port}`)
