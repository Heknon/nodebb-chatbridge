'use strict';

const nbb = require('./nbb');

const db = nbb('./src/database');
const user = nbb('./src/user');
const apiHelpers = nbb('./src/controllers/helpers');

const Events = require('./events');
const Message = require('./message');
const Settings = require('./settings');
const Providers = require('./providers');
const Identity = require('./identity');
const Outbox = require('./outbox');

const Controllers = module.exports;

const MATCH_OPTIONS = [
	{ value: 'username', label: 'Username (LDAP)' },
	{ value: 'email', label: 'Verified email' },
	{ value: 'username,email', label: 'Username, then verified email' },
	{ value: 'username,displayname', label: 'Username, then display name' },
	{ value: 'username,email,displayname', label: 'Username, then verified email, then display name' },
];

// NodeBB 4's custom profile fields (ACP > Manage > Custom fields), as
// { key, name }. NodeBB 3 has none.
Controllers.customUserFields = async function () {
	try {
		const keys = (await db.getSortedSetRange('user-custom-fields', 0, -1)) || [];
		if (!keys.length) return [];
		const fields = (await db.getObjects(keys.map(k => `user-custom-field:${k}`))) || [];
		return keys.map((k, i) => ({ key: k, name: (fields[i] && fields[i].name) || k }));
	} catch (e) {
		return [];
	}
};

// A few fields every NodeBB user record has, offered as user.<key> too.
const BUILTIN_USER_FIELDS = [
	{ key: 'location', name: 'Location' },
	{ key: 'website', name: 'Website' },
	{ key: 'groupTitle', name: 'Group title' },
];

// The provider's placeholder list for the ACP, with user.<key> entries added.
Controllers.templateHelp = async function (provider) {
	if (typeof provider.templateHelp !== 'function') return null;
	const help = provider.templateHelp();
	const placeholders = [...help.placeholders];
	if (help.userFields) {
		const custom = await Controllers.customUserFields();
		custom.forEach(f => placeholders.push({ name: `user.${f.key}`, group: 'Profile field', help: `Custom field "${f.name}"` }));
		BUILTIN_USER_FIELDS.filter(f => !custom.some(c => c.key === f.key))
			.forEach(f => placeholders.push({ name: `user.${f.key}`, group: 'Profile field', help: f.name }));
	}
	return { placeholders, filters: help.filters || [] };
};

Controllers.renderAdmin = async function (req, res) {
	const help = {};
	await Promise.all(Providers.list().map(async (p) => { help[p.id] = await Controllers.templateHelp(p); }));
	res.render('admin/plugins/chatbridge', {
		templateHelp: help,
		title: 'Chat Bridge',
		events: Events.CATALOG.map(e => ({ name: `event_${e.key}`, label: e.label })),
		providers: Providers.list().map(p => ({
			id: p.id,
			label: p.label,
			enabledName: `${p.id}_enabled`,
			matchName: `${p.id}_match`,
			lookup: p.lookup !== false,
			matchOptions: MATCH_OPTIONS.map(o => ({ ...o, selected: o.value === (p.defaultMatch || 'username') })),
			fields: (p.fields || []).map(f => ({
				name: `${p.id}_${f.key}`,
				label: f.label,
				type: ['password', 'url'].includes(f.type) ? f.type : 'text',
				textarea: f.type === 'textarea',
				placeholders: !!f.placeholders,
				provider: p.id,
				help: f.help || '',
				placeholder: f.default || '',
			})),
		})),
	});
};

async function adminOnly(req) {
	if (!req.uid || !(await user.isAdministrator(req.uid))) {
		const err = new Error('[[error:no-privileges]]');
		err.status = 403;
		throw err;
	}
}

function providerFrom(req) {
	const p = Providers.get(String(req.params.provider || ''));
	if (!p) {
		const err = new Error('[[error:invalid-data]]');
		err.status = 404;
		throw err;
	}
	return p;
}

// Admin tools answer 200 with { ok, ... } so the ACP can show the provider's
// own error text (a NodeBB error envelope would replace it with a generic one).
function reply(res, payload) {
	apiHelpers.formatApiResponse(200, res, payload);
}

