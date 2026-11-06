# nodebb-plugin-chatbridge — plan

Tell a forum user in chat (Mattermost first) when something happens to their
ticket: a reply on their topic, or a Shotef status change. Every message links
back to the topic.

## 1. What already exists (and why it drives the design)

**NodeBB core** notifies a topic's followers on every reply. The author follows
their own topic by default (`followTopicsOnCreate`). The notification type is
`new-reply`.

**Shotef** (`lib/sockets.js` → `Sockets.transition`) notifies the reporter when
their ticket's *public stage* changes: `received`, `in_progress`, `answered`,
`closed`, and `closed-no-response`. Notification type is `shotef`, nid
`shotef:status:<tid>:<stage>`, body is a language key such as
`[[shotef:notif-status-answered]]`. It skips:
- internal tickets (written by the team, so there is no outside reporter),
- self-actions,
- status changes caused by replies (`bySystem`). The reply notification already covers those, so this avoids a double ping.
The HTTP API (`/api/v3/plugins/shotef/tickets/:tid/status`, used by nodebb-mcp)
delegates to the same handler, so agent-driven moves notify too.

**NodeBB fires `action:notification.pushed`** after every push
(`src/notifications.js`), with `{ notification, uidsNotified, uidsEmailed }`.
The recipients have already been filtered by the user's per-type settings and
by blocks.

**So the bridge needs no Shotef changes for v1.** It subscribes to
`action:notification.pushed` and mirrors chosen notification types to each
linked recipient's chat DM. The Shotef rules (who counts as the reporter, no
self-pings, no doubles) stay in one place: Shotef. The bridge also stays
independent. Without Shotef it still relays replies.

## 2. Event flow

```
reply posted ─▶ NodeBB core notif (new-reply) ─┐
                                                ├─▶ action:notification.pushed
board / API move ─▶ Shotef notif (shotef) ─────┘          │
                                                           ▼
                                   chatbridge: type allowed? recipient linked & opted in?
                                                           │
                                       build message (translate bodyShort in user's language,
                                       topic title, absolute URL, optional reply excerpt)
                                                           │
                                       enqueue (db, deduped by nid+uid) ─▶ provider.send()
                                                           │                       │
                                                           └── retry w/ backoff ◀──┘ on failure
```

## 3. Mattermost integration

**Bot account + REST API v4** (recommended over incoming webhooks):
- Admin creates a bot in Mattermost (System Console → Integrations → Bot
  Accounts), copies its access token into the ACP.
- On startup / settings save: `GET /api/v4/users/me` checks the token and gets
  the bot's user id.
- Send: `POST /api/v4/channels/direct` `[botId, mmUserId]` returns the DM
  channel (cached), then `POST /api/v4/posts` with `{ channel_id, message, props.attachments }`.
- A message attachment holds the title (linked to the topic), the status as
  a coloured bar, and a short excerpt of the reply.

An incoming webhook with `channel: "@username"` works too, but it posts as the
webhook owner, can't be verified per user, and is a dead end for interactive
buttons later. It could be offered as a fallback "simple mode". Not in v1.

## 4. Account linking (NodeBB uid ↔ chat user)

The forum signs users in through LDAP, and Mattermost uses the same directory, so
the NodeBB username is the Mattermost username.

- **Default: match by username.** Mattermost `GET /api/v4/users/username/{name}`
  (lowercased). Deactivated accounts count as no match.
- **Optional: verified email**, as a fallback or instead (`<provider>_match`).
- **Optional: display name**, as a last fallback. The NodeBB full name must equal
  the full name or nickname of exactly one active Mattermost user
  (`POST /api/v4/users/search`, then an exact comparison). Names are not unique, so
  a name shared by two chat users, or by two forum users (`fullname:sorted`),
  matches nobody.
- Results are cached in memory per process: a match for 6h, no match for 15 min.
- There is no opt-in step and no account page. Everyone who gets the NodeBB
  notification gets the DM. To opt out, a user turns that type off in NodeBB's
  own notification settings.

## 5. Plugin layout (mirrors Shotef's conventions)

