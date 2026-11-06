'use strict';

// Import NodeBB core modules the modern way. NodeBB v4 exposes a global
// `nodebb.require(...)`; older versions only have `require.main.require(...)`.
// Using this avoids the dev-mode deprecation warnings for require.main.require.
//
// Usage: const nbb = require('./nbb'); const db = nbb('./src/database');

/* eslint-disable no-undef */
module.exports = (typeof nodebb !== 'undefined' && nodebb && typeof nodebb.require === 'function')
	? nodebb.require.bind(nodebb)
	: require.main.require;
