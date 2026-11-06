'use strict';

// NodeBB uid -> chat user id, per provider. With LDAP sign-in the NodeBB
// username is the chat username, so 'username' is the default strategy;
// 'email' and 'displayname' are optional fallbacks.
// Cached in memory: a hit for 6h, a miss for 15 min (so a user who joins
// Mattermost later starts getting messages soon after).

const nbb = require('./nbb');

const db = nbb('./src/database');
const user = nbb('./src/user');

const { decodeEntities } = require('./message');

const Identity = module.exports;

Identity.HIT_TTL_MS = 6 * 60 * 60 * 1000;
Identity.MISS_TTL_MS = 15 * 60 * 1000;

const cache = new Map(); // `${providerId}|${match}|${uid}` -> { id, at }

Identity.clear = () => cache.clear();

// The name to look a user up by: their full name (NodeBB shows it as the
// display name), but only if no other forum user has the same one. Otherwise
// two people would share one chat account. Uses NodeBB's own index,
// `fullname:sorted` ("<lowercased full name>:<uid>").
Identity.displayName = async function (uid, fullname) {
	const raw = String(fullname || '');
	const name = decodeEntities(raw).replace(/\s+/g, ' ').trim();
	if (!name) return '';
	const lower = raw.toLowerCase();
	const holders = await db.getSortedSetRangeByLex('fullname:sorted', `[${lower}:`, `(${lower};`);
	return (holders || []).some(v => v !== `${lower}:${uid}`) ? '' : name;
};

// withDisplayName: also work out the display name (a db lookup, so only when asked).
Identity.forumUser = async function (uid, { withDisplayName = false } = {}) {
	const u = await user.getUserFields(uid, ['uid', 'username', 'email', 'email:confirmed', 'fullname']);
	if (!u || !u.uid) return null;
	return {
		uid: u.uid,
		username: u.username || '',
		// Only a confirmed address identifies the person.
		email: (parseInt(u['email:confirmed'], 10) === 1 && u.email) || '',
		displayname: withDisplayName ? await Identity.displayName(u.uid, u.fullname) : '',
	};
};

// Returns the external id or null. Provider errors propagate (the caller logs).
Identity.resolve = async function (provider, cfg, uid) {
	const k = `${provider.id}|${cfg.match}|${uid}`;
	const hit = cache.get(k);
	if (hit && Date.now() - hit.at < (hit.id ? Identity.HIT_TTL_MS : Identity.MISS_TTL_MS)) return hit.id;

	const fu = await Identity.forumUser(uid, { withDisplayName: /\bdisplayname\b/.test(cfg.match || '') });
	const id = fu ? await provider.findUser(cfg, fu, cfg.match) : null;
	cache.set(k, { id: id || null, at: Date.now() });
	return id || null;
};

Identity.forget = function (providerId, uid) {
	for (const k of cache.keys()) {
		if (k.startsWith(`${providerId}|`) && k.endsWith(`|${uid}`)) cache.delete(k);
	}
};
