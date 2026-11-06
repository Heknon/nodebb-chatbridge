#!/usr/bin/env bash
# Remove the E2E containers, network and state.
P=chatbridge-e2e
docker rm -f $P-nodebb $P-mattermost $P-redis >/dev/null 2>&1
docker network rm $P >/dev/null 2>&1
rm -rf "$(cd "$(dirname "$0")" && pwd)/.work"
echo down
