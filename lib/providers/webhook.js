'use strict';

// A generic incoming webhook: one POST per message, with headers and a JSON
// body the admin writes. No token, no user lookup. The default body is a
// Mattermost incoming webhook DM:
//
//   POST <url>
//   Content-Type: application/json
//   { "channel": "@{{username}}", "text": "{{text}}" }
//
// The body is a JSON template. Placeholders ({{name}}) are replaced inside its
// string values only, after parsing, so whatever the forum text contains
// (quotes, newlines, braces) can't break the JSON:
//
//   {{username}}  the forum username (the chat username with LDAP sign-in)
//   {{text}}      the whole message as markdown: summary, link, excerpt
//   {{summary}}   the one-line summary, markdown
//   {{plain}}     the summary as plain text, then the link
//   {{title}} {{url}} {{excerpt}} {{event}} {{stage}} {{color}}

const { RetryableError, PermanentError } = require('../errors');
const { escapeMarkdown, markdownToPlain } = require('../message');

const TIMEOUT_MS = 10 * 1000;

const Webhook = module.exports;

Webhook.DEFAULT_HEADERS = 'Content-Type: application/json';
Webhook.DEFAULT_BODY = '{"channel": "@{{username}}", "text": "{{text}}"}';

Webhook.id = 'webhook';
Webhook.label = 'Webhook';
Webhook.defaultMatch = 'username';
// The webhook takes the username as it stands: there is nothing to look up.
Webhook.lookup = false;
Webhook.fields = [
	{
		key: 'url',
		label: 'Webhook URL',
		type: 'url',
		required: true,
		help: 'e.g. https://chat.example.com/hooks/xxxxxxxx (Mattermost: Integrations → Incoming Webhooks; leave "Lock to this channel" off)',
	},
	{
		key: 'headers',
		label: 'Headers',
		type: 'textarea',
		default: Webhook.DEFAULT_HEADERS,
		help: 'One per line, "Name: value". A JSON object works too.',
	},
	{
		key: 'body',
		label: 'Body (JSON template)',
		type: 'textarea',
		default: Webhook.DEFAULT_BODY,
		help: 'Placeholders: {{username}}, {{text}} (markdown), {{summary}}, {{plain}}, {{title}}, {{url}}, {{excerpt}}, {{event}}, {{stage}}, {{color}}.',
	},
];

// Overridable in tests.
Webhook.fetch = (...args) => fetch(...args);

Webhook.reset = function () {};

function url(cfg) {
	return String(cfg.url || '').trim();
}

// "Name: value" lines, or a JSON object -> { name: value }. Throws on bad input.
Webhook.parseHeaders = function (raw) {
	const s = String(raw === undefined || raw === null ? Webhook.DEFAULT_HEADERS : raw).trim();
	if (!s) return {};
	if (s.startsWith('{')) {
		let obj;
		try { obj = JSON.parse(s); } catch (e) { throw new Error(`Headers are not valid JSON: ${e.message}`); }
		if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Headers must be a JSON object');
		const out = {};
		Object.entries(obj).forEach(([k, v]) => { out[String(k).trim()] = String(v); });
		return out;
	}
	const out = {};
	s.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach((line) => {
		const i = line.indexOf(':');
		if (i <= 0) throw new Error(`Header line "${line}" is not "Name: value"`);
		out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	});
	return out;
};

Webhook.parseBody = function (raw) {
	const s = String(raw || Webhook.DEFAULT_BODY).trim();
	try {
		return JSON.parse(s);
	} catch (e) {
		throw new Error(`Body is not valid JSON: ${e.message}`);
	}
};

