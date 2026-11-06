'use strict';

// What a provider throws from send(). The outbox decides on these alone.

// Try again later: network failure, timeout, 5xx, rate limit.
class RetryableError extends Error {
	constructor(message, { retryAfterMs } = {}) {
		super(message);
		this.name = 'RetryableError';
		this.retryAfterMs = retryAfterMs || 0;
	}
}

// Retrying won't help: bad token, missing permission, user gone, bad payload.
class PermanentError extends Error {
	constructor(message) {
		super(message);
		this.name = 'PermanentError';
	}
}

module.exports = { RetryableError, PermanentError };
