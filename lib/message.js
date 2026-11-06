'use strict';

// The provider-neutral message. Each provider renders it its own way (a
// Mattermost attachment, a Slack block, ...). Pure: no IO, so it is unit-tested.
//
// {
//   event:   'reply' | 'ticket_status' | ...      (lib/events.js)
//   summary: one line, light markdown (**bold**)   e.g. "**alice** has posted a reply to: **Printer on fire**"
//            forum text in it is escaped; markdownToPlain() gives the plain line
//   title:   topic title, plain text (providers escape it if they render markdown)
//   url:     absolute link to the post / topic
//   excerpt: plain text, possibly '' (reply body, trimmed)
//   stage:   Shotef public stage for ticket_status, else null
//   color:   hex accent
// }

const Message = module.exports;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

Message.decodeEntities = function (s) {
	return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
		if (e[0] === '#') {
			const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : all;
		}
		const v = ENTITIES[e.toLowerCase()];
		return v === undefined ? all : v;
	});
};

// Tags that separate words. Inline ones (a, bdi, span, strong, ...) don't:
// NodeBB renders a mention as `@<bdi>Bob</bdi>`, which must stay "@Bob".
const BLOCK_TAGS = new Set([
	'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
	'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const TAG = /<\s*\/?\s*([a-z][a-z0-9]*)\b[^>]*>|<[^>]*>/gi;

const tagName = tag => ((/^<\s*\/?\s*([a-z][a-z0-9]*)/i.exec(tag) || [])[1] || '').toLowerCase();

Message.stripTags = function (html) {
	return String(html || '').replace(TAG, (all, name) => (name && BLOCK_TAGS.has(name.toLowerCase()) ? ' ' : ''));
};

// A bare URL, which chat autolinks as it stands: escaping inside it would
// change the link (Mattermost turns `a\_b` into `a/_b`). It stops before
// brackets and backticks, so it can't carry link syntax, and before the
// trailing punctuation GFM leaves out of autolinks (so `**` after it is ours).
const URL_TOKEN = /((?:https?:\/\/|www\.)[^\s<>[\]`|]*[^\s<>[\]`|*_~.,:;!?'")])/i;

// Text from the forum (titles, usernames, post excerpts) goes into chat
// markdown. Escape it, so a topic titled "[Reset your password](https://evil)"
// stays text and is not rendered as a link in a message from the forum's bot.
Message.escapeMarkdown = function (text) {
	return String(text || '').split(URL_TOKEN)
		.map((part, i) => (i % 2 ? part : part.replace(/[\\`*_~[\]#<>|]/g, '\\$&')))
		.join('');
};

// Light markdown (as htmlToMarkdownLine writes it) -> plain text: drops the
// emphasis it added and undoes its escapes.
Message.markdownToPlain = function (md) {
	return String(md || '').split(URL_TOKEN)
		.map((part, i) => (i % 2 ? part : part.replace(/\\([\\`*_~[\]#<>|])|\*\*|_/g, (all, escaped) => (escaped !== undefined ? escaped : ''))))
		.join('');
};

// NodeBB HTML (a translated notification body) -> one line of light markdown.
// Only <strong>/<b> and <em>/<i> become markdown; all text is escaped.
Message.htmlToMarkdownLine = function (html) {
	const s = String(html || '').split(/(<[^>]*>)/).map((part, i) => {
		if (i % 2 === 0) return Message.escapeMarkdown(Message.decodeEntities(part));
		const name = tagName(part);
		if (name === 'strong' || name === 'b') return '**';
		if (name === 'em' || name === 'i') return '_';
		return BLOCK_TAGS.has(name) ? ' ' : '';
	}).join('');
	return s.replace(/\s+/g, ' ').trim();
};

Message.plain = function (html) {
	return Message.decodeEntities(Message.stripTags(html)).replace(/\s+/g, ' ').trim();
};

// Post content (markdown, maybe HTML) -> a short plain excerpt.
Message.excerpt = function (content, max) {
	const limit = parseInt(max, 10) || 0;
	if (limit <= 0) return '';
	let s = String(content || '')
		.replace(/```[\s\S]*?```/g, ' [code] ')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		// Quoted text is what the recipient wrote before: drop it. Notification
		// bodies are usually rendered HTML, raw post content is markdown.
		.replace(/<blockquote\b[\s\S]*?<\/blockquote>/gi, ' ')
		.replace(/<pre\b[\s\S]*?<\/pre>/gi, ' [code] ')
		.replace(/<img\b[^>]*>/gi, ' [image] ')
		.replace(/^>.*$/gm, ' ');
	s = Message.decodeEntities(Message.stripTags(s)).replace(/\s+/g, ' ').trim();
	if (s.length <= limit) return s;
	const cut = s.slice(0, limit);
	const space = cut.lastIndexOf(' ');
	return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

Message.COLORS = {
	reply: '#1e88e5',
	mention: '#1e88e5',
	topic: '#1e88e5',
	ticket_team: '#8a6fbf',
	other: '#7d8aa0',
	// Shotef public stages
	received: '#7d8aa0',
	in_progress: '#e0a03c',
	answered: '#4b9e7a',
	closed: '#9aa4b2',
	'closed-no-response': '#9aa4b2',
};

Message.absoluteUrl = function (base, path) {
	const b = String(base || '').replace(/\/+$/, '');
	const p = String(path || '');
	if (/^https?:\/\//i.test(p)) return p;
	if (!p) return b;
	return b + (p.startsWith('/') ? p : `/${p}`);
};

Message.compose = function ({ event, bodyHtml, title, baseUrl, path, content, excerptLength, stage }) {
	const withExcerpt = event === 'reply' || event === 'mention' || event === 'topic';
	return {
		event,
		summary: Message.htmlToMarkdownLine(bodyHtml) || Message.escapeMarkdown(Message.plain(title)) || 'New notification',
		title: Message.plain(title),
		url: Message.absoluteUrl(baseUrl, path),
		excerpt: withExcerpt ? Message.excerpt(content, excerptLength) : '',
		stage: stage || null,
		color: Message.COLORS[stage] || Message.COLORS[event] || Message.COLORS.other,
	};
};
