'use strict';

// End-to-end: a real NodeBB 4 (+ Shotef, when mounted) with this plugin,
// delivering to a real Mattermost. Start the stack with ./up.sh first.
//
//   node e2e/scenario.js [check-name-prefix,...]
//
// Prints PASS/FAIL per check and writes .work/results.json. Re-runnable: it
// resets the plugin's settings first, and makes its own topics each run.

const fs = require('fs');
const { execSync } = require('child_process');
const assert = require('assert');
const { chromium } = require('playwright');
const { Session, mm, dms, sleep, waitFor, NBB, env, WORK } = require('./client');

const seed = JSON.parse(fs.readFileSync(`${WORK}/seed.json`, 'utf8'));
const MM_CONTAINER = 'chatbridge-e2e-mattermost';
const NBB_CONTAINER = 'chatbridge-e2e-nodebb';
const PW = 'User-pass-123!';
const only = (process.argv[2] || '').split(',').filter(Boolean);
const results = [];
const evidence = {};

let browser;
const pages = {};
async function pageAs(username, password = PW) {
	if (pages[username]) return pages[username];
	const page = await browser.newPage();
	await page.goto(`${NBB}/login`);
	await page.fill('#username', username);
	await page.fill('#password', password);
	await Promise.all([page.waitForNavigation(), page.click('#login')]);
	await page.goto(`${NBB}/`);
	await page.waitForFunction(() => window.socket && window.socket.connected);
	pages[username] = page;
	return page;
}
async function emit(username, event, data, password) {
	const page = await pageAs(username, password);
	return page.evaluate(([e, d]) => new Promise((resolve, reject) => {
		window.socket.emit(e, d, (err, r) => (err ? reject(new Error(err.message)) : resolve(r)));
	}), [event, data]);
}
const setBridge = values => emit('admin', 'admin.settings.set', { hash: 'chatbridge', values }, 'Admin-pass-123!');

const S = {};
async function sessions() {
	S.admin = await new Session().login('admin', 'Admin-pass-123!');
	for (const u of ['alice', 'Bob', 'dave.forum', 'nobody', 'gone']) {
		// eslint-disable-next-line no-await-in-loop
		S[u] = await new Session().login(u, PW);
	}
}

async function ok(r, what) {
	if (r.status !== 200) throw new Error(`${what}: HTTP ${r.status} ${r.text && r.text.slice(0, 300)}`);
	return r.response;
}
const topic = async (who, title, content, cid = seed.cidPublic) => ok(await S[who].v3('POST', '/topics', { cid, title, content }), `topic by ${who}`);
const reply = async (who, tid, content) => ok(await S[who].v3('POST', `/topics/${tid}`, { content }), `reply by ${who}`);
const follow = async (who, tid) => ok(await S[who].v3('PUT', `/topics/${tid}/follow`), `follow by ${who}`);
const userSettings = async (who, settings) => ok(await S[who].v3('PUT', `/users/${S[who].uid}/settings`, { settings }), `settings ${who}`);
const shotef = async (who, verb, path, body) => ok(await S[who].v3(verb, `/plugins/shotef${path}`, body), `shotef ${verb} ${path}`);
const bridgeLog = async () => (await ok(await S.admin.v3('GET', '/plugins/chatbridge/log'), 'log'));

const count = async u => (await dms(u)).length;
async function nextDm(u, before, timeout = 15000) {
	return waitFor(async () => { const p = await dms(u); return p.length > before ? p[p.length - 1] : null; }, { timeout, what: `a DM to ${u}` });
}
async function noDm(u, before, ms = 4000) {
	await sleep(ms);
	const n = await count(u);
	assert.strictEqual(n, before, `${u} got ${n - before} unexpected DM(s)`);
}
const att = p => p.props.attachments[0];
function nodebbLog(grep) {
	return execSync(`docker exec ${NBB_CONTAINER} bash -c 'sed "s/\\x1b\\[[0-9;]*m//g" /tmp/nodebb.log | grep -E "${grep}" | tail -5'`).toString().trim();
}

