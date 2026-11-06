'use strict';

const test = require('node:test');
const assert = require('node:assert');

const Events = require('../lib/events');
const Message = require('../lib/message');

test('classify: core types and Shotef', () => {
	assert.strictEqual(Events.classify({ type: 'new-reply', nid: 'new_post:tid:1:pid:2:uid:3' }), 'reply');
	assert.strictEqual(Events.classify({ type: 'mention' }), 'mention');
	assert.strictEqual(Events.classify({ type: 'new-topic' }), 'topic');
	assert.strictEqual(Events.classify({ type: 'shotef', nid: 'shotef:status:42:answered' }), 'ticket_status');
	assert.strictEqual(Events.classify({ type: 'shotef', nid: 'shotef:assign:42:7' }), 'ticket_team');
	assert.strictEqual(Events.classify({ type: 'follow' }), 'other');
	assert.strictEqual(Events.classify(null), 'other');
});

test('ticketStage reads Shotef status nids, including closed-no-response', () => {
	assert.strictEqual(Events.ticketStage({ nid: 'shotef:status:42:closed-no-response' }), 'closed-no-response');
	assert.strictEqual(Events.ticketStage({ nid: 'shotef:status:42:in_progress' }), 'in_progress');
	assert.strictEqual(Events.ticketStage({ nid: 'shotef:assign:42' }), null);
});

test('refs: fields win, then path, then Shotef nid', () => {
	assert.deepStrictEqual(Events.refs({ tid: 5, pid: 9 }), { tid: 5, pid: 9 });
	assert.deepStrictEqual(Events.refs({ path: '/post/9' }), { tid: 0, pid: 9 });
	assert.deepStrictEqual(Events.refs({ path: '/topic/12/some-slug' }), { tid: 12, pid: 0 });
	assert.deepStrictEqual(Events.refs({ nid: 'shotef:status:42:answered', path: '/shotef' }), { tid: 42, pid: 0 });
	assert.deepStrictEqual(Events.refs({ tid: 'abc', path: '' }), { tid: 0, pid: 0 });
});

test('htmlToMarkdownLine keeps bold, drops tags, decodes entities', () => {
	assert.strictEqual(
		Message.htmlToMarkdownLine('<strong>alice</strong> has posted a reply to: <strong>Can&#x27;t sign in &amp; &quot;reset&quot;</strong>'),
		'**alice** has posted a reply to: **Can\'t sign in & "reset"**'
	);
	assert.strictEqual(Message.htmlToMarkdownLine('<span class="x">a\n  b</span>'), 'a b');
});

test('excerpt drops quotes and code, keeps link text, truncates on a word', () => {
	const md = '> what you wrote\n\nTry [the guide](https://x/y) first.\n\n```\nsecret code\n```\n![pic](a.png)';
	assert.strictEqual(Message.excerpt(md, 300), 'Try the guide first. [code] [image]');
	const html = '<blockquote><p>old</p></blockquote><p>New &amp; improved</p>';
	assert.strictEqual(Message.excerpt(html, 300), 'New & improved');
	const long = 'word '.repeat(100);
	const out = Message.excerpt(long, 50);
	assert.ok(out.length <= 51 && out.endsWith('…'), out);
	assert.strictEqual(Message.excerpt('anything', 0), '');
});

test('absoluteUrl joins base and path', () => {
	assert.strictEqual(Message.absoluteUrl('https://f.example/', '/post/3'), 'https://f.example/post/3');
	assert.strictEqual(Message.absoluteUrl('https://f.example/forum', 'topic/3'), 'https://f.example/forum/topic/3');
	assert.strictEqual(Message.absoluteUrl('https://f.example', 'https://other/x'), 'https://other/x');
});

test('compose: status messages carry the stage colour and no excerpt', () => {
	const m = Message.compose({
		event: 'ticket_status', bodyHtml: 'Support replied', title: 'Printer &amp; fire',
		baseUrl: 'https://f', path: '/topic/4', content: 'should not appear', excerptLength: 300, stage: 'answered',
	});
	assert.deepStrictEqual(m, {
		event: 'ticket_status', summary: 'Support replied', title: 'Printer & fire',
		url: 'https://f/topic/4', excerpt: '', stage: 'answered', color: Message.COLORS.answered,
	});
});
