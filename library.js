'use strict';

const nbb = require('./lib/nbb');

const nconf = nbb('nconf');
const winston = nbb('winston');
const routeHelpers = nbb('./src/routes/helpers');

const controllers = require('./lib/controllers');
const api = require('./lib/api');
const relay = require('./lib/relay');
const outbox = require('./lib/outbox');
const settings = require('./lib/settings');
const providers = require('./lib/providers');

const plugin = module.exports;

plugin.init = async function ({ router }) {
	await providers.registerBuiltins(nbb('./src/plugins').hooks);
	// Store defaults once, so the ACP form shows what is actually in effect.
	await settings.storeDefaults(providers.list());
	routeHelpers.setupAdminPageRoute(router, '/admin/plugins/chatbridge', controllers.renderAdmin);

	// Retries are drained by one process only (NodeBB's job runner), so a
	// clustered forum doesn't deliver a retried message once per process.
	if (nconf.get('runJobs')) outbox.start();
	winston.verbose('[plugin/chatbridge] loaded');
};

plugin.apiRoutes = async function ({ router }) {
	api.register(router);
};

plugin.adminMenu = async function (header) {
	header.plugins.push({ route: '/plugins/chatbridge', icon: 'fa-comments', name: 'Chat Bridge' });
	return header;
};

// NodeBB fires this after every notification push, with the recipients already
// filtered by their notification settings and blocks. Never throws.
plugin.onNotificationPushed = function (data) {
	return relay.onNotificationPushed(data);
};

plugin.onSettingsSet = function (data) {
	if (data && data.plugin === settings.HASH) {
		settings.invalidate();
		providers.resetAll();
	}
};