async function check(name, fn) {
	if (only.length && !only.some(o => name.startsWith(o))) return;
	if (name.startsWith('shotef:') && !ctx.shotef) {
		results.push({ name, ok: true, skipped: true });
		console.log(`SKIP ${name} (Shotef is not installed)`);
		return;
	}
	const t = Date.now();
	try {
		const ev = await fn();
		results.push({ name, ok: true, ms: Date.now() - t });
		if (ev !== undefined) evidence[name] = ev;
		console.log(`PASS ${name}`);
	} catch (e) {
		results.push({ name, ok: false, ms: Date.now() - t, error: e.message });
		console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`);
	}
}

const ctx = {};

(async () => {
	browser = await chromium.launch();
	await sessions();
	// Let test users post freely.
	for (const [k, v] of Object.entries({ postDelay: 0, initialPostDelay: 0, newbiePostDelay: 0, newbieReputationThreshold: 0, minimumPostLength: 1, postQueue: 0 })) {
		// eslint-disable-next-line no-await-in-loop
		await ok(await S.admin.v3('PUT', `/admin/settings/${k}`, { value: v }), `config ${k}`);
	}
	// Every run starts from the plugin's defaults, whatever a previous run left behind.
	await setBridge({
		mattermost_enabled: 'on', mattermost_url: 'http://mattermost:8065', mattermost_token: env.BOT_TOKEN, mattermost_match: 'username',
		webhook_enabled: 'off', webhook_url: '', webhook_headers: 'Content-Type: application/json', webhook_body: '{"channel": "@{{username}}", "text": "{{text}}"}',
		baseUrl: '', excerptLength: '300',
		event_reply: 'on', event_ticket_status: 'on', event_ticket_team: 'on', event_mention: 'on', event_topic: 'off', event_other: 'off',
	});
	await userSettings('alice', { 'notificationType_new-reply': 'notification' });
	await userSettings('Bob', { userLang: 'en-GB' });
	await waitFor(async () => (await bridgeLog()).pending === 0, { timeout: 90000, what: 'an empty outbox' });
	ctx.shotef = (await S.admin.raw('GET', '/api/v3/plugins/shotef/ping')).status === 200;

	// ------------------------------------------------------------------- ACP
	const acp = async () => {
		const page = await pageAs('admin', 'Admin-pass-123!');
		await page.goto(`${NBB}/admin/plugins/chatbridge`);
		await page.waitForFunction(() => window.ajaxify && ajaxify.data && ajaxify.data.settings && document.querySelector('.chatbridge-settings'));
		return page;
	};
	const acpResult = page => page.waitForFunction(() => {
		const t = document.querySelector('.chatbridge-result[data-provider="mattermost"]').textContent;
		return t && !/…$/.test(t) && t;
	}, null, { timeout: 20000 }).then(h => h.jsonValue());
	await check('ACP: the page shows the saved settings', async () => {
		const page = await acp();
		const form = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.chatbridge-settings [name]')]
			.map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value])));
		assert.deepStrictEqual(
			[form.event_reply, form.event_mention, form.event_topic, form.mattermost_enabled, form.mattermost_url, form.mattermost_match, form.excerptLength],
			[true, true, false, true, 'http://mattermost:8065', 'username', '300'],
		);
	});
	await check('ACP: a setting saved from the form takes effect', async () => {
		const page = await acp();
		await page.fill('#excerptLength', '7');
		await page.click('#chatbridge-save');
		await page.waitForTimeout(1000);
		const t = await topic('alice', 'Saved from the ACP', 'x');
		const a0 = await count('alice');
		await reply('Bob', t.tid, 'Seven characters at most');
		const a = att(await nextDm('alice', a0));
		await setBridge({ excerptLength: '300' });
		assert.strictEqual(a.text, '> Seven…');
	});
	await check('ACP: Test connection names the bot', async () => {
		const page = await acp();
		await page.click('.chatbridge-verify[data-provider="mattermost"]');
		assert.strictEqual(await acpResult(page), 'Connected as forumbot (bot)');
	});
	await check('ACP: Send me a test message reaches the admin\'s chat account', async () => {
		const page = await acp();
		const n0 = await count('admin');
		await page.click('.chatbridge-test-message[data-provider="mattermost"]');
		assert.strictEqual(await acpResult(page), 'Sent. Check your direct messages.');
		const a = att(await nextDm('admin', n0));
		assert.match(a.pretext, /^Test message from the forum's \*\*Chat Bridge\*\*/);
	});

	// ---------------------------------------------------------------- replies
	await check('reply: topic author gets a DM with title, link and a clean excerpt', async () => {
		ctx.t1 = await topic('alice', 'Printer on fire & "smoke"', 'It is literally on fire.');
		const a0 = await count('alice');
		const b0 = await count('bob');
		const r = await reply('Bob', ctx.t1.tid, '> It is literally on fire.\n\nHave you tried [the guide](https://example.com/guide)? Run this:\n\n```\nsudo rm -rf /\n```\n\nThanks & good luck!');
		ctx.t1pid = r.pid;
		const p = await nextDm('alice', a0);
		const a = att(p);
		assert.strictEqual(a.pretext, '**Bob** posted a reply in **Printer on fire & "smoke"**');
		assert.strictEqual(a.title, 'Printer on fire & "smoke"');
		assert.strictEqual(a.title_link, `http://localhost:4567/post/${r.pid}`);
		assert.strictEqual(a.color, '#1e88e5');
		assert.ok(!/fire\./.test(a.text), `the quote leaked into the excerpt: ${a.text}`);
		assert.ok(!/rm -rf/.test(a.text), `code leaked: ${a.text}`);
		assert.strictEqual(a.text, '> Have you tried the guide? Run this: \\[code\\] Thanks & good luck!');
		assert.strictEqual(p.props.from_nodebb_chatbridge, 'reply');
		await noDm('bob', b0, 2000);
		return a;
	});

	await check('reply: the delivery log records it', async () => {
		const { entries } = await bridgeLog();
		const e = entries.find(x => x.url === `http://localhost:4567/post/${ctx.t1pid}`);
		assert.ok(e, 'no log entry');
		assert.deepStrictEqual({ outcome: e.outcome, provider: e.provider, uid: e.uid, event: e.event, title: e.title, attempts: e.attempts },
			{ outcome: 'sent', provider: 'mattermost', uid: seed.users.alice, event: 'reply', title: 'Printer on fire & "smoke"', attempts: 1 });
	});

	// --------------------------------------------------------------- mention
	await check('mention: the mentioned user gets a DM (forum "Bob" -> Mattermost "bob")', async () => {
		const b0 = await count('bob');
		ctx.t2 = await topic('alice', 'VPN down', 'Hey @Bob can you take a look at the VPN?');
		const a = att(await nextDm('bob', b0));
		assert.match(a.pretext, /\*\*alice\*\*.*\*\*VPN down\*\*/);
		assert.strictEqual(a.title, 'VPN down');
		assert.match(a.text, /can you take a look at the VPN/);
		assert.ok(a.text.includes('@Bob'), `mention split by tag stripping: ${a.text}`);
		return a;
	});

	// ------------------------------------------- the user's notification settings
	await check('user setting "none" for replies: no DM', async () => {
		await userSettings('alice', { 'notificationType_new-reply': 'none' });
		const a0 = await count('alice');
		await reply('Bob', ctx.t1.tid, 'Did that help?');
		await noDm('alice', a0);
	});
	await check('user setting "email only" for replies: still DMed (uidsEmailed)', async () => {
		await userSettings('alice', { 'notificationType_new-reply': 'email' });
		const a0 = await count('alice');
		await reply('Bob', ctx.t1.tid, 'Ping by email');
		const a = att(await nextDm('alice', a0));
		assert.match(a.text, /Ping by email/);
		await userSettings('alice', { 'notificationType_new-reply': 'notification' });
	});

	// ------------------------------------------------------------ user matching
	await check('matching: unmatched, deactivated and username-only users get nothing', async () => {
		await follow('dave.forum', ctx.t1.tid);
		await follow('nobody', ctx.t1.tid);
		await follow('gone', ctx.t1.tid);
		const d0 = await count('dave.mm');
		const g0 = await count('gone');
		const a0 = await count('alice');
		await reply('Bob', ctx.t1.tid, 'Everyone following, look');
		await nextDm('alice', a0);
		await noDm('dave.mm', d0, 1500);
		await noDm('gone', g0, 0);
	});
	await check('matching: "username, then verified email" reaches dave.forum -> dave.mm', async () => {
		await setBridge({ mattermost_match: 'username,email' });
		const d0 = await count('dave.mm');
		await reply('Bob', ctx.t1.tid, 'Now by email too');
		const a = att(await nextDm('dave.mm', d0));
		assert.match(a.text, /Now by email too/);
		await setBridge({ mattermost_match: 'username' });
	});

	// ------------------------------------------------ display-name fallback
	// Chat users with real names, and forum users whose usernames don't match
	// theirs. Created here (idempotently) so the checks run on any stack.
	const named = {};
	const ensureNamed = async () => {
		if (named.ready) return;
		for (const [username, first_name, last_name] of [['dlevi', 'Dana', 'Levi'], ['ncohen1', 'Noa', 'Cohen'], ['ncohen2', 'Noa', 'Cohen'], ['rkatz', 'Rina', 'Katz']]) {
			// eslint-disable-next-line no-await-in-loop
			await mm('POST', '/users', { username, first_name, last_name, email: `${username}@corp.example`, password: PW }, env.ADMIN_TOKEN);
		}
		for (const [username, fullname] of [['dana.forum', 'Dana Levi'], ['noa.forum', 'Noa Cohen'], ['rina.a', 'Rina Katz'], ['rina.b', 'Rina Katz']]) {
			/* eslint-disable no-await-in-loop */
			// Look up first: NodeBB doesn't refuse a taken username, it creates "dana.forum 0".
			const found = await S.admin.raw('GET', `/api/user/username/${encodeURIComponent(username)}`);
			const uid = (found.status === 200 && found.json && found.json.uid)
				|| (await ok(await S.admin.v3('POST', '/users', { username, password: PW, fullname }), `create ${username}`)).uid;
			await ok(await S.admin.v3('PUT', `/users/${uid}`, { fullname }), `fullname of ${username}`);
			S[username] = await new Session().login(username, PW);
			/* eslint-enable no-await-in-loop */
		}
		named.topic = await topic('alice', 'Who is on the rota?', 'x');
		for (const u of ['dana.forum', 'noa.forum', 'rina.a']) await follow(u, named.topic.tid); // eslint-disable-line no-await-in-loop
		named.ready = true;
	};
	const counts = async users => Object.fromEntries(await Promise.all(users.map(async u => [u, await count(u)])));
	await check('display name: off unless chosen (match by username only)', async () => {
		await ensureNamed();
		const d0 = await count('dlevi');
		await reply('Bob', named.topic.tid, 'Username matching only');
		await noDm('dlevi', d0);
	});
	await check('display name: the forum full name finds the chat user with that name', async () => {
		await ensureNamed();
		await setBridge({ mattermost_match: 'username,displayname' });
		const d0 = await count('dlevi');
		await reply('Bob', named.topic.tid, 'Found you by name');
		const a = att(await nextDm('dlevi', d0));
		assert.match(a.text, /Found you by name/);
	});
	await check('display name: a name two chat users share, or two forum users share, matches nobody', async () => {
		await ensureNamed();
		await setBridge({ mattermost_match: 'username,displayname' });
		const before = await counts(['ncohen1', 'ncohen2', 'rkatz', 'dlevi']);
		await reply('Bob', named.topic.tid, 'Only Dana should get this');
		await nextDm('dlevi', before.dlevi);
		await sleep(2500);
		const after = await counts(['ncohen1', 'ncohen2', 'rkatz']);
		assert.deepStrictEqual(after, { ncohen1: before.ncohen1, ncohen2: before.ncohen2, rkatz: before.rkatz });
	});
	await check('display name: with Show Full Name off in Mattermost, full names find nobody', async () => {
		await ensureNamed();
		await mm('PUT', '/config/patch', { PrivacySettings: { ShowFullName: false } }, env.ADMIN_TOKEN);
		try {
			await setBridge({ mattermost_match: 'username,displayname' }); // a save also forgets matched users
			const d0 = await count('dlevi');
			await reply('Bob', named.topic.tid, 'Names are hidden now');
			await noDm('dlevi', d0);
		} finally {
			await mm('PUT', '/config/patch', { PrivacySettings: { ShowFullName: true } }, env.ADMIN_TOKEN);
			await setBridge({ mattermost_match: 'username' });
		}
	});

	// --------------------------------------------------------- event toggles
	await check('event "topic" is off by default, and on when enabled', async () => {
		await ok(await S.alice.v3('PUT', `/categories/${seed.cidPublic}/watch`, { state: 'watching' }), 'watch');
		let a0 = await count('alice');
		await topic('Bob', 'Coffee machine broken', 'It only makes tea now.');
		await noDm('alice', a0);
		await setBridge({ event_topic: 'on' });
		a0 = await count('alice');
		ctx.t3 = await topic('Bob', 'Elevator stuck', 'Third floor, again.');
		const a = att(await nextDm('alice', a0));
		assert.strictEqual(a.title, 'Elevator stuck');
		assert.match(a.text, /Third floor/);
		await setBridge({ event_topic: 'off' });
		await ok(await S.alice.v3('PUT', `/categories/${seed.cidPublic}/watch`, { state: 'notwatching' }), 'unwatch');
		return a;
	});
	await check('event "reply" turned off: no DM', async () => {
		await setBridge({ event_reply: 'off' });
		const a0 = await count('alice');
		await reply('Bob', ctx.t1.tid, 'Muted reply');
		await noDm('alice', a0);
		await setBridge({ event_reply: 'on' });
	});

	// ----------------------------------------------------- language, url, excerpt
	await check('language: a Hebrew user gets the summary in Hebrew', async () => {
		await userSettings('Bob', { userLang: 'he' });
		const b0 = await count('bob');
		await reply('alice', ctx.t3.tid, 'Took the stairs.');
		const a = att(await nextDm('bob', b0));
		await userSettings('Bob', { userLang: 'en-GB' });
		assert.ok(/[֐-׿]/.test(a.pretext), `not Hebrew: ${a.pretext}`);
		return a.pretext;
	});
	await check('baseUrl and excerpt length settings apply', async () => {
		await setBridge({ baseUrl: 'https://forum.corp.example/', excerptLength: '20' });
		const a0 = await count('alice');
		const r = await reply('Bob', ctx.t1.tid, 'This sentence is definitely longer than twenty characters.');
		const a = att(await nextDm('alice', a0));
		await setBridge({ baseUrl: '', excerptLength: '300' });
		assert.strictEqual(a.title_link, `https://forum.corp.example/post/${r.pid}`);
		assert.ok(a.text.length <= 24 && a.text.endsWith('…'), a.text);
		return a.text;
	});
	await check('excerpt length 0: no excerpt', async () => {
		await setBridge({ excerptLength: '0' });
		const a0 = await count('alice');
		await reply('Bob', ctx.t1.tid, 'Should not appear');
		const a = att(await nextDm('alice', a0));
		await setBridge({ excerptLength: '300' });
		assert.ok(!a.text, a.text);
	});

	// ------------------------------------------------------------ title markdown
	await check('a topic title cannot inject markdown into the bot\'s summary line', async () => {
		const t = await topic('alice', '[Reset your password](https://evil.example/login) **now**', 'help');
		const a0 = await count('alice');
		await reply('Bob', t.tid, 'ok');
		const a = att(await nextDm('alice', a0));
		ctx.injected = a.pretext;
		const esc = '\\[Reset your password\\](https://evil.example/login) \\*\\*now\\*\\*';
		assert.strictEqual(a.pretext, `**Bob** posted a reply in **${esc}**`);
		assert.strictEqual(a.title, esc);
		assert.strictEqual(a.fallback, `Bob posted a reply in [Reset your password](https://evil.example/login) **now** ${a.title_link}`);
	});

	await check('URLs in an excerpt stay as they are (chat autolinks them)', async () => {
		const t = await topic('alice', 'Links: snake_case & a|b #1', 'x');
		const a0 = await count('alice');
		await reply('Bob', t.tid, 'See https://example.com/some_path/a*b?x=1_2 and www.example.org/x_y');
		const a = att(await nextDm('alice', a0));
		assert.strictEqual(a.text, '> See https://example.com/some_path/a*b?x=1_2 and www.example.org/x_y');
		assert.strictEqual(a.title, 'Links: snake\\_case & a\\|b \\#1');
	});

	// ------------------------------------------------------------------ Shotef
	await check('shotef: set up a team on the Helpdesk category', async () => {
		const res = await shotef('admin', 'PUT', '/teams/sup', {
			name: 'Support', members: `${seed.adminUid},${seed.users.Bob}`, managers: `${seed.adminUid},${seed.users.Bob}`,
			roster: `${seed.adminUid},${seed.users.Bob}`, categories: String(seed.cidPublic),
		});
		assert.strictEqual(res.team.id, 'sup');
	});
	await check('shotef: reporter gets stage DMs (in progress, answered, closed-no-response)', async () => {
		ctx.ticket = await topic('alice', 'Laptop will not boot', 'Black screen since this morning.');
		await sleep(500);
		const got = [];
		for (const [to, extra, stage, color] of [
			['in_work', {}, 'in_progress', '#e0a03c'],
			['responded', {}, 'answered', '#4b9e7a'],
			['closed', { closeReason: 'no_response' }, 'closed-no-response', '#9aa4b2'],
		]) {
			/* eslint-disable no-await-in-loop */
			const a0 = await count('alice');
			await shotef('Bob', 'PUT', `/tickets/${ctx.ticket.tid}/status`, { to, ...extra });
			const p = await nextDm('alice', a0);
			const a = att(p);
			assert.strictEqual(p.props.from_nodebb_chatbridge, 'ticket_status');
			assert.strictEqual(a.color, color, `${stage} colour`);
			assert.strictEqual(a.title, 'Laptop will not boot');
			assert.strictEqual(a.title_link, `http://localhost:4567/topic/${ctx.ticket.tid}`);
			assert.ok(!a.text, 'no excerpt on status DMs');
			got.push(a.pretext);
			/* eslint-enable no-await-in-loop */
		}
		assert.deepStrictEqual(got, [
			'Someone is now working on your request',
			'Support replied and is waiting for your response — tap to reply',
			'We closed your request because we didn\'t hear back — just reply here anytime to reopen it',
		]);
		return got;
	});
	await check('shotef: moving back and forth sends the same stage twice', async () => {
		const tk = await topic('alice', 'Monitor flickers', 'Every few seconds.');
		await sleep(500);
		await shotef('Bob', 'PUT', `/tickets/${tk.tid}/status`, { to: 'in_work' });
		await shotef('Bob', 'PUT', `/tickets/${tk.tid}/status`, { to: 'todo' });
		const a0 = await count('alice');
		await shotef('Bob', 'PUT', `/tickets/${tk.tid}/status`, { to: 'in_work' });
		const a = att(await nextDm('alice', a0));
		assert.strictEqual(a.pretext, 'Someone is now working on your request');
		ctx.ticket2 = tk;
	});
	await check('shotef: a public reply by the team sends one DM, not two', async () => {
		const a0 = await count('alice');
		await shotef('Bob', 'POST', `/tickets/${ctx.ticket2.tid}/replies`, { body: 'Try another cable.' });
		await nextDm('alice', a0);
		await sleep(4000);
		const after = await dms('alice');
		assert.strictEqual(after.length, a0 + 1, `got ${after.length - a0}: ${after.slice(a0).map(p => att(p).pretext).join(' | ')}`);
	});
	await check('shotef: the actor is not DMed about their own move', async () => {
		const tk = await topic('Bob', 'My own ticket', 'Self-reported.');
		await sleep(500);
		const b0 = await count('bob');
		await shotef('Bob', 'PUT', `/tickets/${tk.tid}/status`, { to: 'in_work' });
		await noDm('bob', b0);
	});
	await check('shotef: "assigned to you" reaches the assignee with the ticket title', async () => {
		const ad0 = await count('admin');
		await shotef('Bob', 'PUT', `/tickets/${ctx.ticket2.tid}/assignee`, { uid: seed.adminUid, teamId: 'sup' });
		const p = await nextDm('admin', ad0);
		const a = att(p);
		assert.strictEqual(p.props.from_nodebb_chatbridge, 'ticket_team');
		assert.strictEqual(a.pretext, 'A ticket was assigned to you');
		assert.strictEqual(a.title, 'Monitor flickers');
		assert.strictEqual(a.title_link, `http://localhost:4567/shotef?team=sup&card=${ctx.ticket2.tid}`);
		return a;
	});
	await check('shotef: "help wanted" reaches the other team members', async () => {
		const ad0 = await count('admin');
		await shotef('Bob', 'PUT', `/tickets/${ctx.ticket2.tid}/help-wanted`, { on: true });
		const a = att(await nextDm('admin', ad0));
		assert.strictEqual(a.pretext, 'A teammate flagged a ticket as help wanted');
		assert.strictEqual(a.title, 'Monitor flickers');
	});
	await check('shotef: event "ticket_status" off silences stage DMs only', async () => {
		await setBridge({ event_ticket_status: 'off' });
		const a0 = await count('alice');
		await shotef('Bob', 'PUT', `/tickets/${ctx.ticket2.tid}/status`, { to: 'responded' });
		await noDm('alice', a0);
		await setBridge({ event_ticket_status: 'on' });
	});
	await check('shotef: reporter who lost read access gets no stage DM', async () => {
		const tk = await topic('alice', 'Payroll question', 'Where is my payslip?');
		await sleep(500);
		for (const p of ['groups:topics:read', 'groups:read']) {
			// eslint-disable-next-line no-await-in-loop
			await S.admin.v3('DELETE', `/categories/${seed.cidPublic}/privileges/${p}/registered-users`);
		}
		const a0 = await count('alice');
		try {
			await shotef('Bob', 'PUT', `/tickets/${tk.tid}/status`, { to: 'in_work' });
			await noDm('alice', a0);
		} finally {
			for (const p of ['groups:topics:read', 'groups:read']) {
				// eslint-disable-next-line no-await-in-loop
				await S.admin.v3('PUT', `/categories/${seed.cidPublic}/privileges/${p}`, { member: 'registered-users' });
			}
		}
	});
	await check('shotef: shift handover on a team whose id is a number', async () => {
		// Team "1": topic 1 exists (NodeBB's welcome topic) and is unrelated.
		await shotef('admin', 'PUT', '/teams/1', {
			name: 'Night shift', members: `${seed.adminUid},${seed.users.Bob}`, managers: String(seed.adminUid),
			roster: `${seed.adminUid},${seed.users.Bob}`, categories: String(seed.cidPrivate),
		});
		// Hand over to whoever is not on duty, so the step can be re-run.
		let to = 'bob';
		let b0 = await count('bob');
		try {
			await emit('admin', 'plugins.shotef.handover', { teamId: '1', toUid: seed.users.Bob }, 'Admin-pass-123!');
		} catch (e) {
			if (!/handover-self/.test(e.message)) throw e;
			to = 'admin';
			b0 = await count('admin');
			await emit('Bob', 'plugins.shotef.handover', { teamId: '1', toUid: seed.adminUid });
		}
		const a = att(await nextDm(to, b0));
		ctx.handover = a;
		assert.strictEqual(a.pretext, 'You are now the on-duty shotef');
		assert.ok(!a.title, `a shift notice shows an unrelated topic's title: "${a.title}"`);
		assert.strictEqual(a.text, '[Open on the forum](http://localhost:4567/shotef?team=1)');
	});
	await check('shotef: a reminder DM names its own ticket', async () => {
		// Reminder ids are UUIDs; nid shotef:reminder:<uuid>. Make several so at
		// least one starts with a digit.
		const b0 = await count('bob');
		const fireAt = Date.now() + 2000;
		const rems = [];
		for (let i = 0; i < 4; i += 1) {
			// eslint-disable-next-line no-await-in-loop
			rems.push(await emit('Bob', 'plugins.shotef.addReminder', { tid: ctx.ticket2.tid, fireAt, note: `r${i}` }));
		}
		const posts = await waitFor(async () => { const p = await dms('bob'); return p.length >= b0 + rems.length ? p.slice(b0) : null; }, { timeout: 75000, what: 'reminder DMs' });
		ctx.reminders = rems.map(r => r.id);
		const titles = posts.map(p => att(p).title || '(none)');
		evidence.reminderTitles = rems.map((r, i) => `${r.id.slice(0, 8)}… -> "${titles[i]}"`);
		assert.ok(titles.every(t => t === 'Monitor flickers'), `reminder titles: ${evidence.reminderTitles.join(', ')}`);
	});

	// ------------------------------------------------------------- admin API auth
	await check('admin API: non-admin, anonymous and CSRF-less calls are refused', async () => {
		const asAlice = await S.alice.v3('GET', '/plugins/chatbridge/log');
		assert.strictEqual(asAlice.status, 403, `alice log ${asAlice.status}`);
		const aliceVerify = await S.alice.v3('POST', '/plugins/chatbridge/providers/mattermost/verify');
		assert.strictEqual(aliceVerify.status, 403);
		const anon = await new Session().raw('GET', '/api/v3/plugins/chatbridge/log');
		assert.ok([401, 403].includes(anon.status), `anon ${anon.status}`);
		const noCsrf = await S.admin.raw('POST', '/api/v3/plugins/chatbridge/providers/mattermost/verify', { headers: { 'x-csrf-token': '' } });
		assert.strictEqual(noCsrf.status, 403, `no csrf ${noCsrf.status}`);
		const unknown = await S.admin.v3('POST', '/plugins/chatbridge/providers/nope/verify');
		assert.strictEqual(unknown.status, 404);
		const good = await S.admin.v3('POST', '/plugins/chatbridge/providers/mattermost/verify');
		assert.deepStrictEqual(good.response, { ok: true, name: 'forumbot', isBot: true });
	});

	// ------------------------------------------------------------ failure paths
	await check('a bad token fails permanently and is logged with Mattermost\'s reason', async () => {
		await setBridge({ mattermost_token: 'definitely-wrong' });
		const r = await reply('Bob', ctx.t1.tid, 'With a bad token');
		await sleep(2000);
		const { entries } = await bridgeLog();
		const e = entries.find(x => x.url && x.url.endsWith(`/post/${r.pid}`));
		await setBridge({ mattermost_token: env.BOT_TOKEN });
		assert.ok(e, 'no log entry');
		assert.strictEqual(e.outcome, 'failed');
		assert.match(e.error, /401/);
		const v = await S.admin.v3('POST', '/plugins/chatbridge/providers/mattermost/verify');
		assert.strictEqual(v.response.ok, true, 'token restored');
		return e.error;
	});
	await check('Mattermost down: the DM is queued, then delivered by the retry drain', async () => {
		ctx.solo = await topic('alice', 'Only alice follows this', 'solo');
		const a0 = await count('alice');
		execSync(`docker pause ${MM_CONTAINER}`);
		let r;
		try {
			r = await reply('Bob', ctx.solo.tid, 'Sent while chat is down');
			await waitFor(async () => (await bridgeLog()).pending === 1, { timeout: 20000, what: 'a pending retry' });
		} finally {
			execSync(`docker unpause ${MM_CONTAINER}`);
		}
		const p = await nextDm('alice', a0, 100000).catch(() => null);
		const { entries, pending } = await bridgeLog();
		const mine = entries.filter(x => x.url && x.url.endsWith(`/post/${r.pid}`)).map(x => `${x.outcome}#${x.attempts}`);
		assert.ok(p && /Sent while chat is down/.test(att(p).text), `not delivered; log: ${mine.join(', ')}`);
		assert.strictEqual(pending, 0);
		assert.deepStrictEqual(mine, ['sent#2', 'retrying#1']);
		return mine;
	});
	await check('provider disabled while a retry waits: dropped, not sent', async () => {
		execSync(`docker pause ${MM_CONTAINER}`);
		let r;
		try {
			r = await reply('Bob', ctx.solo.tid, 'Queued then disabled');
			await waitFor(async () => (await bridgeLog()).pending === 1, { timeout: 20000, what: 'a pending retry' });
			await setBridge({ mattermost_enabled: 'off' });
		} finally {
			execSync(`docker unpause ${MM_CONTAINER}`);
		}
		await waitFor(async () => (await bridgeLog()).pending === 0, { timeout: 100000, what: 'the drain' });
		const { entries } = await bridgeLog();
		await setBridge({ mattermost_enabled: 'on' });
		const mine = entries.filter(x => x.url && x.url.endsWith(`/post/${r.pid}`)).map(x => x.outcome);
		assert.deepStrictEqual(mine, ['dropped', 'retrying']);
	});
	await check('Mattermost down for a recipient not looked up yet: still queued for retry', async () => {
		// Restart NodeBB so no identity is cached, as after a deploy.
		execSync(`${__dirname}/nodebb.sh stop`);
		await sleep(2000);
		execSync(`${__dirname}/nodebb.sh start`);
		await waitFor(async () => { try { return (await fetch(`${NBB}/api/config`)).ok; } catch (e) { return false; } }, { timeout: 90000, what: 'NodeBB restart' });
		await sessions();
		Object.keys(pages).forEach((k) => { delete pages[k]; });
		const a0 = await count('alice');
		execSync(`docker pause ${MM_CONTAINER}`);
		let r;
		let pending;
		try {
			r = await reply('Bob', ctx.solo.tid, 'Down, and you were never looked up');
			await sleep(14000);
			({ pending } = await bridgeLog());
		} finally {
			execSync(`docker unpause ${MM_CONTAINER}`);
		}
		const { entries } = await bridgeLog();
		const mine = entries.filter(x => x.url && x.url.endsWith(`/post/${r.pid}`)).map(x => x.outcome);
		ctx.uncached = { pending, mine, log: nodebbLog('chatbridge') };
		assert.strictEqual(pending, 1, `not queued (pending=${pending}, delivery log: [${mine}]); NodeBB log:\n${ctx.uncached.log}`);
		await nextDm('alice', a0, 100000);
	});

	await check('ACP: the delivery log shows outcomes and readable errors', async () => {
		const page = await acp();
		await page.waitForFunction(() => document.querySelectorAll('#chatbridge-log tr').length > 1);
		const r = await page.evaluate(() => {
			const wrap = document.querySelector('.table-responsive');
			const row = [...document.querySelectorAll('#chatbridge-log tr')].find(tr => /failed/.test(tr.textContent) && tr.querySelector('.text-danger'));
			const err = row && row.querySelector('.text-danger').getBoundingClientRect();
			const box = wrap.getBoundingClientRect();
			return { overflow: wrap.scrollWidth - wrap.clientWidth, err: err && { left: err.left, right: err.right, width: err.width }, box: { left: box.left, right: box.right } };
		});
		assert.ok(r.err, 'no failed row with an error');
		assert.ok(r.overflow <= 0, `the log table overflows by ${r.overflow}px`);
		assert.ok(r.err.right <= r.box.right + 1 && r.err.width > 150, `the error is squeezed or clipped: ${JSON.stringify(r)}`);
	});

	// --------------------------------------------------------------- webhook
	// The token-less provider: a Mattermost incoming webhook, "@username" DMs.
	// Its posts arrive from the webhook's owner (mmadmin), marked from_webhook.
	const HOOK = `http://mattermost:8065/hooks/${env.HOOK_ID}`;
	const hookDms = u => dms(u, env.ADMIN_ID);
	const nextHookDm = async (u, before, timeout = 15000) => waitFor(async () => {
		const p = await hookDms(u);
		return p.length > before ? p[p.length - 1] : null;
	}, { timeout, what: `a webhook DM to ${u}` });
	await check('webhook: the ACP shows the webhook card with the default headers and body', async () => {
		await setBridge({ mattermost_enabled: 'off', webhook_enabled: 'on', webhook_url: HOOK });
		const page = await acp();
		const form = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.chatbridge-settings [name^="webhook_"]')]
			.map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value])));
		assert.deepStrictEqual(form, {
			webhook_enabled: true,
			webhook_url: HOOK,
			webhook_headers: 'Content-Type: application/json',
			webhook_body: '{"channel": "@{{username}}", "text": "{{text}}"}',
		});
		const tags = await page.evaluate(() => ['webhook_headers', 'webhook_body'].map(n => document.querySelector(`[name="${n}"]`).tagName));
		assert.deepStrictEqual(tags, ['TEXTAREA', 'TEXTAREA']);
	});
	await check('webhook: Test connection checks the settings; Send me a test message arrives', async () => {
		const page = await acp();
		const result = () => page.waitForFunction(() => {
			const t = document.querySelector('.chatbridge-result[data-provider="webhook"]').textContent;
			return t && !/…$/.test(t) && t;
		}, null, { timeout: 20000 }).then(h => h.jsonValue());
		await page.click('.chatbridge-verify[data-provider="webhook"]');
		assert.match(await result(), /^Settings look valid\. Messages go to mattermost:8065/);
		const n0 = (await hookDms('admin')).length;
		await page.click('.chatbridge-test-message[data-provider="webhook"]');
		assert.strictEqual(await result(), 'Sent. Check your direct messages.');
		const p = await nextHookDm('admin', n0);
		assert.match(p.message, /^Test message from the forum's \*\*Chat Bridge\*\*/);
	});
	await check('webhook: a reply reaches the author as a markdown DM', async () => {
		const t = await topic('alice', 'Webhook *printer* jam #2', 'Paper everywhere.');
		const a0 = (await hookDms('alice')).length;
		const r = await reply('Bob', t.tid, 'Open tray 2, then "pull" gently.\n\nLine two {"not": "json"}');
		const p = await nextHookDm('alice', a0);
		assert.strictEqual(p.message, [
			'**Bob** posted a reply in **Webhook \\*printer\\* jam \\#2**',
			`[Webhook \\*printer\\* jam \\#2](http://localhost:4567/post/${r.pid})`,
			'> Open tray 2, then "pull" gently. Line two {"not": "json"}',
		].join('\n'));
		const { entries } = await bridgeLog();
		const e = entries.find(x => x.url === `http://localhost:4567/post/${r.pid}`);
		assert.deepStrictEqual([e.outcome, e.provider], ['sent', 'webhook']);
		return p.message;
	});
	await check('webhook: a mention reaches forum "Bob" as Mattermost "@bob"', async () => {
		const b0 = (await hookDms('bob')).length;
		await topic('alice', 'Webhook mention', 'Ping @Bob please');
		const p = await nextHookDm('bob', b0);
		assert.match(p.message, /mentioned you in/);
	});
	await check('webhook: a custom body template (attachment, override username)', async () => {
		await setBridge({
			webhook_body: JSON.stringify({
				channel: '@{{username}}',
				username: 'Forum',
				attachments: [{ fallback: '{{plain}}', color: '{{color}}', pretext: '{{summary}}', title: '{{title}}', title_link: '{{url}}', text: '{{excerpt}}' }],
			}),
		});
		try {
			const t = await topic('alice', 'Webhook template', 'x');
			const a0 = (await hookDms('alice')).length;
			const r = await reply('Bob', t.tid, 'Templated');
			const a = (await nextHookDm('alice', a0)).props.attachments[0];
			assert.deepStrictEqual([a.pretext, a.title, a.title_link, a.text, a.color],
				['**Bob** posted a reply in **Webhook template**', 'Webhook template', `http://localhost:4567/post/${r.pid}`, 'Templated', '#1e88e5']);
		} finally {
			await setBridge({ webhook_body: '{"channel": "@{{username}}", "text": "{{text}}"}' });
		}
	});
	await check('webhook: a forum user with no chat account is logged as failed, not retried', async () => {
		const t = await topic('nobody', 'Webhook to nobody', 'x');
		const r = await reply('Bob', t.tid, 'You are not in chat');
		const e = await waitFor(async () => (await bridgeLog()).entries.find(x => x.url === `http://localhost:4567/post/${r.pid}`), { what: 'a log entry' });
		assert.deepStrictEqual([e.outcome, e.provider], ['failed', 'webhook']);
		assert.match(e.error, /400/);
		assert.strictEqual((await bridgeLog()).pending, 0);
	});
	await setBridge({ mattermost_enabled: 'on', webhook_enabled: 'off' });

	const passed = results.filter(r => r.ok && !r.skipped).length;
	const skipped = results.filter(r => r.skipped).length;
	console.log(`\n${passed}/${results.length - skipped} passed${skipped ? `, ${skipped} skipped` : ''}`);
	fs.writeFileSync(`${WORK}/results.json`, JSON.stringify({ results, evidence, ctx }, null, 2));
	await browser.close();
	process.exitCode = results.some(r => !r.ok) ? 1 : 0;
})().catch(async (e) => { console.error('FATAL', e); fs.writeFileSync(`${WORK}/results.json`, JSON.stringify({ results, evidence, ctx, fatal: e.message }, null, 2)); if (browser) await browser.close(); process.exit(1); });
