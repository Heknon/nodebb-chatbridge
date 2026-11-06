'use strict';

// NodeBB uid -> chat user id, per provider. With LDAP sign-in the NodeBB
// username is the chat username, so 'username' is the default strategy.
// Cached in memory: a hit for 6h, a miss for 15 min (so a user who joins
// Mattermost later starts getting messages soon after).

const nbb = require('./nbb');

const user = nbb('./src/user');

const Identity = module.exports;

Identity.HIT_TTL_MS = 6 * 60 * 60 * 1000;
Identity.MISS_TTL_MS = 15 * 60 * 1000;

const cache = new Map(); // `${providerId}|${match}|${uid}` -> { id, at }

Identity.clear = () => cache.clear();

Identity.forumUser = async function (uid) {
	const u = await user.getUserFields(uid, ['uid', 'username', 'email', 'email:confirmed']);
	if (!u || !u.uid) return null;
	return {
		uid: u.uid,
		username: u.username || '',
		// Only a confirmed address identifies the person.
		email: (parseInt(u['email:confirmed'], 10) === 1 && u.email) || '',
	};
};

// Returns the external id or null. Provider errors propagate (the caller logs).
Identity.resolve = async function (provider, cfg, uid) {
	const k = `${provider.id}|${cfg.match}|${uid}`;
	const hit = cache.get(k);
	if (hit && Date.now() - hit.at < (hit.id ? Identity.HIT_TTL_MS : Identity.MISS_TTL_MS)) return hit.id;

	const fu = await Identity.forumUser(uid);
	const id = fu ? await provider.findUser(cfg, fu, cfg.match) : null;
	cache.set(k, { id: id || null, at: Date.now() });
	return id || null;
};

Identity.forget = function (providerId, uid) {
	for (const k of cache.keys()) {
		if (k.startsWith(`${providerId}|`) && k.endsWith(`|${uid}`)) cache.delete(k);
	}
};
