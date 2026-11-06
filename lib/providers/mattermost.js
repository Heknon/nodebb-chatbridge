'use strict';

// Mattermost via a bot account and the REST API v4.
//
//   GET  /api/v4/users/me                    the bot (verify, and its id for DMs)
//   GET  /api/v4/users/username/{username}   find a user (LDAP username)
//   GET  /api/v4/users/email/{email}         find a user (verified email)
//   POST /api/v4/users/search                find a user (display name)
//   POST /api/v4/channels/direct [bot, user] the DM channel (idempotent)
//   POST /api/v4/posts                       the message

const { RetryableError, PermanentError } = require('../errors');
const { escapeMarkdown, markdownToPlain } = require('../message');

const TIMEOUT_MS = 10 * 1000;

const Mattermost = module.exports;

Mattermost.id = 'mattermost';
Mattermost.label = 'Mattermost';
Mattermost.defaultMatch = 'username';
Mattermost.fields = [
	{ key: 'url', label: 'Server URL', type: 'url', required: true, help: 'e.g. https://chat.example.com' },
	{ key: 'token', label: 'Bot access token', type: 'password', required: true, help: 'System Console → Integrations → Bot Accounts' },
];

// Overridable in tests.
Mattermost.fetch = (...args) => fetch(...args);

const botIds = new Map(); // `${url}|${token}` -> bot user id
const dmChannels = new Map(); // `${url}|${token}|${userId}` -> channel id

Mattermost.reset = function () {
	botIds.clear();
	dmChannels.clear();
};

function base(cfg) {
	return String(cfg.url || '').trim().replace(/\/+$/, '');
}

function cacheKey(cfg) {
	return `${base(cfg)}|${cfg.token}`;
}

Mattermost.configured = function (cfg) {
	if (!base(cfg)) return 'Missing: Server URL';
	if (!/^https?:\/\//i.test(base(cfg))) return 'Server URL must start with http:// or https://';
	if (!cfg.token) return 'Missing: Bot access token';
	return '';
};

// Seconds to wait from a 429. Mattermost sends X-Ratelimit-Reset (seconds until
// the window resets); some proxies send Retry-After instead.
function retryAfterMs(res) {
	const h = name => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null);
	const secs = parseFloat(h('retry-after') || h('x-ratelimit-reset'));
	return Number.isFinite(secs) && secs > 0 ? Math.ceil(secs * 1000) : 0;
}

