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

// Never handed to a provider, whatever a template asks for.
Identity.SECRET_FIELD = /pass|token|secret|salt/i;

// withDisplayName: also work out the display name (a db lookup, so only when asked).
// fields: extra user-hash fields (custom profile fields, ...) for `fields`.
// A requested 'email' is the confirmed address only, like `email`.
Identity.forumUser = async function (uid, { withDisplayName = false, fields = [] } = {}) {
	const extra = [...new Set((fields || []).map(String).filter(f => f && !Identity.SECRET_FIELD.test(f)))];
	const base = ['uid', 'username', 'userslug', 'email', 'email:confirmed', 'fullname'];
	const u = await user.getUserFields(uid, [...new Set([...base, ...extra])]);
	if (!u || !u.uid) return null;
	// Only a confirmed address identifies the person.
	const email = (parseInt(u['email:confirmed'], 10) === 1 && u.email) || '';
	const out = {
		uid: u.uid,
		username: u.username || '',
		userslug: u.userslug || '',
		email,
		fullname: decodeEntities(u.fullname || '').replace(/\s+/g, ' ').trim(),
		displayname: withDisplayName ? await Identity.displayName(u.uid, u.fullname) : '',
		fields: {},
	};
	extra.forEach((f) => {
		const v = f === 'email' ? email : u[f];
		out.fields[f] = v === undefined || v === null ? '' : decodeEntities(String(v));
	});
	return out;
};

// Returns the external id or null. Provider errors propagate (the caller logs).
Identity.resolve = async function (provider, cfg, uid) {
	const k = `${provider.id}|${cfg.match}|${uid}`;
	const hit = cache.get(k);
	if (hit && Date.now() - hit.at < (hit.id ? Identity.HIT_TTL_MS : Identity.MISS_TTL_MS)) return hit.id;

	// A provider can ask for more of the user than its match rule needs
	// (the webhook's template placeholders): { displayname: bool, fields: [...] }.
	const want = (typeof provider.userFields === 'function' && provider.userFields(cfg)) || {};
	const fu = await Identity.forumUser(uid, {
		withDisplayName: /\bdisplayname\b/.test(cfg.match || '') || !!want.displayname,
		fields: want.fields || [],
	});
	const id = fu ? await provider.findUser(cfg, fu, cfg.match) : null;
	cache.set(k, { id: id || null, at: Date.now() });
	return id || null;
};

Identity.forget = function (providerId, uid) {
	for (const k of cache.keys()) {
		if (k.startsWith(`${providerId}|`) && k.endsWith(`|${uid}`)) cache.delete(k);
	}
};
