#!/usr/bin/env bash
set -euo pipefail
: "${IMAGE_REF:?Set IMAGE_REF}"
: "${EXPECTED_REVISION:?Set EXPECTED_REVISION}"
: "${RUNNER_TEMP:?Set RUNNER_TEMP}"

storage_root=$(mktemp -d "$RUNNER_TEMP/genzoroom-smoke.XXXXXX")
sudo chown 10001:10001 "$storage_root"
container=""
cleanup() {
  if [[ -n "$container" ]]; then
    docker logs "$container" || true
    docker rm -f "$container" >/dev/null || true
  fi
}
trap cleanup EXIT

# No Immich credentials or host user data are supplied to this disposable startup check.
container=$(docker run -d --cap-drop ALL --security-opt no-new-privileges:true \
  --stop-timeout 75 -p 127.0.0.1::8080 \
  --mount "type=bind,source=$storage_root,target=/genzoroom" "$IMAGE_REF")
port=$(docker port "$container" 8080/tcp | sed 's/.*://')
healthy=false
for _ in $(seq 1 60); do
  if [[ $(curl --fail --silent --max-time 2 "http://127.0.0.1:$port/api/health" || true) == '{"status":"ok"}' ]]; then
    healthy=true
    break
  fi
  [[ $(docker inspect "$container" --format '{{.State.Running}}') == true ]] || break
  sleep 1
done
[[ "$healthy" == true ]]
[[ $(docker exec "$container" id -u) == 10001 ]]
[[ $(docker exec "$container" id -g) == 10001 ]]
[[ $(docker image inspect "$IMAGE_REF" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$EXPECTED_REVISION" ]]
docker exec "$container" nginx -t
docker exec "$container" python -c '
import shutil, sqlite3
from pathlib import Path
assert not shutil.which("node") and not shutil.which("npm")
assert Path("/genzoroom/data/genzoroom.db").is_file()
with sqlite3.connect("file:/genzoroom/data/genzoroom.db?mode=rw", uri=True) as connection:
    assert connection.execute("PRAGMA user_version").fetchone()[0] == 4
    assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    connection.execute("BEGIN IMMEDIATE")
    connection.rollback()
'
docker stop --time 75 "$container" >/dev/null
[[ $(docker inspect "$container" --format '{{.State.ExitCode}}') == 0 ]]
