# Single-container release validation

This is an additional distribution configuration. Development continues to use `docker-compose.yml` and `docker-compose.immich-network.yml` from `main`; neither is changed. No Actions, registry, tag or Release configuration is included.

## Build and configure

Use a separate Portainer Git Repository Stack with Compose path `compose.release.yml`. For same-host Immich, add `compose.release.immich-network.yml` and set `IMMICH_DOCKER_NETWORK` to an existing network. The override never creates that network. For LAN access, use the base file alone. Both routes use the existing `IMMICH_URL` / `IMMICH_API_KEY` variables.

Prepare the bind directory first and grant UID/GID `10001:10001` directory write access. `GENZOROOM_DATA_PATH` overrides `${GENZOROOM_PERSIST_ROOT}/data`; missing directories are refused with `create_host_path: false`. Mount the whole directory so SQLite can create WAL/SHM. Use local storage supporting SQLite locking.

For validation set `GENZOROOM_PORT=3191` in Portainer; the default remains 3190. Use a separate Stack/project name and a separate data directory restored from a consistent stopped-container backup. **Do not run development and release Backends against the same database simultaneously**: Export recovery assumes one Backend process, not a distributed lease. Stop the old deployment before switching the production data directory to the release Stack.

```sh
docker compose -p genzoroom-release -f compose.release.yml config
docker compose -p genzoroom-release -f compose.release.yml up -d --build
# Same-host route: add this argument to every command:
# -f compose.release.immich-network.yml
```

The build uses Node 24 and the existing Frontend production build, then copies only its output. Python dependencies use existing pinned requirements on Python 3.14. The final Python slim image adds nginx and tini; no Node or Frontend development dependencies are copied. `Dockerfile.release.dockerignore` allows only required build inputs; `.env`, data, Git and local dependencies are excluded. Credentials are runtime environment values, never build arguments or frontend inputs. Future registry deployment can replace `build:` with `image:` without changing the service's runtime settings.

## Process and persistence behavior

tini is PID 1, forwards termination to the Python supervisor and reaps orphaned descendants. Each service has its own process group. The supervisor detects any unsolicited nginx/Uvicorn exit (including exit code zero), stops the survivor, reaps children and exits nonzero. Compose can then restart the whole container with `unless-stopped`; no half-running service is retained.

SIGTERM/SIGINT requests nginx graceful QUIT and Uvicorn TERM. The supervisor allows 60 seconds for shutdown, then kills remaining groups and exits nonzero. Compose gives 75 seconds before Docker's own SIGKILL. Existing FastAPI lifespan waits for tag repair and Export Runtime; it may drain the entire run, rather than imply Stop-after-current. If the drain exceeds 60 seconds, persisted checkpoints remain for existing startup recovery. The limit is not a guarantee that a large JPEG or long Export finishes during shutdown. Request Stop in the application and wait for idle when a planned maintenance stop must finish the current item first.

Uvicorn has exactly one worker and binds `127.0.0.1:8000`; nginx alone listens externally on 8080. Both use UID/GID `10001:10001`, drop all capabilities and disable privilege escalation. nginx PID/temp files are under `/tmp`; `/data/genzoroom.db` and its existing schema/formats are unchanged. Release and development nginx share all location bodies, 8 MiB request limit, 3-second connect timeout, general 10-second read timeout, Stack 90-minute exception and the three Export Engine 1-hour exceptions. Only the upstream becomes loopback.

No Recipe, History, Queue, Runtime, image processing or registrar logic is changed. Recovery reuses frozen Recipe/revision/timestamp, regenerates JPEGs and relies on Immich checksum duplicate handling, tag reapplication and current Stack inspection. Unknown remote outcomes retain existing handling; terminal failed-item Retry creates new intent and can leave an earlier partial output. Duplicate prevention is not a distributed transaction or an absolute guarantee. Stop intent remains durable and completes the recovered current item before releasing the suffix.

The existing Developer Diagnostics build and hidden entry operation are retained unchanged. Frontend/Backend structured buffers, independent levels, JSON reports, WebGPU, Real JPEG and Export Engine remain available. Container stdout is shared infrastructure output, separate from those application diagnostic buffers. No menu or public entry point is added.

## Immich API key scopes

