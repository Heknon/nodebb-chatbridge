'use strict';

// The Mattermost provider against a fake Mattermost HTTP server.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const Mattermost = require('../lib/providers/mattermost');
const { RetryableError, PermanentError } = require('../lib/errors');

const TOKEN = 'bot-token';

function fakeMattermost() {
	const mm = {
		users: {
			bot: { id: 'bot1', username: 'chatbridge', is_bot: true, delete_at: 0 },
			alice: { id: 'u-alice', username: 'alice', email: 'alice@corp.example', delete_at: 0 },
			gone: { id: 'u-gone', username: 'gone', email: 'gone@corp.example', delete_at: 1700000000000 },
		},
		requests: [],
		posts: [],
		channels: 0,
		failNext: null, // { status, headers? }
	};
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => { raw += c; });
		req.on('end', () => {
			const body = raw ? JSON.parse(raw) : null;
			mm.requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
			const send = (status, obj, headers = {}) => {
				res.writeHead(status, { 'content-type': 'application/json', ...headers });
				res.end(JSON.stringify(obj));
			};
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { id: 'api.context.session_expired.app_error', message: 'Invalid or expired session' });
			if (mm.failNext) { const f = mm.failNext; mm.failNext = null; return send(f.status, { message: 'nope' }, f.headers); }
			const byName = Object.values(mm.users);
			let m;
			if (req.method === 'GET' && req.url === '/api/v4/users/me') return send(200, mm.users.bot);
			if (req.method === 'GET' && (m = /^\/api\/v4\/users\/username\/(.+)$/.exec(req.url))) {
				const u = byName.find(x => x.username === decodeURIComponent(m[1]));
				return u ? send(200, u) : send(404, { message: 'not found' });
			}
			if (req.method === 'GET' && (m = /^\/api\/v4\/users\/email\/(.+)$/.exec(req.url))) {
				const u = byName.find(x => x.email === decodeURIComponent(m[1]));
				return u ? send(200, u) : send(404, { message: 'not found' });
			}
			if (req.method === 'POST' && req.url === '/api/v4/channels/direct') {
				mm.channels += 1;
				return send(201, { id: `dm-${body.slice().sort().join('-')}`, type: 'D' });
			}
			if (req.method === 'POST' && req.url === '/api/v4/posts') {
				mm.posts.push(body);
				return send(201, { id: `post${mm.posts.length}`, ...body });
			}
			return send(404, { message: 'no route' });
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			mm.url = `http://127.0.0.1:${server.address().port}`;
			mm.close = () => new Promise(r => server.close(r));
			resolve(mm);
		});
	});
}

let mm;
let cfg;
test.before(async () => { mm = await fakeMattermost(); cfg = { url: `${mm.url}/`, token: TOKEN, match: 'username' }; });
test.after(() => mm.close());
test.beforeEach(() => { Mattermost.reset(); mm.requests.length = 0; mm.posts.length = 0; mm.channels = 0; });

test('configured() names what is missing', () => {
	assert.match(Mattermost.configured({ token: 'x' }), /Server URL/);
	assert.match(Mattermost.configured({ url: 'chat.example', token: 'x' }), /http/);
	assert.match(Mattermost.configured({ url: 'https://chat.example' }), /token/);
	assert.strictEqual(Mattermost.configured({ url: 'https://chat.example', token: 'x' }), '');
});

test('verify returns the bot identity', async () => {
	assert.deepStrictEqual(await Mattermost.verify(cfg), { id: 'bot1', name: 'chatbridge', isBot: true });
});

test('a bad token is a permanent error with Mattermost\'s reason', async () => {
	await assert.rejects(Mattermost.verify({ ...cfg, token: 'wrong' }), (err) => {
		assert.ok(err instanceof PermanentError);
		assert.match(err.message, /401.*Invalid or expired session/);
		return true;
	});
});

