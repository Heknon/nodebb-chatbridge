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
// Who it is for (the recipient on the forum):
//   {{username}}      forum username, lowercased (the chat username with LDAP sign-in)
//   {{uid}} {{userslug}} {{fullname}}
//   {{email}}         confirmed email only
//   {{displayname}}   full name, only when no other forum user has it
//   {{user.<field>}}  any field of the NodeBB user record, e.g. a custom
//                     profile field ({{user.mattermost}}); never passwords/tokens
// What it says:
//   {{text}}      the whole message as markdown: summary, link, excerpt
//   {{summary}}   the one-line summary, markdown
//   {{plain}}     the summary as plain text, then the link
//   {{title}} {{url}} {{excerpt}} {{event}} {{stage}} {{color}}
// Filters, chained: {{email|localpart}} (before the @), |domain, |lower, |upper, |trim.
//
// A recipient for whom a recipient placeholder the template uses is empty
// (no confirmed email, an unset profile field, ...) is unmatched: nothing is sent.

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
		help: 'Type {{ for a list of placeholders, or click one below. Users missing a recipient value the body uses get nothing.',
		placeholders: true,
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
	return Webhook.checkPlaceholders(cfg.body);
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

Webhook.MESSAGE_KEYS = ['text', 'summary', 'plain', 'title', 'url', 'excerpt', 'event', 'stage', 'color'];
Webhook.USER_KEYS = ['username', 'uid', 'userslug', 'email', 'fullname', 'displayname'];

Webhook.FILTERS = {
	lower: v => v.toLowerCase(),
	upper: v => v.toUpperCase(),
	trim: v => v.trim(),
	localpart: v => (v.includes('@') ? v.slice(0, v.lastIndexOf('@')) : v),
	domain: v => (v.includes('@') ? v.slice(v.lastIndexOf('@') + 1) : ''),
};

// {{ name | filter | filter }}; name is a key above or user.<field>.
const PLACEHOLDER = /\{\{\s*([a-z_][\w.:-]*)\s*((?:\|\s*[a-z]+\s*)*)\}\}/gi;

const parseFilters = f => (f || '').split('|').map(x => x.trim().toLowerCase()).filter(Boolean);

// Every placeholder in the template: [{ name, filters }].
Webhook.placeholders = function (body) {
	const raw = String(body || Webhook.DEFAULT_BODY);
	return [...raw.matchAll(PLACEHOLDER)].map(m => ({ name: m[1], filters: parseFilters(m[2]) }));
};

// Same rule as Identity.SECRET_FIELD, which is what actually withholds them.
Webhook.SECRET_FIELD = /pass|token|secret|salt/i;

const isUserField = name => /^user\.[\w:-]+$/i.test(name);
const isRecipient = name => Webhook.USER_KEYS.includes(name.toLowerCase()) || isUserField(name);

// Problems with the template's placeholders, as a message, or ''.
Webhook.checkPlaceholders = function (body) {
	for (const { name, filters } of Webhook.placeholders(body)) {
		const known = isUserField(name) || [...Webhook.USER_KEYS, ...Webhook.MESSAGE_KEYS].includes(name.toLowerCase());
		if (!known) return `Unknown placeholder {{${name}}}`;
		if (isUserField(name) && Webhook.SECRET_FIELD.test(name.slice(5))) return `{{${name}}} is not allowed (passwords and tokens are never sent)`;
		const bad = filters.find(f => !Webhook.FILTERS[f]);
		if (bad) return `Unknown filter "|${bad}" in {{${name}}}`;
	}
	return '';
};

// What Identity should fetch for this template (provider.userFields).
Webhook.userFields = function (cfg) {
	const names = Webhook.placeholders(cfg && cfg.body).map(p => p.name);
	return {
		displayname: names.some(n => n.toLowerCase() === 'displayname'),
		fields: [...new Set(names.filter(isUserField).map(n => n.slice(5)))],
	};
};

// The recipient: from Identity.forumUser, or a bare username (older queued jobs).
function recipient(who) {
	if (typeof who === 'string') return { username: who, fields: {} };
	return { fields: {}, ...(who || {}) };
}

function lookup(values, who, name) {
	if (isUserField(name)) {
		const v = who.fields[name.slice(5)];
		return v === undefined || v === null ? '' : String(v);
	}
	const k = name.toLowerCase();
	if (Webhook.USER_KEYS.includes(k)) return who[k] === undefined || who[k] === null ? '' : String(who[k]);
	return Object.prototype.hasOwnProperty.call(values, k) ? values[k] : undefined;
}

