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

test('refs: Shotef notices take the ticket from card=, never a team or reminder id', () => {
	// The ticket-specific notices link to the card.
	assert.deepStrictEqual(Events.refs({ nid: 'shotef:assign:42:7', path: '/shotef?team=sup&card=42' }), { tid: 42, pid: 0 });
	// Reminder ids are UUIDs; one starting with digits is not a topic id.
	assert.deepStrictEqual(Events.refs({ nid: 'shotef:reminder:117aa971-98eb-4bf8-8b6b-2bc0db4466b1', path: '/shotef?team=sup&card=17' }), { tid: 17, pid: 0 });
	assert.deepStrictEqual(Events.refs({ nid: 'shotef:reminder:71608b1d-098d-4182-b56a-29f2ba05072c', path: '/shotef' }), { tid: 0, pid: 0 });
	// Shift notices are about a team, whose id may be numeric.
	assert.deepStrictEqual(Events.refs({ nid: 'shotef:handover:1:9', path: '/shotef?team=1' }), { tid: 0, pid: 0 });
	assert.deepStrictEqual(Events.refs({ nid: 'shotef:vacant:42:2026-11-06', path: '/shotef?team=42' }), { tid: 0, pid: 0 });
	// Ticket nids still work without a path.
	assert.deepStrictEqual(Events.refs({ nid: 'shotef:help:42' }), { tid: 42, pid: 0 });
	assert.deepStrictEqual(Events.refs({ nid: 'shotef:pass:42:support' }), { tid: 42, pid: 0 });
});

test('inline tags do not split words; block tags do', () => {
	// NodeBB renders a mention as @<bdi>Bob</bdi> inside a link.
	const mention = '<p dir="auto">Hey <a class="plugin-mentions-user" href="/user/bob">@<bdi>Bob</bdi></a> can you look?</p>';
	assert.strictEqual(Message.excerpt(mention, 300), 'Hey @Bob can you look?');
	assert.strictEqual(Message.excerpt('<p>Try <a href="https://x">the guide</a>?</p><p>Next</p>', 300), 'Try the guide? Next');
	assert.strictEqual(Message.plain('Line one<br>line <em>two</em>'), 'Line one line two');
});

test('htmlToMarkdownLine escapes forum text, so a title cannot add links or emphasis', () => {
	const md = Message.htmlToMarkdownLine('<strong>j_doe</strong> posted in <strong>[Reset](https://evil.example) *now* `x` #1 a|b</strong>');
	assert.strictEqual(md, '**j\\_doe** posted in **\\[Reset\\](https://evil.example) \\*now\\* \\`x\\` \\#1 a\\|b**');
	assert.strictEqual(Message.markdownToPlain(md), 'j_doe posted in [Reset](https://evil.example) *now* `x` #1 a|b');
	assert.strictEqual(Message.htmlToMarkdownLine('a &lt;b&gt; c'), 'a \\<b\\> c');
	// URLs are autolinked as they are: escaping inside one would change it.
	assert.strictEqual(
		Message.escapeMarkdown('see https://example.com/a_b/c*d?x=1_2, www.example.org/x_y and a_b'),
		'see https://example.com/a_b/c*d?x=1_2, www.example.org/x_y and a\\_b',
	);
	// ...but a URL can't carry link syntax past the escaping.
	assert.strictEqual(Message.escapeMarkdown('https://a.example/[x](https://evil.example)'), 'https://a.example/\\[x\\](https://evil.example)');
	const withUrl = Message.htmlToMarkdownLine('<strong>bob</strong> in <strong>See https://x.example/a_b</strong>');
	assert.strictEqual(withUrl, '**bob** in **See https://x.example/a_b**');
	assert.strictEqual(Message.markdownToPlain(withUrl), 'bob in See https://x.example/a_b');
	// A summary that falls back to the title is escaped too.
	assert.strictEqual(Message.compose({ event: 'other', bodyHtml: '', title: '**x**', baseUrl: 'https://f', path: '/' }).summary, '\\*\\*x\\*\\*');
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
