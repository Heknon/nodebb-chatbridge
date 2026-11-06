'use strict';

const nbb = require('./nbb');

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

Controllers.renderAdmin = async function (req, res) {
	res.render('admin/plugins/chatbridge', {
		title: 'Chat Bridge',
		events: Events.CATALOG.map(e => ({ name: `event_${e.key}`, label: e.label })),
		providers: Providers.list().map(p => ({
			id: p.id,
			label: p.label,
			enabledName: `${p.id}_enabled`,
			matchName: `${p.id}_match`,
			matchOptions: MATCH_OPTIONS.map(o => ({ ...o, selected: o.value === (p.defaultMatch || 'username') })),
			fields: (p.fields || []).map(f => ({
				name: `${p.id}_${f.key}`,
				label: f.label,
				type: f.type === 'password' ? 'password' : (f.type === 'url' ? 'url' : 'text'),
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
		reply(res, { ok: true, name: who.name, isBot: who.isBot });
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
			const byName = /\bdisplayname\b/.test(cfg.match);
			const fu = await Identity.forumUser(req.uid, { withDisplayName: byName });
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

Controllers.log = async function (req, res) {
	await adminOnly(req);
	const [entries, pending] = await Promise.all([Outbox.recent(50), Outbox.pending()]);
	reply(res, { entries, pending });
};
