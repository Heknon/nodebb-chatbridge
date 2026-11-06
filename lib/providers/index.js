'use strict';

// Chat provider registry.
//
// A provider is a plain object:
//
//   id            'mattermost'                      settings prefix, job field
//   label         'Mattermost'
//   fields        [{ key, label, type: 'text'|'password'|'url', help?, default?, required? }]
//   defaultMatch  'username'                        how forum users are found by default
//   configured(cfg)                 -> missing-field message, or ''
//   verify(cfg)                     -> { name }     check the credentials (ACP "Test connection")
//   findUser(cfg, { username, email }, strategy) -> external user id | null
//   send(cfg, externalId, message)  -> void          throws RetryableError / PermanentError (lib/errors.js)
//   reset()                         drop caches after a settings change
//
// `message` is the neutral shape from lib/message.js; rendering it is the
// provider's job. Adding Slack/Teams/... = one file here plus register().
//
// Other plugins can add providers too: fire
// `filter:chatbridge.providers` and push onto the list.

const providers = new Map();

const Providers = module.exports;

Providers.register = function (provider) {
	for (const k of ['id', 'label', 'verify', 'findUser', 'send']) {
		if (!provider || !provider[k]) throw new Error(`[chatbridge] provider is missing "${k}"`);
	}
	if (!/^[a-z][a-z0-9]*$/.test(provider.id)) throw new Error(`[chatbridge] bad provider id "${provider.id}"`);
	providers.set(provider.id, provider);
	return provider;
};

Providers.get = id => providers.get(id) || null;
Providers.list = () => [...providers.values()];
Providers.clear = () => providers.clear(); // tests

Providers.resetAll = function () {
	providers.forEach((p) => { if (typeof p.reset === 'function') p.reset(); });
};

Providers.missingConfig = function (provider, cfg) {
	if (typeof provider.configured === 'function') return provider.configured(cfg) || '';
	const missing = (provider.fields || []).filter(f => f.required && !cfg[f.key]).map(f => f.label);
	return missing.length ? `Missing: ${missing.join(', ')}` : '';
};

let builtinsLoaded = false;
Providers.registerBuiltins = async function (pluginsHooks) {
	if (!builtinsLoaded) {
		Providers.register(require('./mattermost'));
		builtinsLoaded = true;
	}
	if (pluginsHooks && typeof pluginsHooks.fire === 'function') {
		const extra = await pluginsHooks.fire('filter:chatbridge.providers', { providers: [] });
		((extra && extra.providers) || []).forEach(p => Providers.register(p));
	}
};