function resolve(values, who, name, filters) {
	const v = lookup(values, who, name);
	if (v === undefined) return undefined;
	return filters.reduce((acc, f) => (Webhook.FILTERS[f] ? Webhook.FILTERS[f](acc) : acc), v);
}

Webhook.values = function (message) {
	const m = message || {};
	return {
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

// Replace placeholders in every string (keys too) of the parsed template.
// Unknown ones are left as they are.
Webhook.fill = function (template, values, who = {}) {
	const person = recipient(who);
	const sub = s => s.replace(PLACEHOLDER, (all, name, f) => {
		const v = resolve(values, person, name, parseFilters(f));
		return v === undefined ? all : v;
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

Webhook.render = function (cfg, who, message) {
	return Webhook.fill(Webhook.parseBody(cfg.body), Webhook.values(message), who);
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

// Recipient placeholders the template uses that are empty for this user.
function missing(cfg, who) {
	return Webhook.placeholders(cfg && cfg.body)
		.filter(p => isRecipient(p.name))
		.filter(p => !String(resolve({}, who, p.name, p.filters) || '').trim())
		.map(p => `{{${p.name}}}`);
}

function person(fu = {}) {
	return {
		uid: fu.uid ? String(fu.uid) : '',
		username: String(fu.username || '').trim().toLowerCase(),
		userslug: fu.userslug || '',
		email: fu.email || '',
		fullname: fu.fullname || '',
		displayname: fu.displayname || '',
		fields: { ...(fu.fields || {}) },
	};
}

// No lookup: the recipient is the forum user's own fields. Unmatched (null)
// when a recipient placeholder the template uses comes out empty, so a user
// without, say, a confirmed email isn't sent to "@".
Webhook.findUser = async function (cfg, fu = {}) {
	const who = person(fu);
	if (!who.username && !who.uid) return null;
	return missing(cfg, who).length ? null : who;
};

// For the ACP test message: why this forum user is unmatched.
Webhook.explainUnmatched = function (cfg, fu) {
	const empty = [...new Set(missing(cfg, person(fu)))];
	return empty.length ? `Your forum account has no value for ${empty.join(', ')}, which the webhook body uses.` : '';
};

// What the ACP shows and autocompletes in the body field.
Webhook.templateHelp = function () {
	return {
		placeholders: [
			{ name: 'username', group: 'Recipient', help: 'Forum username, lowercased' },
			{ name: 'uid', group: 'Recipient', help: 'Forum user id' },
			{ name: 'userslug', group: 'Recipient', help: 'Forum URL slug' },
			{ name: 'email', group: 'Recipient', help: 'Verified email (unverified: no message)' },
			{ name: 'fullname', group: 'Recipient', help: 'Full name' },
			{ name: 'displayname', group: 'Recipient', help: 'Full name, if no other forum user has it' },
			{ name: 'text', group: 'Message', help: 'Whole message as markdown: summary, link, quoted excerpt' },
			{ name: 'summary', group: 'Message', help: 'One-line summary, markdown' },
			{ name: 'plain', group: 'Message', help: 'Summary as plain text, then the link' },
			{ name: 'title', group: 'Message', help: 'Topic title' },
			{ name: 'url', group: 'Message', help: 'Link to the post or topic' },
			{ name: 'excerpt', group: 'Message', help: 'Reply excerpt, plain text (may be empty)' },
			{ name: 'event', group: 'Message', help: 'reply, mention, topic, ticket_status, ticket_team, other' },
			{ name: 'stage', group: 'Message', help: 'Shotef ticket stage (may be empty)' },
			{ name: 'color', group: 'Message', help: 'Hex accent colour' },
		],
		filters: [
			{ name: 'localpart', help: 'Before the @: {{email|localpart}}' },
			{ name: 'domain', help: 'After the @' },
			{ name: 'lower', help: 'Lowercase' },
			{ name: 'upper', help: 'Uppercase' },
			{ name: 'trim', help: 'Strip spaces' },
		],
		// The ACP adds the forum's custom profile fields as user.<key>.
		userFields: true,
	};
};

// What would be sent for this forum user (ACP preview). No request is made.
Webhook.preview = function (cfg, fu, message) {
	const problem = Webhook.configured(cfg);
	if (problem) return { error: problem };
	const who = person(fu);
	const headers = Webhook.parseHeaders(cfg.headers);
	if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
	return {
		headers,
		body: Webhook.render(cfg, who, message),
		missing: [...new Set(missing(cfg, who))],
	};
};

Webhook.send = async function (cfg, who, message) {
	await post(cfg, Webhook.render(cfg, who, message));
};
