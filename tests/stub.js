'use strict';

// A stand-in for the NodeBB modules lib/*.js loads through lib/nbb.js. Require
// this before any lib module. State is exposed so tests can arrange it.

const state = {
	settings: {},
	users: {}, // uid -> { uid, username, email, email:confirmed, userLang }
	topics: {}, // tid -> { title, readers?: [uid] }  (no readers = everyone can read)
	posts: {}, // pid -> { tid, content }
	hashes: new Map(),
	zsets: new Map(),
	lists: new Map(),
	logs: [],
};

const z = k => { if (!state.zsets.has(k)) state.zsets.set(k, new Map()); return state.zsets.get(k); };
const l = k => { if (!state.lists.has(k)) state.lists.set(k, []); return state.lists.get(k); };

const db = {
	async getObject(k) { return state.hashes.has(k) ? { ...state.hashes.get(k) } : null; },
	async setObject(k, o) { state.hashes.set(k, { ...(state.hashes.get(k) || {}), ...o }); },
	async delete(k) { state.hashes.delete(k); state.zsets.delete(k); state.lists.delete(k); },
	async sortedSetAdd(k, score, m) { z(k).set(String(m), score); },
	async sortedSetRemove(k, m) { z(k).delete(String(m)); },
	async sortedSetCard(k) { return z(k).size; },
	async getSortedSetRangeByScore(k, start, count, min, max) {
		const lo = min === '-inf' ? -Infinity : min;
		const hi = max === '+inf' ? Infinity : max;
		return [...z(k).entries()].filter(([, s]) => s >= lo && s <= hi)
			.sort((a, b) => a[1] - b[1]).map(e => e[0]).slice(start, count < 0 ? undefined : start + count);
	},
	async listPrepend(k, v) { l(k).unshift(v); },
	async listTrim(k, start, stop) { state.lists.set(k, l(k).slice(start, stop + 1)); },
	async getListRange(k, start, stop) { return l(k).slice(start, stop === -1 ? undefined : stop + 1); },
};

const winston = {
	error: m => state.logs.push(['error', m]),
	warn: m => state.logs.push(['warn', m]),
	verbose: () => {},
	info: () => {},
};

const modules = {
	'./src/database': db,
	winston,
	nconf: { get: k => ({ url: 'https://forum.example.com', runJobs: false })[k] },
	'./src/meta': {
		config: { defaultLang: 'en-GB' },
		settings: {
			async get() { return { ...state.settings }; },
			async setOnEmpty(hash, values) {
				Object.keys(values).forEach((k) => { if (!(k in state.settings)) state.settings[k] = values[k]; });
			},
		},
	},
	'./src/user': {
		async getUserFields(uid) { return state.users[uid] ? { ...state.users[uid] } : { uid: 0 }; },
		async getSettings(uid) { return { userLang: (state.users[uid] && state.users[uid].userLang) || 'en-GB' }; },
		async isAdministrator(uid) { return !!(state.users[uid] && state.users[uid].admin); },
	},
	'./src/topics': {
		async getTopicField(tid, f) { return state.topics[tid] ? state.topics[tid][f] : null; },
	},
	'./src/posts': {
		async getPostField(pid, f) { return state.posts[pid] ? state.posts[pid][f] : null; },
	},
	'./src/privileges': {
		topics: {
			async can(priv, tid, uid) {
				const t = state.topics[tid];
				if (!t) return false;
				return !t.readers || t.readers.includes(uid);
			},
		},
	},
	// Enough of NodeBB's translator for the keys these tests use.
	'./src/translator': {
		async translate(text, lang) {
			return String(text)
				.replace(/\[\[notifications:user-posted-to, ([^,]+), (.+?)\]\]/, '<strong>$1</strong> has posted a reply to: <strong>$2</strong>')
				.replace(/\[\[shotef:notif-status-answered\]\]/, lang === 'he' ? 'צוות התמיכה ענה' : 'Support replied and is waiting for your response — tap to reply')
				.replace(/\[\[shotef:notif-status-in_progress\]\]/, 'Someone is now working on your request');
		},
	},
	'./src/controllers/helpers': {
		formatApiResponse(status, res, payload) { res.status = status; res.payload = payload; },
	},
	'./src/routes/helpers': {},
	'./src/plugins': { hooks: { async fire(name, data) { return data; } } },
};

global.nodebb = {
	require(p) {
		if (!(p in modules)) throw new Error(`stub: unexpected nbb('${p}')`);
		return modules[p];
	},
};

state.reset = function () {
	state.settings = {};
	state.users = {};
	state.topics = {};
	state.posts = {};
	state.hashes.clear();
	state.zsets.clear();
	state.lists.clear();
	state.logs.length = 0;
};

module.exports = { state, modules };
