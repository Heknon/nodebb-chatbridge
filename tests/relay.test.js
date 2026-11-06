'use strict';

// The relay end to end inside the plugin: a pushed notification -> provider.send,
// with a fake provider. NodeBB is the stub in ./stub.js.

const test = require('node:test');
const assert = require('node:assert');

const { state } = require('./stub');

const Providers = require('../lib/providers');
const Settings = require('../lib/settings');
const Identity = require('../lib/identity');
const Relay = require('../lib/relay');
const Outbox = require('../lib/outbox');
const { RetryableError, PermanentError } = require('../lib/errors');

const fake = {
	id: 'fake',
	label: 'Fake chat',
	defaultMatch: 'username',
	fields: [{ key: 'token', label: 'Token', required: true }],
	sent: [],
	failures: [], // errors to throw on the next sends, in order
	lookups: 0,
	async verify() { return { name: 'bot' }; },
	async findUser(cfg, u, strategy) {
		fake.lookups += 1;
		const directory = { alice: 'ext-alice', bob: 'ext-bob', carol: 'ext-carol' };
		if (strategy.includes('username') && directory[u.username]) return directory[u.username];
		if (strategy.includes('email') && u.email === 'dave@corp') return 'ext-dave';
		return null;
	},
	async send(cfg, id, message) {
		if (fake.failures.length) throw fake.failures.shift();
		fake.sent.push({ id, message });
	},
};

Providers.register(fake);

const reply = (over = {}) => ({
	notification: {
		type: 'new-reply',
		nid: 'new_post:tid:10:pid:100:uid:2',
		datetime: Date.now(),
		bodyShort: '[[notifications:user-posted-to, bob, Printer on fire]]',
		bodyLong: '<p>Have you tried turning it off?</p>',
		path: '/post/100',
		tid: 10,
		pid: 100,
		from: 2,
		...over,
	},
	uidsNotified: [1],
	uidsEmailed: [],
});

test.beforeEach(() => {
	state.reset();
	Settings.invalidate();
	Identity.clear();
	Relay.clearDedupe();
	fake.sent.length = 0;
	fake.failures.length = 0;
	fake.lookups = 0;
	state.settings = { fake_enabled: 'on', fake_token: 't', fake_match: 'username' };
	state.users = {
		1: { uid: 1, username: 'alice', email: 'alice@corp', 'email:confirmed': 1 },
		2: { uid: 2, username: 'bob' },
		3: { uid: 3, username: 'carol' },
		4: { uid: 4, username: 'dave.x', email: 'dave@corp', 'email:confirmed': 1 },
		5: { uid: 5, username: 'nobody' },
		6: { uid: 6, username: 'he-user', userLang: 'he' },
	};
	state.topics = { 10: { title: 'Printer on fire' }, 11: { title: 'Secret', readers: [3] } };
	state.posts = { 100: { tid: 10, content: 'Have you tried turning it off?' } };
});

test('a reply reaches the follower as a DM with title, link and excerpt', async () => {
	const r = await Relay.handle(reply());
	assert.strictEqual(r.sent, 1);
	assert.strictEqual(fake.sent.length, 1);
	assert.deepStrictEqual(fake.sent[0], {
		id: 'ext-alice',
		message: {
			event: 'reply',
			summary: '**bob** has posted a reply to: **Printer on fire**',
			title: 'Printer on fire',
			url: 'https://forum.example.com/post/100',
			excerpt: 'Have you tried turning it off?',
			stage: null,
			color: '#1e88e5',
		},
	});
	const [entry] = await Outbox.recent(5);
	assert.strictEqual(entry.outcome, 'sent');
	assert.strictEqual(entry.uid, 1);
});

test('everyone NodeBB notified gets it, email-only recipients included', async () => {
	const data = reply();
	data.uidsNotified = [1, 3];
	data.uidsEmailed = [3, 4];
	state.settings.fake_match = 'username,email';
	const r = await Relay.handle(data);
	assert.strictEqual(r.sent, 3);
	assert.deepStrictEqual(fake.sent.map(s => s.id).sort(), ['ext-alice', 'ext-carol', 'ext-dave']);
});

test('a Shotef status change carries the stage and the user\'s language', async () => {
	const data = {
		notification: {
			type: 'shotef', nid: 'shotef:status:10:answered', datetime: Date.now(),
			bodyShort: '[[shotef:notif-status-answered]]', path: '/topic/10', from: 2,
		},
		uidsNotified: [1, 6],
	};
	state.users[6].username = 'carol'; // matched to ext-carol
	await Relay.handle(data);
	const byId = Object.fromEntries(fake.sent.map(s => [s.id, s.message]));
	assert.strictEqual(byId['ext-alice'].event, 'ticket_status');
	assert.strictEqual(byId['ext-alice'].stage, 'answered');
	assert.strictEqual(byId['ext-alice'].title, 'Printer on fire');
	assert.strictEqual(byId['ext-alice'].url, 'https://forum.example.com/topic/10');
	assert.strictEqual(byId['ext-alice'].excerpt, '');
	assert.strictEqual(byId['ext-carol'].summary, 'צוות התמיכה ענה');
});

