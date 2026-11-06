'use strict';

// /api/v3/plugins/chatbridge/... (ACP tools). Registered through setupApiRoute
// so API tokens authenticate and cookie-session writes are CSRF-checked.

const nbb = require('./nbb');

const winston = nbb('winston');
const routeHelpers = nbb('./src/routes/helpers');
const apiHelpers = nbb('./src/controllers/helpers');

const controllers = require('./controllers');

const Api = module.exports;

Api.wrap = function (fn) {
	return async function (req, res) {
		try {
			await fn(req, res);
		} catch (err) {
			if (Number.isInteger(err.status)) return apiHelpers.formatApiResponse(err.status, res, err);
			winston.error(`[plugin/chatbridge] ${req.method} ${req.originalUrl || req.url}: ${err.stack}`);
			apiHelpers.formatApiResponse(500, res, new Error('[[error:api.500]]'));
		}
	};
};

Api.register = function (router, setupApiRoute = routeHelpers.setupApiRoute) {
	const route = (verb, path, fn) => setupApiRoute(router, verb, path, [], Api.wrap(fn));
	route('post', '/chatbridge/providers/:provider/verify', controllers.verify);
	route('post', '/chatbridge/providers/:provider/test-message', controllers.testMessage);
	route('get', '/chatbridge/log', controllers.log);
};