Controllers.verify = async function (req, res) {
	await adminOnly(req);
	const provider = providerFrom(req);
	const cfg = Settings.providerConfig(await Settings.get(), provider);
	const missing = Providers.missingConfig(provider, cfg);
	if (missing) return reply(res, { ok: false, error: `${missing}. Save the settings first.` });
	try {
		const who = await provider.verify(cfg);
		reply(res, { ok: true, name: who.name, isBot: who.isBot, ...(who.message ? { message: who.message } : {}) });
	} catch (err) {
		reply(res, { ok: false, error: err.message });
	}
};

// Sends a message to the admin who clicked, matched like everyone else.
Controllers.testMessage = async function (req, res) {
	await adminOnly(req);
	const provider = providerFrom(req);
	const settings = await Settings.get();
	const cfg = Settings.providerConfig(settings, provider);
	const missing = Providers.missingConfig(provider, cfg);
	if (missing) return reply(res, { ok: false, error: `${missing}. Save the settings first.` });
	try {
		Identity.forget(provider.id, req.uid);
		const externalId = await Identity.resolve(provider, cfg, req.uid);
		if (!externalId) {
			const want = (typeof provider.userFields === 'function' && provider.userFields(cfg)) || {};
			const byName = /\bdisplayname\b/.test(cfg.match);
			const fu = await Identity.forumUser(req.uid, { withDisplayName: byName || !!want.displayname, fields: want.fields || [] });
			const why = typeof provider.explainUnmatched === 'function' ? provider.explainUnmatched(cfg, fu || {}) : '';
			if (why) return reply(res, { ok: false, error: why });
			const name = byName ? `, display name "${(fu && fu.displayname) || '(none, or not unique on the forum)'}"` : '';
			return reply(res, {
				ok: false,
				error: `No ${provider.label} user matches your forum account (username "${fu && fu.username}"${name}, match: ${cfg.match}).`,
			});
		}
		await provider.send(cfg, externalId, Message.compose({
			event: 'other',
			bodyHtml: 'Test message from the forum\'s <strong>Chat Bridge</strong>. Notifications will arrive here.',
			title: '',
			baseUrl: Settings.baseUrl(settings),
			path: '/',
		}));
		reply(res, { ok: true });
	} catch (err) {
		reply(res, { ok: false, error: err.message });
	}
};

// The ACP form's current (maybe unsaved) values, over the saved settings.
function formSettings(saved, provider, body) {
	const values = (body && body.values) || {};
	const merged = { ...saved };
	Object.keys(values).forEach((k) => {
		if (k.startsWith(`${provider.id}_`) && typeof values[k] === 'string') merged[k] = values[k];
	});
	return merged;
}

// What the provider would send to the admin who asks, for a sample reply.
Controllers.preview = async function (req, res) {
	await adminOnly(req);
	const provider = providerFrom(req);
	if (typeof provider.preview !== 'function') return reply(res, { ok: false, error: 'This provider has no preview.' });
	const saved = await Settings.get();
	const cfg = Settings.providerConfig(formSettings(saved, provider, req.body), provider);
	const want = (typeof provider.userFields === 'function' && provider.userFields(cfg)) || {};
	const fu = await Identity.forumUser(req.uid, { withDisplayName: !!want.displayname, fields: want.fields || [] });
	const baseUrl = Settings.baseUrl(saved);
	const message = Message.compose({
		event: 'reply',
		bodyHtml: '<strong>Bob</strong> posted a reply in <strong>Printer on fire</strong>',
		title: 'Printer on fire',
		baseUrl,
		path: '/post/123',
		content: 'Have you tried turning it off and on again?',
		excerptLength: Settings.excerptLength(saved),
	});
	try {
		const r = provider.preview(cfg, fu || {}, message);
		if (r.error) return reply(res, { ok: false, error: r.error });
		reply(res, { ok: true, headers: r.headers, body: r.body, missing: r.missing || [] });
	} catch (err) {
		reply(res, { ok: false, error: err.message });
	}
};

Controllers.log = async function (req, res) {
	await adminOnly(req);
	const [entries, pending] = await Promise.all([Outbox.recent(50), Outbox.pending()]);
	reply(res, { entries, pending });
};
