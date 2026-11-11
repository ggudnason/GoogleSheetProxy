// A small client for Google Sheet Proxy's admin API (the same API its web interface uses).

export class ProxyApi {
	/**
	 * @param {{ host: string, port: number, https?: boolean }} config
	 * @param {string} [password] The proxy's ADMIN_PASSWORD, if it has one.
	 */
	constructor(config, password) {
		const host = String(config.host || '').trim() || '127.0.0.1'
		const port = Number(config.port) || 3000
		const scheme = config.https ? 'https' : 'http'
		// Wrap IPv6 addresses in brackets.
		this.base = `${scheme}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
		this.auth = password ? `Basic ${Buffer.from(`companion:${password}`).toString('base64')}` : null
	}

	async request(method, path, body, timeoutMs = 5000) {
		const headers = { Accept: 'application/json' }
		if (this.auth) headers.Authorization = this.auth
		if (body !== undefined) headers['Content-Type'] = 'application/json'
		let res
		try {
			res = await fetch(this.base + path, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			})
		} catch (err) {
			const reason = err?.name === 'TimeoutError' ? 'did not answer in time' : err?.cause?.code || err?.message || 'unreachable'
			throw Object.assign(new Error(`Can't reach the proxy at ${this.base} (${reason})`), { offline: true })
		}
		if (res.status === 401) {
			throw Object.assign(new Error('The proxy asked for a password. Enter its admin password in the connection settings.'), { auth: true })
		}
		const text = await res.text()
		let data = null
		try {
			data = text ? JSON.parse(text) : null
		} catch {
			// not JSON
		}
		if (!res.ok) throw new Error(data?.error || `The proxy answered ${res.status}`)
		return data
	}

	/** Every spreadsheet with its settings and health. */
	state() {
		return this.request('GET', '/api/state', undefined, 4000)
	}

	/** Change settings of one spreadsheet, e.g. { refresh: true } or { cacheSeconds: 30 }. */
	update(slug, fields) {
		return this.request('PUT', `/api/sheets/${encodeURIComponent(slug)}`, fields)
	}

	/** Fetch every sheet from Google now (the interface's "Fetch latest once"). */
	reload(slug) {
		return this.request('POST', `/api/sheets/${encodeURIComponent(slug)}/reload`, undefined, 30000)
	}

	/** Try Google now (the interface's Check button). */
	check(slug) {
		return this.request('POST', `/api/sheets/${encodeURIComponent(slug)}/check`, undefined, 30000)
	}

	/** Forget the error history and try again straight away if failing (the Clear button). */
	clearErrors(slug) {
		return this.request('POST', `/api/sheets/${encodeURIComponent(slug)}/clear-errors`)
	}
}
