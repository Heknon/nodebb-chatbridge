#!/usr/bin/env bash
# Start a throwaway stack for the E2E run: Redis, NodeBB 4 (this plugin and,
# if found, Shotef mounted read-only) and Mattermost (preview image). Then create
# the Mattermost bot and users, and seed the forum. Re-running reuses what is up.
#
#   SHOTEF_DIR   path to a nodebb-shotef checkout (default: ../../nodebb-shotef)
#   NODEBB_IMAGE default ghcr.io/nodebb/nodebb:latest
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN=$(cd "$HERE/.." && pwd)
WORK="$HERE/.work"
SHOTEF_DIR=${SHOTEF_DIR:-$(cd "$PLUGIN/.." && pwd)/nodebb-shotef}
NODEBB_IMAGE=${NODEBB_IMAGE:-ghcr.io/nodebb/nodebb:latest}
P=chatbridge-e2e
mkdir -p "$WORK/nbbconfig" && chmod 777 "$WORK/nbbconfig"

running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
wait_for() { for _ in $(seq 1 90); do curl -sf "$1" >/dev/null && return 0; sleep 2; done; echo "timed out: $1" >&2; return 1; }

docker network inspect $P >/dev/null 2>&1 || docker network create $P >/dev/null
running $P-redis || docker run -d --name $P-redis --network $P redis:7-alpine >/dev/null
running $P-mattermost || docker run -d --name $P-mattermost --network $P --network-alias mattermost \
	-p 8065:8065 mattermost/mattermost-preview:latest >/dev/null

# ---------------------------------------------------------------- Mattermost
wait_for http://localhost:8065/api/v4/system/ping
if [ ! -s "$WORK/mm.env" ]; then
	MM=http://localhost:8065/api/v4
	j() { curl -sS -H 'Content-Type: application/json' "$@"; }
	j -X POST $MM/users -d '{"email":"mmadmin@corp.example","username":"mmadmin","password":"Admin-pass-123!"}' >/dev/null
	TOKEN=$(curl -sS -i -H 'Content-Type: application/json' -X POST $MM/users/login \
		-d '{"login_id":"mmadmin","password":"Admin-pass-123!"}' | awk -F': ' 'tolower($1)=="token"{print $2}' | tr -d '\r')
	A=(-H "Authorization: Bearer $TOKEN")
	TEAM=$(j "${A[@]}" -X POST $MM/teams -d '{"name":"corp","display_name":"Corp","type":"O"}' | jq -r .id)
	j "${A[@]}" -X PUT $MM/config/patch -d '{"ServiceSettings":{"EnableBotAccountCreation":true,"EnableUserAccessTokens":true}}' >/dev/null
	# Chat users: alice/bob/admin match forum usernames, dave.mm only by email, gone is deactivated.
	for u in alice bob admin dave.mm gone; do
		id=$(j "${A[@]}" -X POST $MM/users -d "{\"email\":\"$u@corp.example\",\"username\":\"$u\",\"password\":\"User-pass-123!\"}" | jq -r .id)
		j "${A[@]}" -X POST $MM/teams/$TEAM/members -d "{\"team_id\":\"$TEAM\",\"user_id\":\"$id\"}" >/dev/null
	done
	j "${A[@]}" -X DELETE $MM/users/$(j "${A[@]}" $MM/users/username/gone | jq -r .id) >/dev/null
	BOT=$(j "${A[@]}" -X POST $MM/bots -d '{"username":"forumbot","display_name":"Forum"}' | jq -r .user_id)
	BOT_TOKEN=$(j "${A[@]}" -X POST $MM/users/$BOT/tokens -d '{"description":"chatbridge e2e"}' | jq -r .token)
	printf 'ADMIN_TOKEN=%s\nBOT_ID=%s\nBOT_TOKEN=%s\nTEAM=%s\n' "$TOKEN" "$BOT" "$BOT_TOKEN" "$TEAM" > "$WORK/mm.env"
fi

# An incoming webhook (the token-less provider). Created by mmadmin, so its
# "@username" posts land in the DM between mmadmin and that user.
if ! grep -q '^HOOK_ID=' "$WORK/mm.env"; then
	. "$WORK/mm.env"
	MM=http://localhost:8065/api/v4
	j() { curl -sS -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_TOKEN" "$@"; }
	j -X PUT $MM/config/patch -d '{"ServiceSettings":{"EnableIncomingWebhooks":true}}' >/dev/null
	CH=$(j $MM/teams/$TEAM/channels/name/town-square | jq -r .id)
	HOOK_ID=$(j -X POST $MM/hooks/incoming -d "{\"channel_id\":\"$CH\",\"display_name\":\"Forum\",\"channel_locked\":false}" | jq -r .id)
	ADMIN_ID=$(j $MM/users/me | jq -r .id)
	printf 'HOOK_ID=%s\nADMIN_ID=%s\n' "$HOOK_ID" "$ADMIN_ID" >> "$WORK/mm.env"
fi

# -------------------------------------------------------------------- NodeBB
if ! running $P-nodebb; then
	MOUNTS=(-v "$PLUGIN:/usr/src/app/node_modules/nodebb-plugin-chatbridge:ro")
	if [ -d "$SHOTEF_DIR" ]; then MOUNTS+=(-v "$SHOTEF_DIR:/usr/src/app/node_modules/nodebb-plugin-shotef:ro"); fi
	docker run -d --name $P-nodebb --network $P -p 4567:4567 "${MOUNTS[@]}" \
		-v "$WORK/nbbconfig:/opt/config" --entrypoint bash "$NODEBB_IMAGE" -c 'sleep infinity' >/dev/null
fi
nbb() { docker exec $P-nodebb bash -c "cd /usr/src/app && $*"; }
if [ ! -s "$WORK/nbbconfig/config.json" ]; then
	SETUP='{"url":"http://localhost:4567","secret":"e2e-secret","database":"redis","redis:host":"'$P'-redis","redis:port":"6379","redis:password":"","redis:database":"0","admin:username":"admin","admin:email":"admin@corp.example","admin:password":"Admin-pass-123!","admin:password:confirm":"Admin-pass-123!"}'
	nbb "./nodebb setup '$SETUP' --config /opt/config/config.json" > "$WORK/setup.log" 2>&1
fi
nbb "ln -sf /opt/config/config.json config.json"
# Many logins from one address: don't lock it out.
docker exec $P-redis redis-cli HSET config ipLoginAttempts 100000 >/dev/null
if ! curl -sf http://localhost:4567/api/config >/dev/null; then
	nbb "./nodebb activate nodebb-plugin-chatbridge" > "$WORK/build.log" 2>&1
	[ -d "$SHOTEF_DIR" ] && nbb "./nodebb activate nodebb-plugin-shotef" >> "$WORK/build.log" 2>&1
	nbb "./nodebb build" >> "$WORK/build.log" 2>&1
	"$HERE/nodebb.sh" start
	wait_for http://localhost:4567/api/config
fi

[ -s "$WORK/seed.json" ] || node "$HERE/seed.js"
echo "up: NodeBB http://localhost:4567 (admin / Admin-pass-123!), Mattermost http://localhost:8065"
