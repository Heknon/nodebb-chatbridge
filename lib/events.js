'use strict';

// Which kind of forum event a NodeBB notification is. The ACP toggles relaying
// per event, so this is the one place that maps notification types to them.
// Pure: no IO.

const Events = module.exports;

Events.CATALOG = [
	{ key: 'reply', label: 'Replies to topics the user follows (authors follow their own topics)', default: true },
	{ key: 'ticket_status', label: 'Shotef: the reporter\'s ticket changed stage (received, in progress, answered, closed)', default: true },
	{ key: 'ticket_team', label: 'Shotef: team notices (assigned to you, handover, help wanted, passed to your team)', default: true },
	{ key: 'mention', label: 'Mentions (@username)', default: true },
	{ key: 'topic', label: 'New topics in followed categories or by followed users', default: false },
	{ key: 'other', label: 'Every other notification type', default: false },
];

Events.classify = function (notification) {
	const n = notification || {};
	const type = String(n.type || '');
	const nid = String(n.nid || '');
	if (type === 'new-reply') return 'reply';
	if (type === 'mention') return 'mention';
	if (type === 'new-topic' || type === 'new-topic-with-tag' || type === 'new-topic-in-category') return 'topic';
	if (type === 'shotef' || nid.startsWith('shotef:')) {
		return nid.startsWith('shotef:status:') ? 'ticket_status' : 'ticket_team';
	}
	return 'other';
};

// Shotef's status nid is `shotef:status:<tid>:<stage>`.
Events.ticketStage = function (notification) {
	const m = /^shotef:status:(\d+):([\w-]+)$/.exec(String((notification && notification.nid) || ''));
	return m ? m[2] : null;
};

// Shotef nids whose first id is the ticket's tid (`shotef:assign:<tid>:<uid>`).
// The others start with a team id or a reminder id (`shotef:handover:<teamId>:…`,
// `shotef:reminder:<uuid>`), which must not be read as a topic.
const SHOTEF_TID_NIDS = /^shotef:(?:status|assign|help|pass|takeover):(\d+)(?::|$)/;

// The ids a notification refers to, from its fields, path or nid.
Events.refs = function (notification) {
	const n = notification || {};
	const path = String(n.path || '');
	const nid = String(n.nid || '');
	const int = v => (/^[1-9]\d*$/.test(String(v)) ? parseInt(v, 10) : 0);
	let tid = int(n.tid);
	let pid = int(n.pid);
	if (!pid) { const m = /\/post\/(\d+)/.exec(path); if (m) pid = int(m[1]); }
	if (!tid) { const m = /\/topic\/(\d+)/.exec(path); if (m) tid = int(m[1]); }
	// Shotef board links: /shotef?team=<teamId>&card=<tid>
	if (!tid) { const m = /^\/shotef\b[^#]*[?&]card=(\d+)(?:[&#]|$)/.exec(path); if (m) tid = int(m[1]); }
	if (!tid) { const m = SHOTEF_TID_NIDS.exec(nid); if (m) tid = int(m[1]); }
	return { tid, pid };
};
