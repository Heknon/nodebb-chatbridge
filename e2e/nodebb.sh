#!/usr/bin/env bash
# stop | start | restart | build  NodeBB inside the E2E container.
set -euo pipefail
C=chatbridge-e2e-nodebb
stop() {
	# Kill the loader and its worker, not this shell (its command line names them too).
	docker exec -u root $C bash -c 'me=$$; for p in /proc/[0-9]*; do n=${p#/proc/}; [ "$n" = "$me" ] && continue
		c=$(tr "\0" " " < $p/cmdline 2>/dev/null); case "$c" in "node loader.js"*|*/usr/src/app/app.js*) kill $n;; esac; done; exit 0'
	sleep 2
}
start() { docker exec -d $C bash -c 'cd /usr/src/app && node loader.js --no-daemon --no-silent >> /tmp/nodebb.log 2>&1'; }
case "${1:-}" in
	stop) stop ;;
	start) start ;;
	restart) stop; start ;;
	build) stop; docker exec $C bash -c 'cd /usr/src/app && ./nodebb build' >/dev/null; start ;;
	*) echo "usage: $0 stop|start|restart|build" >&2; exit 2 ;;
esac
