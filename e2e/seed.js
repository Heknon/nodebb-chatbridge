'use strict';

// Forum users and categories for the E2E run.
//   alice      -> MM alice (username)
//   Bob        -> MM bob (username, case differs)
//   dave.forum -> MM dave.mm (only by verified email)
//   nobody     -> no MM account
//   gone       -> MM account deactivated
//   eve        -> MM none; email unconfirmed (must not match by email)

const fs = require('fs');
const { Session, WORK } = require('./client');

const PW = 'User-pass-123!';
const USERS = [
	{ username: 'alice', email: 'alice@corp.example' },
	{ username: 'Bob', email: 'bob@corp.example' },
	{ username: 'dave.forum', email: 'dave.mm@corp.example' },
	{ username: 'nobody', email: 'nobody@corp.example' },
	{ username: 'gone', email: 'gone@corp.example' },
	{ username: 'eve', email: 'alice@corp.example.unconfirmed', noConfirm: true },
];

(async () => {
	const admin = await new Session().login('admin', 'Admin-pass-123!');
	const out = { adminUid: admin.uid, users: {} };
	for (const u of USERS) {
		/* eslint-disable no-await-in-loop */
		const r = await admin.v3('POST', '/users', { username: u.username, password: PW, email: u.email });
		if (r.status !== 200) throw new Error(`create ${u.username}: ${r.text}`);
		const { uid } = r.response;
		if (!u.noConfirm) {
			const c = await admin.v3('POST', `/users/${uid}/emails/${encodeURIComponent(u.email)}/confirm`);
			if (c.status !== 200) throw new Error(`confirm ${u.username}: ${c.status} ${c.text}`);
		}
		out.users[u.username] = uid;
		/* eslint-enable no-await-in-loop */
	}
	// A public category and a private one (admins only).
	const pub = await admin.v3('POST', '/categories', { name: 'Helpdesk' });
	const priv = await admin.v3('POST', '/categories', { name: 'Staff only' });
	out.cidPublic = pub.response.cid;
	out.cidPrivate = priv.response.cid;
	for (const p of ['groups:find', 'groups:read', 'groups:topics:read']) {
		// eslint-disable-next-line no-await-in-loop
		for (const g of ['registered-users', 'guests', 'spiders', 'fediverse']) await admin.v3('DELETE', `/categories/${out.cidPrivate}/privileges/${p}/${g}`);
	}
	fs.writeFileSync(`${WORK}/seed.json`, JSON.stringify(out, null, 2));
	console.log(JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(1); });
