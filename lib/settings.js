'use strict';

// Plugin settings (ACP form -> meta.settings hash "chatbridge").
//
// Flat keys, strings as the ACP settings module stores them:
//   event_<key>          'on' | 'off'            (lib/events.js CATALOG)
//   excerptLength        '300'
//   baseUrl              ''  -> nconf url
//   <provider>_enabled   'on' | 'off'
//   <provider>_match     comma-separated, tried in order: 'username', 'email', 'displayname'
//   <provider>_<field>   provider-declared fields (url, token, ...)
//
// Cached briefly; invalidated on save in this process (action:settings.set),
// and other cluster processes pick the change up when the cache expires.

const nbb = require('./nbb');

const meta = nbb('./src/meta');
const nconf = nbb('nconf');
const Events = require('./events');

const Settings = module.exports;

Settings.HASH = 'chatbridge';
Settings.TTL_MS = 30 * 1000;

let cached = null;
let cachedAt = 0;

Settings.isOn = function (v) {
	return v === true || ['on', 'true', '1', 'yes'].includes(String(v).toLowerCase());
};

Settings.defaults = function () {
	const d = { excerptLength: '300', baseUrl: '' };
	Events.CATALOG.forEach((e) => { d[`event_${e.key}`] = e.default ? 'on' : 'off'; });
	return d;
};

Settings.get = async function () {
	if (cached && Date.now() - cachedAt < Settings.TTL_MS) return cached;
	const stored = (await meta.settings.get(Settings.HASH)) || {};
	cached = Object.assign(Settings.defaults(), stored);
	cachedAt = Date.now();
	return cached;
};

// Fills in keys that were never saved (NodeBB's setOnEmpty only writes absent fields).
Settings.storeDefaults = async function (providers) {
	const d = Settings.defaults();
	(providers || []).forEach((p) => {
		d[`${p.id}_enabled`] = 'off';
		d[`${p.id}_match`] = p.defaultMatch || 'username';
		(p.fields || []).forEach((f) => { if (f.default) d[`${p.id}_${f.key}`] = f.default; });
	});
	if (typeof meta.settings.setOnEmpty === 'function') await meta.settings.setOnEmpty(Settings.HASH, d);
	Settings.invalidate();
};

Settings.invalidate = function () {
	cached = null;
	cachedAt = 0;
};

Settings.eventEnabled = function (s, event) {
	return Settings.isOn(s[`event_${event}`]);
};

Settings.baseUrl = function (s) {
	return String((s && s.baseUrl) || nconf.get('url') || '').replace(/\/+$/, '');
};

Settings.excerptLength = function (s) {
	const n = parseInt(s && s.excerptLength, 10);
	return Number.isFinite(n) && n >= 0 ? Math.min(n, 2000) : 300;
};

// One provider's view of the settings: { enabled, match, ...its fields }.
Settings.providerConfig = function (s, provider) {
	const prefix = `${provider.id}_`;
	const cfg = {
		enabled: Settings.isOn(s[`${prefix}enabled`]),
		match: String(s[`${prefix}match`] || provider.defaultMatch || 'username'),
	};
	(provider.fields || []).forEach((f) => {
		const v = s[prefix + f.key];
		cfg[f.key] = v === undefined || v === null || v === '' ? (f.default || '') : String(v).trim();
	});
	return cfg;
};
