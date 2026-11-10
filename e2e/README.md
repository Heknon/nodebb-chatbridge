# End-to-end tests

A real NodeBB 4 with this plugin (and Shotef, when a checkout is next to this
repo) delivering to a real Mattermost, all in Docker. This is the E2E from
[PLAN.md §8](../PLAN.md).

```bash
e2e/up.sh                 # start and seed the stack (first run: a few minutes)
node e2e/scenario.js      # run every check; or pass name prefixes: node e2e/scenario.js shotef:,ACP:
e2e/down.sh               # remove the containers and state
```

Needs Docker, `jq`, `curl`, Node 20+ and Playwright with Chromium
(`npm i --no-save playwright && npx playwright install chromium` if it isn't
installed globally). Ports 4567 (NodeBB) and 8065 (Mattermost) must be free.
`SHOTEF_DIR` points at a nodebb-shotef checkout (default `../nodebb-shotef`);
without one, the Shotef checks are skipped.

After changing `public/` or `templates/`, rebuild NodeBB's assets with
`e2e/nodebb.sh build`; after changing `lib/`, `e2e/nodebb.sh restart`. The
plugin is mounted read-only from this checkout.

## What it checks

Each check reads back what Mattermost actually received (through its API, as
the users' DM channels with the bot).

- **ACP**: the page shows the saved settings; saving the form takes effect;
  Test connection; Send me a test message; the delivery log shows errors.
- **Replies**: title, link and a clean excerpt (no quotes, code, or split
  mentions); the delivery log entry.
- **Mentions**: forum `Bob` reaches Mattermost `bob`.
- **The user's NodeBB settings**: `none` sends nothing; `email` still sends.
- **Matching**: unmatched, deactivated, and email-only users; "username, then
  verified email".
- **Display name**: off unless chosen; a forum full name finds the chat user with
  that name; a name two chat users share, or two forum users share, matches
  nobody; with Mattermost's Show Full Name off, full names find nobody.
- **Event toggles**, **language** (Hebrew), **base URL**, **excerpt length**.
- **Markdown**: a topic title can't put links or emphasis into the bot's
  message.
- **Shotef**: stage DMs to the reporter (including `closed-no-response`), the
  same stage twice, one DM per public reply, no DM for your own move, assigned,
  help wanted, a numeric team id, reminders, and a reporter who lost access.
- **Admin API**: refuses non-admins, guests, and requests without a CSRF token.
- **Webhook** (no token): a Mattermost incoming webhook DMs `@username`; the
  ACP card and its buttons; markdown text; a custom body template; a user with
  no chat account is logged as failed.
- **Failures**: a bad token (logged as failed), Mattermost down (queued, then
  delivered by the retry drain), the provider disabled while a retry waits
  (dropped), and Mattermost down right after a NodeBB restart, before any user
  was looked up (still queued).

The forum users (`e2e/seed.js`) and chat users (`e2e/up.sh`) are set up so
that each matching rule is exercised: `alice` and `Bob` match by username,
`dave.forum` only by verified email, `nobody` has no chat account, `gone`'s is
deactivated.
