# nodebb-plugin-chatbridge

Sends NodeBB notifications to users as chat direct messages, so a user hears
about their ticket where they already are. Mattermost is the first provider.
Others can be added without changing the rest of the plugin.

## What it relays

| Event | Comes from | Default |
| --- | --- | --- |
| Reply on a topic the user follows (authors follow their own topics) | NodeBB core | on |
| Ticket stage change: received, in progress, answered, closed | [Shotef](https://github.com/emotochat-droid/nodebb-shotef) | on |
| Shotef team notices: assigned to you, handover, help wanted, passed to your team | Shotef | on |
| Mention | NodeBB core | on |
| New topic in a followed category | NodeBB core | off |
| Anything else | — | off |

Each message links back to the post or topic. Replies include a short excerpt.

## How it works

The plugin listens to NodeBB's `action:notification.pushed` hook. It does not
decide who gets notified: NodeBB and Shotef do. So:

- whoever gets the forum notification gets the chat message;
- a user who turns a notification type off in their NodeBB settings stops
  getting it in chat too;
- Shotef's own rules still apply. Internal tickets don't notify the reporter,
  people aren't notified of their own actions, and a status change caused by a
  reply doesn't also send a second message.

It works without Shotef. You then get replies and mentions only.

Forum users are matched to chat users by username, which suits forums that sign
users in through LDAP. Two fallbacks can be turned on in the ACP, for users whose
usernames differ:

- **Verified email**: the forum user's confirmed email address.
- **Display name**: the forum user's full name must equal the full name (first
  and last) or nickname of exactly one active Mattermost user, ignoring case and
  spacing. A name that two chat users share, or two forum users share, matches
  nobody, so no one receives a stranger's notifications. Mattermost only lets the
  bot see full names while System Console → Site Configuration → Users and Teams →
  **Show Full Name** is on (the default); without it, only nicknames match.

Before a message is sent, the plugin checks that the recipient can still read the topic.
If a send fails, it is retried with backoff. The ACP shows a log of recent sends.

## Webhook setup (no token)

The **Webhook** provider sends each message as one `POST` to a URL you give it.
It needs no bot or token, and it doesn't look anyone up: the recipient is the
forum username.

1. In Mattermost, Integrations → Incoming Webhooks → Add: pick any channel and
   leave **Lock to this channel** off (otherwise `@username` DMs are refused).
   Copy the URL. (System Console → Integrations → Integration Management →
   **Enable Incoming Webhooks** must be on.)
2. In NodeBB, ACP → Plugins → Chat Bridge → Webhook: enable it, paste the URL,
   save, then **Send me a test message**.

Headers default to `Content-Type: application/json` (one `Name: value` per
line, or a JSON object). The body is a JSON template; the default sends a DM:

```json
{"channel": "@{{username}}", "text": "{{text}}"}
```

| Placeholder | Value |
| --- | --- |
| `{{username}}` | Forum username, lowercased |
| `{{text}}` | The whole message as markdown: summary, link to the post, quoted excerpt |
| `{{summary}}` | The one-line summary, markdown |
| `{{plain}}` | The summary as plain text, then the link |
| `{{title}}`, `{{url}}`, `{{excerpt}}` | Topic title, link, reply excerpt (plain text) |
| `{{event}}`, `{{stage}}`, `{{color}}` | Event key, Shotef stage, hex accent |

Placeholders are filled in after the template is parsed, inside its strings,
so quotes or newlines in forum text can't break the JSON. Any JSON shape works,
for example a Mattermost attachment, or another chat's webhook format.

In Mattermost, the DMs come from the account that created the webhook (with
its webhook name). A username with no chat account gets a 400, logged as
failed; 5xx, 429 and network errors are retried.

## Mattermost bot setup

1. In Mattermost, System Console → Integrations → Bot Accounts: create a bot
   and copy its access token.
2. In NodeBB, ACP → Plugins → Chat Bridge: enable Mattermost, enter the server
   URL and the bot token, save, then **Test connection**.
3. **Send me a test message** sends a DM to your own account, matched the same
   way as everyone else's.

## Requirements

- NodeBB 3.x or 4.x, Node.js 20+
- Mattermost 7+ with bot accounts enabled

## Adding a provider

A provider is one file in `lib/providers/` that exports:

| Member | Purpose |
| --- | --- |
| `id`, `label` | `id` prefixes its settings (`<id>_url`, …) |
| `fields` | ACP inputs: `{ key, label, type, help, required, default }`; `type` is `text`, `password`, `url` or `textarea` |
| `lookup` | Optional. `false` hides "Match forum users by" (the provider maps the username itself) |
| `verify(cfg)` | Check the credentials, return `{ name }` |
| `findUser(cfg, { username, email, displayname }, strategy)` | The chat user id, or `null`. `strategy` lists `username`, `email`, `displayname` to try in order |
| `send(cfg, userId, message)` | Deliver it. Throw `RetryableError` or `PermanentError` (`lib/errors.js`) |
| `reset()` | Drop caches after the settings change |

`message` is provider-neutral (`lib/message.js`): `summary`, `title`, `url`,
`excerpt`, `stage`, `color`. Register the provider in `lib/providers/index.js`.
Another plugin can add one through `filter:chatbridge.providers` instead.

## Development

```bash
npm test       # unit tests: stubbed NodeBB, fake Mattermost server
npm run e2e    # real NodeBB + Mattermost in Docker; see e2e/README.md
```

## Status

In development. See [PLAN.md](./PLAN.md) for the design.

## License

MIT