```
library.js                  hook wiring
plugin.json                 static:app.load, static:api.routes, action:notification.pushed,
                            action:settings.set, filter:admin.header.build
lib/nbb.js                  NodeBB require wrapper (stubbed in tests)
lib/settings.js             meta.settings 'chatbridge': events, excerpt, per-provider config
lib/events.js               pure: notification -> event key (reply, ticket_status, ...)
lib/message.js              pure: provider-neutral message { summary, title, url, excerpt, stage, color }
lib/identity.js             uid -> chat user id per provider (username / email), cached
lib/relay.js                onNotificationPushed: filter, privilege check, compose, hand to outbox
lib/outbox.js               send now; on a retryable failure persist and retry with backoff; delivery log
lib/errors.js               RetryableError / PermanentError
lib/providers/index.js      registry (+ filter:chatbridge.providers for third-party providers)
lib/providers/mattermost.js bot account, REST API v4
lib/controllers.js, lib/api.js   ACP page, test connection, test DM, delivery log
templates/admin/plugins/chatbridge.tpl, public/js/admin.js
tests/*.test.js             node:test, nbb stub, fake Mattermost HTTP server
```

The provider interface is kept small, so Slack, Teams or Telegram can be added later without touching the relay:

```js
{ id, label, fields, defaultMatch,
  verify(cfg) → { name },
  findUser(cfg, { username, email, displayname }, strategy) → externalId | null,
  send(cfg, externalId, message) → void   // throws RetryableError | PermanentError
  reset() }
```

## 6. ACP settings

- Per provider: enabled, its fields (Mattermost: server URL, bot token), user
  matching (username / email / username then email), and Test connection.
- Forum base URL for links (defaults to `nconf.get('url')`).
- Which events to relay (the table in the README).
- Reply excerpt length (default 300, 0 turns it off).
- Delivery log: recent sends and failures, plus "send me a test message".

## 7. Reliability & correctness

- **Never throw into NodeBB**: wrap every hook handler in try/catch and log.
- **Clustered forums**: `action:notification.pushed` fires on the process that pushed it,
  so it fires once per event. The outbox drain runs only where `nconf.get('runJobs')` is set, so
  retries aren't duplicated across processes.
- **Dedupe**: on `nid + datetime + uid + provider`. Shotef reuses the nid
  `shotef:status:<tid>:<stage>`, so the nid alone would drop a second "in
  progress" after a move back and forth. `datetime` is set fresh on every push.
- **Privacy**: before including a title or excerpt, re-check that the recipient can still read the topic
  (`privileges.topics.can('topics:read', tid, uid)`). For example, the topic may have been moved to a private category.
- **Rate limits**: Mattermost returns 429 with headers saying how long to wait. Wait that long, then retry.
- **Bodies**: notification `bodyShort` contains `[[…]]` keys and escaped HTML. Translate
  with `translator.translate(body, userLang)`, then unescape and strip tags
  before turning it into Mattermost markdown.

## 8. Testing

- **Unit** (`node --test`, no NodeBB): `message.js` formatting per notification
  type, filter rules, outbox dedupe and retry, and the Mattermost provider against a
  fake HTTP server (the DM channel create and post payloads, 401/429/500 handling).
- **E2E**: a real NodeBB with Shotef, plus Mattermost via
  `docker run mattermost/mattermost-preview`. Seed a bot and a user with the same email as
  the forum user. Then post a reply and move the ticket through the Shotef HTTP API, and assert
  that the DM posts arrive (`GET /api/v4/channels/{id}/posts`). This reuses nodebb-mcp's
  `e2e/forum.sh` pattern.

## 9. Phases

1. **Scaffold + Mattermost provider**: settings, ACP page, test-connection,
   "send test DM to me".
2. **Relay**: the `action:notification.pushed` handler, type filter, message
   builder, username matching. *At this point it already works end to end.*
3. **Outbox**: retries, dedupe, delivery log.
4. **Richer Shotef context (optional, needs a small Shotef PR)**: Shotef fires
   `action:shotef.ticket.transitioned { tid, from, to, publicStatus, closeReason,
   teamId, actorUid, bySystem }`. The bridge would then show the team name, or let
   staff opt in to their own "assigned to you" / "help wanted" DMs. Not
   needed for the reporter use case.
5. Later: interactive buttons ("Reply", "Mark resolved") that post back to a
   NodeBB route, Slack/Teams providers, and a channel feed per category for teams.

## 10. Decisions

- Providers are generic (`lib/providers/`). Mattermost is the first one.
- Users are matched by LDAP username. Email matching is optional.
- Everyone NodeBB notifies gets the DM: all followers, and also users who chose
  email-only (`uidsNotified` ∪ `uidsEmailed`).
- Package `nodebb-plugin-chatbridge`, repo `Heknon/nodebb-chatbridge`.