Webhook.configured = function (cfg) {
	if (!url(cfg)) return 'Missing: Webhook URL';
	if (!/^https?:\/\//i.test(url(cfg))) return 'Webhook URL must start with http:// or https://';
	try {
		Webhook.parseHeaders(cfg.headers);
		Webhook.parseBody(cfg.body);
	} catch (e) {
		return e.message;
	}
	return '';
};

// The neutral message (lib/message.js) as one markdown text. The summary is
// already escaped markdown; the title and excerpt are plain forum text.
Webhook.text = function (message) {
	const m = message || {};
	const lines = [m.summary || 'New notification'];
	if (m.url) lines.push(m.title ? `[${escapeMarkdown(m.title)}](${m.url})` : `[Open on the forum](${m.url})`);
	if (m.excerpt) lines.push(m.excerpt.split('\n').map(l => `> ${escapeMarkdown(l)}`).join('\n'));
	return lines.join('\n');
};

Webhook.values = function (username, message) {
	const m = message || {};
	return {
		username: String(username || ''),
		text: Webhook.text(m),
		summary: m.summary || '',
		plain: [markdownToPlain(m.summary), m.url].filter(Boolean).join(' '),
		title: m.title || '',
		url: m.url || '',
		excerpt: m.excerpt || '',
		event: m.event || '',
		stage: m.stage || '',
		color: m.color || '',
	};
};

const PLACEHOLDER = /\{\{\s*([a-z]+)\s*\}\}/gi;

// Replace placeholders in every string (keys too) of the parsed template.
Webhook.fill = function (template, values) {
	const sub = s => s.replace(PLACEHOLDER, (all, name) => {
		const k = name.toLowerCase();
		return Object.prototype.hasOwnProperty.call(values, k) ? values[k] : all;
	});
	const walk = (v) => {
		if (typeof v === 'string') return sub(v);
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === 'object') {
			const out = {};
			Object.entries(v).forEach(([k, x]) => { out[sub(k)] = walk(x); });
			return out;
		}
		return v;
	};
	return walk(template);
};

Webhook.render = function (cfg, username, message) {
	return Webhook.fill(Webhook.parseBody(cfg.body), Webhook.values(username, message));
};

function retryAfterMs(res) {
	const h = name => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null);
	const secs = parseFloat(h('retry-after') || h('x-ratelimit-reset'));
	return Number.isFinite(secs) && secs > 0 ? Math.ceil(secs * 1000) : 0;
}

async function post(cfg, body) {
	const missing = Webhook.configured(cfg);
	if (missing) throw new PermanentError(missing);
	const headers = Webhook.parseHeaders(cfg.headers);
	if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
	let res;
	try {
		res = await Webhook.fetch(url(cfg), {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw new RetryableError(`Webhook unreachable: ${err.message || err}`);
	}
	if (res.ok) return;

	let detail = '';
	try {
		const text = (await res.text()).trim();
		let j = null;
		try { j = JSON.parse(text); } catch (e) { /* not json */ }
		detail = (j && (j.message || j.id)) || text;
		detail = detail ? ` (${String(detail).slice(0, 200)})` : '';
	} catch (e) { /* no body */ }
	const what = `Webhook POST → ${res.status}${detail}`;
	if (res.status === 429) throw new RetryableError(what, { retryAfterMs: retryAfterMs(res) });
	if (res.status >= 500 || res.status === 408) throw new RetryableError(what);
	throw new PermanentError(what); // 400 bad payload / unknown user, 401/403, 404 webhook gone
}

// Nothing to call without sending a message: check the settings only.
Webhook.verify = async function (cfg) {
	const missing = Webhook.configured(cfg);
	if (missing) throw new PermanentError(missing);
	let host = url(cfg);
	try { host = new URL(host).host; } catch (e) { /* configured() checked the scheme */ }
	return { name: host, message: `Settings look valid. Messages go to ${host}. Use "Send me a test message" to try it.` };
};

// The chat user is the forum username, lowercased like Mattermost usernames.
Webhook.findUser = async function (cfg, { username } = {}) {
	const u = String(username || '').trim().toLowerCase();
	return u || null;
};

Webhook.send = async function (cfg, username, message) {
	await post(cfg, Webhook.render(cfg, username, message));
};