// One API call. Returns parsed JSON, or null for a 404 when allow404 is set.
async function call(cfg, method, path, body, { allow404 = false } = {}) {
	const missing = Mattermost.configured(cfg);
	if (missing) throw new PermanentError(missing);
	let res;
	try {
		res = await Mattermost.fetch(`${base(cfg)}/api/v4${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${cfg.token}`,
				Accept: 'application/json',
				...(body ? { 'Content-Type': 'application/json' } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw new RetryableError(`Mattermost unreachable: ${err.message || err}`);
	}

	if (res.ok) {
		const text = await res.text();
		try { return text ? JSON.parse(text) : {}; } catch (e) { return {}; }
	}
	if (res.status === 404 && allow404) return null;

	let detail = '';
	try { const j = await res.json(); detail = j && (j.message || j.id) ? ` (${j.message || j.id})` : ''; } catch (e) { /* not json */ }
	const what = `Mattermost ${method} ${path.split('?')[0]} → ${res.status}${detail}`;
	if (res.status === 429) throw new RetryableError(what, { retryAfterMs: retryAfterMs(res) });
	if (res.status >= 500 || res.status === 408) throw new RetryableError(what);
	throw new PermanentError(what); // 400 bad payload, 401 bad token, 403 no permission, 404
}

async function botId(cfg) {
	const k = cacheKey(cfg);
	if (!botIds.has(k)) {
		const me = await call(cfg, 'GET', '/users/me');
		if (!me || !me.id) throw new PermanentError('Mattermost did not return the bot user');
		botIds.set(k, me.id);
	}
	return botIds.get(k);
}

Mattermost.verify = async function (cfg) {
	const me = await call(cfg, 'GET', '/users/me');
	if (me && me.id) botIds.set(cacheKey(cfg), me.id);
	return { id: me.id, name: me.username, isBot: !!me.is_bot };
};

function active(u) {
	return u && u.id && !(u.delete_at > 0) ? u.id : null;
}

const nameKey = s => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

// A display name -> the one active person whose full name (first + last) or
// nickname is exactly that, ignoring case and spacing. Names are not unique:
// when two people share it, nobody matches, so no one gets a stranger's DMs.
// Mattermost hides full names from the bot when Show Full Name is off (System
// Console > Users and Teams; PrivacySettings.ShowFullName): then only
// nicknames can match.
async function findByDisplayName(cfg, displayname) {
	const want = nameKey(displayname);
	if (!want) return null;
	const found = await call(cfg, 'POST', '/users/search', { term: want, allow_inactive: false, limit: 100 });
	const ids = new Set((Array.isArray(found) ? found : [])
		.filter(u => active(u) && !u.is_bot)
		.filter(u => nameKey(`${u.first_name || ''} ${u.last_name || ''}`) === want || nameKey(u.nickname) === want)
		.map(u => u.id));
	return ids.size === 1 ? [...ids][0] : null;
}

// strategy: comma-separated, tried in order: 'username', 'email', 'displayname'.
Mattermost.findUser = async function (cfg, { username, email, displayname } = {}, strategy = 'username') {
	for (const how of String(strategy || 'username').split(',').map(s => s.trim())) {
		let id = null;
		if (how === 'username' && username) {
			id = active(await call(cfg, 'GET', `/users/username/${encodeURIComponent(String(username).toLowerCase())}`, null, { allow404: true }));
		} else if (how === 'email' && email) {
			id = active(await call(cfg, 'GET', `/users/email/${encodeURIComponent(String(email).toLowerCase())}`, null, { allow404: true }));
		} else if (how === 'displayname' && displayname) {
			id = await findByDisplayName(cfg, displayname);
		}
		if (id) return id;
	}
	return null;
};

async function dmChannel(cfg, userId) {
	const k = `${cacheKey(cfg)}|${userId}`;
	if (!dmChannels.has(k)) {
		const bot = await botId(cfg);
		const ch = await call(cfg, 'POST', '/channels/direct', [bot, userId]);
		if (!ch || !ch.id) throw new RetryableError('Mattermost did not return a DM channel');
		dmChannels.set(k, ch.id);
	}
	return dmChannels.get(k);
}

// Neutral message (lib/message.js) -> Mattermost post body. Mattermost renders
// pretext, title and text as markdown, so the plain fields are escaped. The
// fallback is the plain-text version used in notifications.
Mattermost.render = function (message, channelId) {
	const m = message || {};
	const attachment = {
		fallback: [markdownToPlain(m.summary), m.url].filter(Boolean).join(' '),
		color: m.color,
		pretext: m.summary,
	};
	if (m.title) {
		attachment.title = escapeMarkdown(m.title);
		if (m.url) attachment.title_link = m.url;
	}
	if (m.excerpt) attachment.text = m.excerpt.split('\n').map(l => `> ${escapeMarkdown(l)}`).join('\n');
	if (!m.title && m.url) attachment.text = [attachment.text, `[Open on the forum](${m.url})`].filter(Boolean).join('\n');
	return {
		channel_id: channelId,
		message: '',
		props: { attachments: [attachment], from_nodebb_chatbridge: m.event || 'notification' },
	};
};

Mattermost.send = async function (cfg, userId, message) {
	const channelId = await dmChannel(cfg, userId);
	try {
		await call(cfg, 'POST', '/posts', Mattermost.render(message, channelId));
	} catch (err) {
		// A cached channel can go stale (channel deleted / server restored).
		if (err instanceof PermanentError && /→ (403|404)/.test(err.message)) {
			dmChannels.delete(`${cacheKey(cfg)}|${userId}`);
		}
		throw err;
	}
};
