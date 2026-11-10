'use strict';

// The webhook provider against a fake incoming-webhook server, and through the
// relay (a pushed notification -> one POST with the filled-in body).

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { state } = require('./stub');

const Webhook = require('../lib/providers/webhook');
const Providers = require('../lib/providers');
const Settings = require('../lib/settings');
const Identity = require('../lib/identity');
const Relay = require('../lib/relay');
const { RetryableError, PermanentError } = require('../lib/errors');

function fakeHook() {
	const hook = { requests: [], failNext: null };
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => { raw += c; });
		req.on('end', () => {
			hook.requests.push({ method: req.method, url: req.url, headers: req.headers, raw, body: JSON.parse(raw) });
			if (hook.failNext) {
				const f = hook.failNext;
				hook.failNext = null;
				res.writeHead(f.status, { 'content-type': 'application/json', ...(f.headers || {}) });
				return res.end(JSON.stringify({ id: 'web.incoming_webhook.user.app_error', message: f.message || 'nope' }));
			}
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('ok');
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			hook.url = `http://127.0.0.1:${server.address().port}/hooks/abc123`;
			hook.close = () => new Promise(r => server.close(r));
			resolve(hook);
		});
	});
}

let hook;
let cfg;
test.before(async () => {
	hook = await fakeHook();
	cfg = { url: hook.url, headers: Webhook.DEFAULT_HEADERS, body: Webhook.DEFAULT_BODY, match: 'username' };
});
test.after(() => hook.close());
test.beforeEach(() => { hook.requests.length = 0; });

const message = {
	event: 'reply',
	summary: '**bob** has posted a reply to: **VPN down**',
	title: 'VPN down',
	url: 'https://forum/post/9',
	excerpt: 'Try "reconnecting"\n{"json": true}',
	stage: null,
	color: '#1e88e5',
};

test('configured() checks the URL, headers and body', () => {
	assert.match(Webhook.configured({}), /Webhook URL/);
	assert.match(Webhook.configured({ url: 'chat.example/hooks/x' }), /http/);
	assert.strictEqual(Webhook.configured({ url: 'https://chat.example/hooks/x' }), '', 'defaults are valid');
	assert.match(Webhook.configured({ url: 'https://x', body: '{"channel": "@{{username}}",' }), /Body is not valid JSON/);
	assert.match(Webhook.configured({ url: 'https://x', headers: 'Content-Type application/json' }), /Name: value/);
	assert.match(Webhook.configured({ url: 'https://x', headers: '{"a": ' }), /Headers are not valid JSON/);
});

test('headers: "Name: value" lines or a JSON object', () => {
	assert.deepStrictEqual(Webhook.parseHeaders('Content-Type: application/json\n\nX-Token:  a:b '), {
		'Content-Type': 'application/json', 'X-Token': 'a:b',
	});
	assert.deepStrictEqual(Webhook.parseHeaders('{"Content-Type": "application/json", "X-N": 5}'), {
		'Content-Type': 'application/json', 'X-N': '5',
	});
	assert.deepStrictEqual(Webhook.parseHeaders(''), {});
});

test('the markdown text: summary, link, quoted excerpt; forum text escaped', () => {
	assert.strictEqual(Webhook.text(message), [
		'**bob** has posted a reply to: **VPN down**',
		'[VPN down](https://forum/post/9)',
		'> Try "reconnecting"',
		'> {"json": true}',
	].join('\n'));
	assert.strictEqual(Webhook.text({ summary: 'Hi', url: 'https://forum/' }), 'Hi\n[Open on the forum](https://forum/)');
	assert.strictEqual(Webhook.text({ summary: 'x', title: '[evil](https://e) **now**', url: 'https://f/1' }),
		'x\n[\\[evil\\](https://e) \\*\\*now\\*\\*](https://f/1)');
});

test('send POSTs the default body: a DM to @username with the markdown text', async () => {
	await Webhook.send(cfg, 'alice', message);
	assert.strictEqual(hook.requests.length, 1);
	const r = hook.requests[0];
	assert.strictEqual(r.method, 'POST');
	assert.strictEqual(r.url, '/hooks/abc123');
	assert.strictEqual(r.headers['content-type'], 'application/json');
	assert.strictEqual(r.headers.authorization, undefined, 'no token');
	assert.deepStrictEqual(r.body, { channel: '@alice', text: Webhook.text(message) });
});