The current calls were checked against Immich **v3.2.4** controller permission decorators, the version used by the existing Export contract. These are API key scopes, separate from Immich ownership/access checks. Paths below are relative to Immich's `/api`.

| Scope | Current request / purpose |
| --- | --- |
| `user.read` | `GET /users/me`, `/users/me/calendar-heatmap`; connection and Calendar |
| `asset.read` | `GET /assets/{id}`, `POST /search/metadata`, `GET /timeline/bucket`; browsing, family discovery, registration verification |
| `asset.view` | `GET /assets/{id}/thumbnail`; thumbnails and previews |
| `asset.download` | `GET /assets/{id}/original`; JPEG originals |
| `album.read` | `GET /albums`; Home albums (album members use metadata search) |
| `tag.read` | `GET /tags`; Home GenzoRoom filtering |
| `asset.upload` | `POST /assets`; generated JPEG including inherited Favorite |
| `tag.create` | `PUT /tags`; GenzoRoom tag upsert |
| `tag.asset` | `PUT /tags/assets`; output tagging and Home tag repair |
| `stack.read` | `GET /stacks`; membership, management and Export convergence |
| `stack.create` | `POST /stacks`; confirmed management and Export merging |
| `stack.update` | `PUT /stacks/{id}`; Cover changes |
| `stack.delete` | `DELETE /stacks/{id}`; confirmed management |
| `asset.delete` | `DELETE /assets` with `force: false`; confirmed Trash |
| `server.about` (optional) | `GET /server/about`; Settings version/build information |

Upstream definitions: [User](https://github.com/immich-app/immich/blob/v3.2.4/server/src/controllers/user.controller.ts), [Search](https://github.com/immich-app/immich/blob/v3.2.4/server/src/controllers/search.controller.ts), [Timeline](https://github.com/immich-app/immich/blob/v3.2.4/server/src/controllers/timeline.controller.ts), [Asset](https://github.com/immich-app/immich/blob/v3.2.4/server/src/controllers/asset.controller.ts), [Asset media](https://github.com/immich-app/immich/blob/v3.2.4/server/src/controllers/asset-media.controller.ts), [Album](https://github.com/immich-app/immich/blob/v3.2.4/server/src/controllers/album.controller.ts), [Tag](https://github.com/immich-app/immich/blob/v3.2.4/server/src/controllers/tag.controller.ts), [Stack](https://github.com/immich-app/immich/blob/v3.2.4/server/src/controllers/stack.controller.ts), [Server](https://github.com/immich-app/immich/blob/v3.2.4/server/src/controllers/server.controller.ts).

Current code does not call Asset update/copy, Tag update/delete, album writes or permanent asset deletion. Do not grant their extra scopes for these features. `asset.delete` itself can authorize broader deletion in Immich; GenzoRoom limits its current request to Trash. Verify the same mapping against the deployed Immich version if different.

## NAS acceptance checks

1. Build the image, start both processes, check nginx configuration and obtain `{"status":"ok"}` from `http://<host>:3191/api/health`. Confirm Immich connection by both LAN and optional external-network routes.
2. Inspect process UID/GID, capabilities and privilege settings. Confirm only 8080 is exposed/listening externally and 8000 is loopback. Verify Node/npm are absent from the runtime image.
3. Check Recipe/History saves, Queue operations and WAL/SHM creation/reopening in `/data`. Confirm nonexistent bind source refuses deployment. Check that the development Stack and its data remain untouched.
4. Send SIGTERM with idle Runtime and confirm clean exit within the grace period. Kill nginx and, separately, Uvicorn in a disposable test Stack; confirm supervisor/container exit and whole-service restart. Check no orphaned children remain.
5. With test assets, verify Stop-after-current, Retry and restart during encoding/registration, including persisted Stop intent, duplicate upload convergence, unknown responses and Queue removal only after complete success. Allow existing partial-output limitations. Test planned stops both within and beyond the drain limit.
6. Use the existing hidden Diagnostics entry and verify separate log levels, JSON downloads, WebGPU, Real JPEG and all three Export Engine operations. Browser secure-context requirements for WebGPU remain unchanged.

Before backup or rollback, stop the sole writer and copy the complete data directory including any WAL/SHM. No new migration/downgrade is provided. Static Windows tests and Compose parsing do not establish Linux container or NAS/Firefox behavior.