test('a recipient who can no longer read the topic gets nothing', async () => {
	const data = reply({ tid: 11, path: '/post/101', pid: 101 });
	data.uidsNotified = [1, 3];
	const r = await Relay.handle(data);
	assert.strictEqual(r.hidden, 1);
	assert.deepStrictEqual(fake.sent.map(s => s.id), ['ext-carol']);
});

test('the tid is found from the pid when the notification lacks it', async () => {
	await Relay.handle(reply({ tid: undefined }));
	assert.strictEqual(fake.sent[0].message.title, 'Printer on fire');
});

test('unmatched users are skipped, and the miss is cached', async () => {
	const data = reply();
	data.uidsNotified = [5];
	assert.strictEqual((await Relay.handle(data)).unmatched, 1);
	await Relay.handle(reply({ datetime: Date.now() + 1 }));
	const again = reply({ datetime: Date.now() + 2 });
	again.uidsNotified = [5];
	await Relay.handle(again);
	assert.strictEqual(fake.lookups, 2, 'uid 5 looked up once, uid 1 once');
});

test('a disabled event, a disabled provider, or a missing token sends nothing', async () => {
	state.settings.event_reply = 'off';
	assert.match((await Relay.handle(reply())).skipped, /event reply off/);
	Settings.invalidate();
	state.settings.event_reply = 'on';
	state.settings.fake_enabled = 'off';
	assert.match((await Relay.handle(reply())).skipped, /no provider/);
	Settings.invalidate();
	state.settings.fake_enabled = 'on';
	state.settings.fake_token = '';
	assert.match((await Relay.handle(reply())).skipped, /no provider/);
	assert.strictEqual(fake.sent.length, 0);
});

test('"other" notifications are off by default', async () => {
	const r = await Relay.handle({ notification: { type: 'follow', nid: 'follow:1', bodyShort: 'x' }, uidsNotified: [1] });
	assert.match(r.skipped, /event other off/);
});

test('the same push twice is sent once; the same nid at a later time is sent again', async () => {
	const data = reply();
	await Relay.handle(data);
	await Relay.handle(data);
	assert.strictEqual(fake.sent.length, 1);
	await Relay.handle(reply({ datetime: data.notification.datetime + 1000 }));
	assert.strictEqual(fake.sent.length, 2);
});

test('a retryable failure is queued and delivered by the drain', async () => {
	fake.failures.push(new RetryableError('down', { retryAfterMs: 5000 }));
	const r = await Relay.handle(reply());
	assert.strictEqual(r.retrying, 1);
	assert.strictEqual(await Outbox.pending(), 1);

	assert.strictEqual(await Outbox.drain(Date.now()), 0, 'not due yet');
	assert.strictEqual(await Outbox.drain(Date.now() + Outbox.BASE_DELAY_MS + 1), 1);
	assert.strictEqual(await Outbox.pending(), 0);
	assert.strictEqual(fake.sent.length, 1);
	const outcomes = (await Outbox.recent(5)).map(e => e.outcome);
	assert.deepStrictEqual(outcomes, ['sent', 'retrying']);
});

test('a permanent failure is logged, not retried', async () => {
	fake.failures.push(new PermanentError('Mattermost POST /posts → 403'));
	const r = await Relay.handle(reply());
	assert.strictEqual(r.failed, 1);
	assert.strictEqual(await Outbox.pending(), 0);
	const [entry] = await Outbox.recent(1);
	assert.strictEqual(entry.outcome, 'failed');
	assert.match(entry.error, /403/);
});

test('retries stop after MAX_ATTEMPTS', async () => {
	for (let i = 0; i < Outbox.MAX_ATTEMPTS; i += 1) fake.failures.push(new RetryableError('down'));
	await Relay.handle(reply());
	let t = Date.now();
	for (let i = 1; i < Outbox.MAX_ATTEMPTS; i += 1) {
		t += Outbox.MAX_DELAY_MS + 1;
		// eslint-disable-next-line no-await-in-loop
		await Outbox.drain(t);
	}
	assert.strictEqual(await Outbox.pending(), 0);
	assert.strictEqual((await Outbox.recent(1))[0].outcome, 'failed');
	assert.strictEqual(fake.sent.length, 0);
});

test('backoff doubles, is capped, and honours the provider\'s wait', () => {
	assert.strictEqual(Outbox.backoff(1), Outbox.BASE_DELAY_MS);
	assert.strictEqual(Outbox.backoff(2), Outbox.BASE_DELAY_MS * 2);
	assert.strictEqual(Outbox.backoff(30), Outbox.MAX_DELAY_MS);
	assert.strictEqual(Outbox.backoff(1, 120000), 120000);
});

test('the hook never throws into NodeBB', async () => {
	const r = await Relay.onNotificationPushed({ notification: { type: 'new-reply', nid: 'x' }, get uidsNotified() { throw new Error('boom'); } });
	assert.strictEqual(r.error, 'boom');
	assert.ok(state.logs.some(([lvl, m]) => lvl === 'error' && /boom/.test(m)));
});

test('storeDefaults fills only what was never saved', async () => {
	state.settings = { event_topic: 'on' };
	await Settings.storeDefaults(Providers.list());
	assert.strictEqual(state.settings.event_topic, 'on');
	assert.strictEqual(state.settings.event_reply, 'on');
	assert.strictEqual(state.settings.event_other, 'off');
	assert.strictEqual(state.settings.fake_enabled, 'off');
	assert.strictEqual(state.settings.fake_match, 'username');
});
