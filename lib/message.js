'use strict';

// The provider-neutral message. Each provider renders it its own way (a
// Mattermost attachment, a Slack block, ...). Pure: no IO, so it is unit-tested.
//
// {
//   event:   'reply' | 'ticket_status' | ...      (lib/events.js)
//   summary: one line, light markdown (**bold**)   e.g. "**alice** has posted a reply to: **Printer on fire**"
//   title:   topic title, plain text
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

// NodeBB HTML (a translated notification body) -> one line of light markdown.
Message.htmlToMarkdownLine = function (html) {
	const s = String(html || '')
		.replace(/<\s*(strong|b)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, '**$2**')
		.replace(/<\s*(em|i)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, '_$2_')
		.replace(/<[^>]*>/g, '');
	return Message.decodeEntities(s).replace(/\s+/g, ' ').trim();
};

Message.plain = function (html) {
	return Message.decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
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
		.replace(/^>.*$/gm, ' ')
		.replace(/<[^>]*>/g, ' ');
	s = Message.decodeEntities(s).replace(/\s+/g, ' ').trim();
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
		summary: Message.htmlToMarkdownLine(bodyHtml) || Message.plain(title) || 'New notification',
		title: Message.plain(title),
		url: Message.absoluteUrl(baseUrl, path),
		excerpt: withExcerpt ? Message.excerpt(content, excerptLength) : '',
		stage: stage || null,
		color: Message.COLORS[stage] || Message.COLORS[event] || Message.COLORS.other,
	};
};
