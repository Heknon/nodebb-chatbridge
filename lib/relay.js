'use strict';

// action:notification.pushed -> chat DMs.
//
// NodeBB (and Shotef) decide who is notified; this only mirrors what they sent.
// Recipients are everyone NodeBB notified in-app plus those who chose email for
// that type: both asked to hear about it. A user who set the type to "off" is
// in neither list.

const nbb = require('./nbb');

const winston = nbb('winston');
const meta = nbb('./src/meta');
const posts = nbb('./src/posts');
const topics = nbb('./src/topics');
const privileges = nbb('./src/privileges');
const translator = nbb('./src/translator');
const user = nbb('./src/user');

const Events = require('./events');
const Message = require('./message');
const Settings = require('./settings');
const Providers = require('./providers');
const Identity = require('./identity');
const Outbox = require('./outbox');

const Relay = module.exports;

Relay.CONCURRENCY = 5;
Relay.DEDUPE_TTL_MS = 10 * 60 * 1000;

const seen = new Map(); // dedupe key -> time

function firstSeen(key) {
	const now = Date.now();
	if (seen.size > 5000) {
		for (const [k, t] of seen) if (now - t > Relay.DEDUPE_TTL_MS) seen.delete(k);
	}
	const t = seen.get(key);
	if (t && now - t < Relay.DEDUPE_TTL_MS) return false;
	seen.set(key, now);
	return true;
}
Relay.clearDedupe = () => seen.clear();

Relay.recipients = function (data) {
	const all = [].concat(data.uidsNotified || data.uids || [], data.uidsEmailed || []);
	return [...new Set(all.map(u => parseInt(u, 10)).filter(u => u > 0))];
};

Relay.activeProviders = function (settings) {
	return Providers.list()
		.map(p => ({ provider: p, cfg: Settings.providerConfig(settings, p) }))
		.filter(({ provider, cfg }) => cfg.enabled && !Providers.missingConfig(provider, cfg));
};

async function language(uid) {
	try {
		const s = await user.getSettings(uid);
		return (s && s.userLang) || meta.config.defaultLang || 'en-GB';
	} catch (e) {
		return meta.config.defaultLang || 'en-GB';
	}
}

async function canRead(tid, uid) {
	if (!tid) return true; // not about a topic (e.g. a follow); nothing to leak
	try {
		return !!(await privileges.topics.can('topics:read', tid, uid));
	} catch (e) {
		return false;
	}
}

// Topic-level context, fetched once per notification.
async function context(notification) {
	let { tid, pid } = Events.refs(notification);
	if (pid && !tid) tid = parseInt(await posts.getPostField(pid, 'tid'), 10) || 0;
	const title = tid ? await topics.getTopicField(tid, 'title') : '';
	const content = pid ? await posts.getPostField(pid, 'content') : '';
	return { tid, pid, title: title || '', content: content || '' };
}

async function pool(items, size, fn) {
	const queue = items.slice();
	const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
		while (queue.length) {
			// eslint-disable-next-line no-await-in-loop
			await fn(queue.shift());
		}
	});
	await Promise.all(workers);
}

// The work. Resolves to a summary (used by tests); errors propagate.
Relay.handle = async function (data) {
	const notification = data && data.notification;
	if (!notification) return { skipped: 'no notification' };

	const event = Events.classify(notification);
	const settings = await Settings.get();
	if (!Settings.eventEnabled(settings, event)) return { skipped: `event ${event} off` };

	const active = Relay.activeProviders(settings);
	if (!active.length) return { skipped: 'no provider' };

	const uids = Relay.recipients(data);
	if (!uids.length) return { skipped: 'no recipients' };

	const ctx = await context(notification);
	const stage = event === 'ticket_status' ? Events.ticketStage(notification) : null;
	const baseUrl = Settings.baseUrl(settings);
	const excerptLength = Settings.excerptLength(settings);
	const result = { event, sent: 0, retrying: 0, failed: 0, unmatched: 0, hidden: 0, duplicate: 0 };

	await pool(uids, Relay.CONCURRENCY, async (uid) => {
		try {
			if (!(await canRead(ctx.tid, uid))) { result.hidden += 1; return; }
			const bodyHtml = await translator.translate(String(notification.bodyShort || ''), await language(uid));
			const message = Message.compose({
				event, bodyHtml, title: ctx.title, baseUrl, path: notification.path || (ctx.tid ? `/topic/${ctx.tid}` : ''),
				content: notification.bodyLong || ctx.content, excerptLength, stage,
			});
			for (const { provider, cfg } of active) {
				/* eslint-disable no-await-in-loop */
				const key = `${provider.id}|${uid}|${notification.nid}|${notification.datetime || ''}`;
				if (!firstSeen(key)) { result.duplicate += 1; continue; }
				const externalId = await Identity.resolve(provider, cfg, uid);
				if (!externalId) { result.unmatched += 1; continue; }
				const outcome = await Outbox.attempt(Outbox.newJob({ provider: provider.id, uid, externalId, message }));
				if (result[outcome] !== undefined) result[outcome] += 1;
				/* eslint-enable no-await-in-loop */
			}
		} catch (err) {
			result.failed += 1;
			winston.warn(`[plugin/chatbridge] relay to uid ${uid}: ${err.message}`);
		}
	});
	return result;
};

// Hook entry point: never throws into NodeBB.
Relay.onNotificationPushed = async function (data) {
	try {
		return await Relay.handle(data);
	} catch (err) {
		winston.error(`[plugin/chatbridge] onNotificationPushed: ${err.stack}`);
		return { error: err.message };
	}
};
