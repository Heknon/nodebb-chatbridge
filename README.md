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
users in through LDAP. Matching by verified email is also available.

Before a message is sent, the plugin checks that the recipient can still read the topic.
If a send fails, it is retried with backoff. The ACP shows a log of recent sends.

## Mattermost setup

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
| `fields` | ACP inputs: `{ key, label, type, help, required }` |
| `verify(cfg)` | Check the credentials, return `{ name }` |
| `findUser(cfg, { username, email }, strategy)` | The chat user id, or `null` |
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
