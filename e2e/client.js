'use strict';

// Tiny clients for the E2E run: a NodeBB session (cookie + CSRF) and the
// Mattermost REST API (to read what the bot actually posted).

const fs = require('fs');
const path = require('path');

const NBB = process.env.NBB || 'http://localhost:4567';
const MM = process.env.MM || 'http://localhost:8065';
const WORK = path.join(__dirname, '.work');
const env = Object.fromEntries(fs.readFileSync(path.join(WORK, 'mm.env'), 'utf8')
	.trim().split('\n').map(l => l.split('=')));

class Session {
	constructor() { this.cookies = {}; this.csrf = ''; this.uid = 0; }

	cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }

	keep(res) {
		const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
		set.forEach((c) => { const [kv] = c.split(';'); const i = kv.indexOf('='); this.cookies[kv.slice(0, i)] = kv.slice(i + 1); });
	}

	async raw(method, url, { body, form, headers = {} } = {}) {
		const h = { cookie: this.cookieHeader(), 'x-csrf-token': this.csrf, accept: 'application/json', ...headers };
		let payload;
		if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
		else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
		const res = await fetch(NBB + url, { method, headers: h, body: payload, redirect: 'manual' });
		this.keep(res);
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch (e) { /* html */ }
		return { status: res.status, json, text };
	}

	async refreshCsrf() {
		const r = await this.raw('GET', '/api/config');
		this.csrf = r.json.csrf_token;
		this.uid = r.json.uid || 0;
		return r.json;
	}

	async login(username, password) {
		await this.refreshCsrf();
		const r = await this.raw('POST', '/login', { form: { username, password, _csrf: this.csrf } });
		if (r.status >= 400) throw new Error(`login ${username}: ${r.status} ${r.text.slice(0, 200)}`);
		await this.refreshCsrf();
		const me = await this.raw('GET', '/api/self');
		this.uid = me.json && me.json.uid;
		if (!this.uid) throw new Error(`login ${username} failed`);
		return this;
	}

	// /api/v3 write API; returns { status, response, statusObj }
	async v3(method, url, body) {
		const r = await this.raw(method, `/api/v3${url}`, { body });
		return { status: r.status, response: r.json && r.json.response, statusObj: r.json && r.json.status, text: r.text };
	}
}

async function mm(method, url, body, token = env.BOT_TOKEN, tries = 20) {
	const res = await fetch(`${MM}/api/v4${url}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	if (res.status === 429 && tries > 1) {
		await new Promise(r => setTimeout(r, 1100));
		return mm(method, url, body, token, tries - 1);
	}
	let json = null;
	try { json = JSON.parse(text); } catch (e) { /* */ }
	return { status: res.status, json };
}

const mmIds = {};
async function mmUserId(username) {
	if (!mmIds[username]) mmIds[username] = (await mm('GET', `/users/username/${username}`, undefined, env.ADMIN_TOKEN)).json.id;
	return mmIds[username];
}

// Posts the bot (or `from`, e.g. the webhook's owner) has sent to a Mattermost user, oldest first.
async function dms(username, from = env.BOT_ID) {
	const uid = await mmUserId(username);
	const ch = await mm('POST', '/channels/direct', [from, uid], env.ADMIN_TOKEN);
	const posts = await mm('GET', `/channels/${ch.json.id}/posts?per_page=200`, undefined, env.ADMIN_TOKEN);
	const p = posts.json;
	return (p.order || []).map(id => p.posts[id]).filter(x => x.user_id === from && (from !== env.ADMIN_ID || (x.props || {}).from_webhook === 'true')).sort((a, b) => a.create_at - b.create_at);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, every = 300, what = 'condition' } = {}) {
	const end = Date.now() + timeout;
	let last;
	while (Date.now() < end) {
		// eslint-disable-next-line no-await-in-loop
		last = await fn();
		if (last) return last;
		// eslint-disable-next-line no-await-in-loop
		await sleep(every);
	}
	throw new Error(`timed out waiting for ${what}`);
}

module.exports = { Session, mm, mmUserId, dms, sleep, waitFor, env, NBB, MM, WORK };