test('findUser by username: lowercased, deactivated users do not match', async () => {
	assert.strictEqual(await Mattermost.findUser(cfg, { username: 'Alice' }, 'username'), 'u-alice');
	assert.strictEqual(await Mattermost.findUser(cfg, { username: 'gone' }, 'username'), null);
	assert.strictEqual(await Mattermost.findUser(cfg, { username: 'nobody' }, 'username'), null);
});

test('findUser falls back to email only when asked to', async () => {
	const who = { username: 'a.smith', email: 'alice@corp.example' };
	assert.strictEqual(await Mattermost.findUser(cfg, who, 'username'), null);
	assert.strictEqual(await Mattermost.findUser(cfg, who, 'username,email'), 'u-alice');
	assert.strictEqual(await Mattermost.findUser(cfg, { username: 'alice', email: '' }, 'email'), null);
});

test('send opens the DM once, then posts an attachment', async () => {
	const message = {
		event: 'reply', summary: '**bob** has posted a reply to: **VPN down**', title: 'VPN down',
		url: 'https://forum/post/9', excerpt: 'Try reconnecting', color: '#1e88e5',
	};
	await Mattermost.send(cfg, 'u-alice', message);
	await Mattermost.send(cfg, 'u-alice', message);
	assert.strictEqual(mm.channels, 1, 'DM channel is cached');
	assert.deepStrictEqual(mm.requests.find(r => r.url === '/api/v4/channels/direct').body, ['bot1', 'u-alice']);
	assert.strictEqual(mm.posts.length, 2);
	const post = mm.posts[0];
	assert.strictEqual(post.channel_id, 'dm-bot1-u-alice');
	assert.deepStrictEqual(post.props.attachments[0], {
		fallback: 'bob has posted a reply to: VPN down https://forum/post/9',
		color: '#1e88e5',
		pretext: '**bob** has posted a reply to: **VPN down**',
		title: 'VPN down',
		title_link: 'https://forum/post/9',
		text: '> Try reconnecting',
	});
});

test('render escapes forum text in markdown fields; the fallback is plain', () => {
	const { escapeMarkdown, htmlToMarkdownLine } = require('../lib/message');
	const evil = '[Reset your password](https://evil.example) **now**';
	const a = Mattermost.render({
		summary: htmlToMarkdownLine(`<strong>bob</strong> posted a reply in <strong>${evil}</strong>`),
		title: evil,
		url: 'https://forum/post/9',
		excerpt: 'see [this](https://evil.example)\n# not a heading',
	}, 'ch').props.attachments[0];
	const esc = escapeMarkdown(evil);
	assert.strictEqual(esc, '\\[Reset your password\\](https://evil.example) \\*\\*now\\*\\*');
	assert.strictEqual(a.pretext, `**bob** posted a reply in **${esc}**`);
	assert.strictEqual(a.title, esc);
	assert.strictEqual(a.text, '> see \\[this\\](https://evil.example)\n> \\# not a heading');
	assert.strictEqual(a.fallback, `bob posted a reply in ${evil} https://forum/post/9`);
});

test('429 is retryable and carries the wait', async () => {
	await Mattermost.send(cfg, 'u-alice', { summary: 'x' }); // warm caches
	mm.failNext = { status: 429, headers: { 'x-ratelimit-reset': '7' } };
	await assert.rejects(Mattermost.send(cfg, 'u-alice', { summary: 'x' }), (err) => {
		assert.ok(err instanceof RetryableError);
		assert.strictEqual(err.retryAfterMs, 7000);
		return true;
	});
});

test('5xx is retryable, 400 is permanent', async () => {
	await Mattermost.send(cfg, 'u-alice', { summary: 'x' });
	mm.failNext = { status: 503 };
	await assert.rejects(Mattermost.send(cfg, 'u-alice', { summary: 'x' }), RetryableError);
	mm.failNext = { status: 400 };
	await assert.rejects(Mattermost.send(cfg, 'u-alice', { summary: 'x' }), PermanentError);
});

test('an unreachable server is retryable', async () => {
	await assert.rejects(Mattermost.verify({ url: 'http://127.0.0.1:1', token: TOKEN }), RetryableError);
});