test('a custom template: any placeholder, nested values, custom headers', async () => {
	await Webhook.send({
		...cfg,
		headers: 'Content-Type: application/json\nX-Secret: s3cr3t',
		body: JSON.stringify({
			channel: '@{{ username }}',
			username: 'Forum',
			text: '{{summary}}',
			attachments: [{ fallback: '{{plain}}', color: '{{color}}', title: '{{title}}', title_link: '{{url}}', text: '{{excerpt}}' }],
			props: { event: '{{event}}', stage: '{{stage}}', keep: '{{unknown}}', n: 3, on: true, none: null },
		}),
	}, 'bob', message);
	const r = hook.requests[0];
	assert.strictEqual(r.headers['x-secret'], 's3cr3t');
	assert.deepStrictEqual(r.body, {
		channel: '@bob',
		username: 'Forum',
		text: message.summary,
		attachments: [{
			fallback: 'bob has posted a reply to: VPN down https://forum/post/9',
			color: '#1e88e5',
			title: 'VPN down',
			title_link: 'https://forum/post/9',
			text: message.excerpt,
		}],
		props: { event: 'reply', stage: '', keep: '{{unknown}}', n: 3, on: true, none: null },
	});
});

test('Content-Type defaults to JSON when the headers leave it out', async () => {
	await Webhook.send({ ...cfg, headers: 'X-A: 1' }, 'alice', message);
	assert.strictEqual(hook.requests[0].headers['content-type'], 'application/json');
});

test('findUser is the forum username, lowercased; nobody without one', async () => {
	assert.strictEqual(await Webhook.findUser(cfg, { username: 'Bob' }, 'username'), 'bob');
	assert.strictEqual(await Webhook.findUser(cfg, { username: '' }, 'username'), null);
});

test('verify checks the settings without sending anything', async () => {
	const r = await Webhook.verify(cfg);
	assert.strictEqual(r.name, new URL(hook.url).host);
	assert.match(r.message, /Settings look valid/);
	assert.strictEqual(hook.requests.length, 0);
	await assert.rejects(Webhook.verify({ ...cfg, body: 'nope' }), PermanentError);
});

test('errors: 400 is permanent with the server\'s reason, 5xx and 429 retry, unreachable retries', async () => {
	hook.failNext = { status: 400, message: 'Unable to find the user.' };
	await assert.rejects(Webhook.send(cfg, 'nobody', message), (err) => {
		assert.ok(err instanceof PermanentError);
		assert.match(err.message, /400 \(Unable to find the user\.\)/);
		return true;
	});
	hook.failNext = { status: 503 };
	await assert.rejects(Webhook.send(cfg, 'alice', message), RetryableError);
	hook.failNext = { status: 429, headers: { 'retry-after': '7' } };
	await assert.rejects(Webhook.send(cfg, 'alice', message), err => err instanceof RetryableError && err.retryAfterMs === 7000);
	await assert.rejects(Webhook.send({ ...cfg, url: 'http://127.0.0.1:1/hooks/x' }, 'alice', message), RetryableError);
});

test('relay: a pushed reply notification reaches the webhook as a DM to the username', async () => {
	Providers.clear();
	Providers.register(Webhook);
	Object.keys(state.settings).forEach((k) => { delete state.settings[k]; });
	Object.assign(state.settings, { webhook_enabled: 'on', webhook_url: hook.url });
	await Settings.storeDefaults(Providers.list());
	assert.strictEqual(state.settings.webhook_body, Webhook.DEFAULT_BODY, 'defaults stored for the ACP');
	assert.strictEqual(state.settings.webhook_headers, Webhook.DEFAULT_HEADERS);
	Settings.invalidate();
	Identity.clear();
	Relay.clearDedupe();
	state.users[1] = { uid: 1, username: 'Alice', email: 'alice@corp', 'email:confirmed': 1 };
	state.topics[10] = { title: 'Printer on fire' };
	state.posts[100] = { tid: 10, content: 'Have you tried turning it off?' };

	const result = await Relay.handle({
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
		},
		uidsNotified: [1],
	});
	assert.strictEqual(result.sent, 1, JSON.stringify(result));
	assert.strictEqual(hook.requests.length, 1);
	const { body } = hook.requests[0];
	assert.strictEqual(body.channel, '@alice');
	assert.match(body.text, /\[Printer on fire\]\(https:\/\/forum\.example\.com\/post\/100\)/);
	assert.match(body.text, /^> Have you tried turning it off\?$/m);
});
