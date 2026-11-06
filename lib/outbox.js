'use strict';

// Delivery. A message is sent straight away; only a retryable failure is
// persisted, then retried with exponential backoff by the drain loop, which
// runs on NodeBB's job-runner process only (library.js), so one process owns
// retries in a cluster.
//
//   chatbridge:outbox        zset  jobId -> next attempt (ms)
//   chatbridge:job:<jobId>   hash  { data: JSON }
//   chatbridge:log           list  recent deliveries, newest first (capped)

const crypto = require('crypto');

const nbb = require('./nbb');

const db = nbb('./src/database');
const winston = nbb('winston');

const Settings = require('./settings');
const Providers = require('./providers');
const Identity = require('./identity');
const Message = require('./message');
const { RetryableError } = require('./errors');

const Outbox = module.exports;

Outbox.KEY = 'chatbridge:outbox';
Outbox.LOG = 'chatbridge:log';
Outbox.LOG_SIZE = 200;
Outbox.MAX_ATTEMPTS = 8;
Outbox.BASE_DELAY_MS = 30 * 1000;
Outbox.MAX_DELAY_MS = 60 * 60 * 1000;
Outbox.DRAIN_EVERY_MS = 30 * 1000;
Outbox.DRAIN_BATCH = 50;

Outbox.backoff = function (attempts, retryAfterMs) {
	const exp = Math.min(Outbox.MAX_DELAY_MS, Outbox.BASE_DELAY_MS * (2 ** Math.max(0, attempts - 1)));
	return Math.max(exp, retryAfterMs || 0);
};

Outbox.newJob = function ({ provider, uid, externalId, message }) {
	return {
		id: crypto.randomUUID(),
		provider,
		uid,
		externalId,
		message,
		attempts: 0,
		createdAt: Date.now(),
	};
};

async function log(job, outcome, error) {
	try {
		const entry = {
			at: Date.now(),
			outcome, // 'sent' | 'retrying' | 'failed' | 'dropped' | 'unmatched'
			provider: job.provider,
			uid: job.uid,
			event: job.message && job.message.event,
			title: job.message && (job.message.title || Message.markdownToPlain(job.message.summary)),
			url: job.message && job.message.url,
			attempts: job.attempts,
			error: error ? String(error.message || error).slice(0, 300) : '',
		};
		await db.listPrepend(Outbox.LOG, JSON.stringify(entry));
		await db.listTrim(Outbox.LOG, 0, Outbox.LOG_SIZE - 1);
	} catch (e) {
		winston.warn(`[plugin/chatbridge] could not write delivery log: ${e.message}`);
	}
}

Outbox.recent = async function (n = 50) {
	const rows = await db.getListRange(Outbox.LOG, 0, Math.max(0, n - 1));
	return (rows || []).map((r) => { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean);
};

async function persist(job, nextAt) {
	await db.setObject(`chatbridge:job:${job.id}`, { data: JSON.stringify(job) });
	await db.sortedSetAdd(Outbox.KEY, nextAt, job.id);
}

async function remove(jobId) {
	await db.sortedSetRemove(Outbox.KEY, jobId);
	await db.delete(`chatbridge:job:${jobId}`);
}

// After a failed attempt: queue the job again, or give up.
async function retryOrFail(job, err) {
	if (err instanceof RetryableError && job.attempts < Outbox.MAX_ATTEMPTS) {
		try {
			await persist(job, Date.now() + Outbox.backoff(job.attempts, err.retryAfterMs));
		} catch (e) {
			winston.error(`[plugin/chatbridge] could not queue a retry: ${e.stack}`);
		}
		await log(job, 'retrying', err);
		return 'retrying';
	}
	winston.warn(`[plugin/chatbridge] ${job.provider} delivery to uid ${job.uid} failed: ${err.message}`);
	await log(job, 'failed', err);
	return 'failed';
}

// One attempt. Resolves to the outcome; never throws. A job without an
// externalId (its lookup failed in the relay) looks the user up first.
Outbox.attempt = async function (job) {
	job.attempts += 1;
	try {
		const provider = Providers.get(job.provider);
		const cfg = provider && Settings.providerConfig(await Settings.get(), provider);
		if (!provider || !cfg.enabled) {
			await log(job, 'dropped', new Error('provider disabled'));
			return 'dropped';
		}
		if (!job.externalId) {
			job.externalId = await Identity.resolve(provider, cfg, job.uid);
			if (!job.externalId) {
				await log(job, 'unmatched', new Error('no chat user matches this forum user'));
				return 'unmatched';
			}
		}
		await provider.send(cfg, job.externalId, job.message);
		await log(job, 'sent');
		return 'sent';
	} catch (err) {
		return retryOrFail(job, err);
	}
};

// A job whose first try failed before it reached attempt(): the relay could
// not look the recipient up (chat down, bad token). Counts as attempt 1.
Outbox.defer = async function (job, err) {
	job.attempts += 1;
	return retryOrFail(job, err);
};

// Send due retries. Only the job-runner process calls this.
Outbox.drain = async function (now = Date.now()) {
	const ids = await db.getSortedSetRangeByScore(Outbox.KEY, 0, Outbox.DRAIN_BATCH, '-inf', now);
	let n = 0;
	for (const id of ids || []) {
		/* eslint-disable no-await-in-loop */
		const row = await db.getObject(`chatbridge:job:${id}`);
		await remove(id);
		let job = null;
		try { job = row && JSON.parse(row.data); } catch (e) { job = null; }
		if (!job) continue;
		await Outbox.attempt(job);
		n += 1;
		/* eslint-enable no-await-in-loop */
	}
	return n;
};

Outbox.pending = async function () {
	return db.sortedSetCard(Outbox.KEY);
};

let timer = null;
let draining = false;
Outbox.start = function () {
	if (timer) return;
	timer = setInterval(async () => {
		if (draining) return;
		draining = true;
		try {
			await Outbox.drain();
		} catch (err) {
			winston.error(`[plugin/chatbridge] drain: ${err.stack}`);
		} finally {
			draining = false;
		}
	}, Outbox.DRAIN_EVERY_MS);
	if (typeof timer.unref === 'function') timer.unref();
};

Outbox.stop = function () {
	if (timer) clearInterval(timer);
	timer = null;
};
