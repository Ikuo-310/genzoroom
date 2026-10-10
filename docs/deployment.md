# Deployment

This guide covers the single-container GHCR distribution for ordinary users and the separate two-container source-build workflow for development. Exact host, network, and container names depend on the deployment. Distribution images must first be published and made Public by the maintainer; this change does not publish `v0.1.0` or any other image. A formal `vMAJOR.MINOR.PATCH` tag publishes a fixed image and may advance `latest`; `latest` tracks the newest formal version, while `alpha` remains a mutable validation channel. A formal tag also creates a GitHub Release from that version's finalized CHANGELOG section after the image checks pass. See [release-validation.md](release-validation.md#maintainer-publishing-workflow).

GenzoRoom exposes only nginx on container port `8080`, mapped by default to host port `3190`. nginx serves the built frontend and forwards same-origin `/api/` requests to Uvicorn: loopback `127.0.0.1:8000` in the distribution container, or the internal Docker network in development. Backend port `8000` is not published to the host, and the frontend does not receive the Immich API key.

## Requirements

- Docker Engine with Docker Compose v2, or Portainer connected to a Docker Standalone environment.
- A Linux amd64 Docker host and access to an already published GHCR tag for distribution. No source clone, Node.js, Python installation or local image build is required. Arm64 is not validated or advertised as supported.
- Development only: repository contents and internet access during image builds.
- An existing Immich deployment reachable from the GenzoRoom backend.
- A dedicated Immich API key with these minimum permissions:
  - `user.read` for the authenticated connection check.
  - `asset.read` for recent-photo metadata and asset details.
  - `asset.view` for thumbnails and previews.
  - `asset.download` for selected JPEG originals.
  - `album.read` for Home album listing.
  - `tag.read` for Home GenzoRoom tag filtering.
  - `asset.upload` for Export JPEG registration.
  - `tag.create` and `tag.asset` for Export tagging and Home tag repair.
  - `asset.delete` for explicitly confirmed Trash operations (`force: false`).
  - `server.about` (optional) for Immich version/build information in Settings and diagnostic exports.
  - `stack.read` for membership and full Stack resolution.
  - `stack.create`, `stack.update`, and `stack.delete` for confirmed STACK management writes.

Settings reads the GenzoRoom build identity from the Frontend bundle without another request. Downloaded Developer Diagnostics JSON adds this `application` identity and one export-time `immich` result from the existing Backend `/immich/about` route. It uses the existing `server.about` scope; a denied/failed about request is recorded safely and does not imply Immich photo APIs are unavailable. The direct Backend Logs API remains its existing schema; Frontend downloads use diagnostics `schemaVersion: 2`.

These scopes cover current browsing, Export, tag repair and confirmed Stack/Trash operations. `server.about` is optional Settings information. No `asset.update`, `asset.copy`, `tag.update`, `tag.delete` or album write scope is required by current calls; Favorite inheritance is part of upload. Stack creation also requires ownership of the requested assets under Immich access validation. The endpoint-to-scope mapping and versioned upstream references are in [release-validation.md](release-validation.md#immich-api-key-scopes).

The nginx proxy keeps its normal 10-second read timeout for `/api/` requests. The exact `/api/stacks/apply` location uses 90 minutes because a 500-operation batch can make one membership preflight request and up to two sequential Immich writes per operation; at the backend's configured 5-second read timeout this is about 83 minutes 25 seconds, with margin for application processing. The three exact `POST /api/developer/export-engine` diagnostic locations (base, `/decode`, and `/roundtrip`) use a 1-hour proxy read timeout so long in-process image work is not cut off by the normal 10-second limit; the UI's manual Cancel/Abort remains the normal stop control. These proxy limits do not change the backend's Immich network timeout, response buffering, or the Stack endpoint's unknown-outcome behavior.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `IMMICH_URL` | Yes | Immich base URL as reached from the backend container. |
| `IMMICH_API_KEY` | Yes | Dedicated Immich API key. Keep the real value outside the repository. |
| `GENZOROOM_PORT` | No | Frontend host port; defaults to `3190`. |
| `GENZOROOM_IMAGE_TAG` | Distribution only, required | An already published validation tag or fixed stable version. No default, `latest` fallback or assumed available `v0.1.0`. |
| `GENZOROOM_PERSIST_ROOT` | Yes | Host application parent directory, mounted at `/genzoroom` in development and release. SQLite stays in its `data/genzoroom.db` subdirectory. |
| `IMMICH_DOCKER_NETWORK` | Same-host route only | Existing external Docker network used by Immich. |

Set `GENZOROOM_PERSIST_ROOT` to the existing application parent directory, not its `data` subdirectory. Compose requires this variable without nested interpolation. `GENZOROOM_DATA_PATH` is retired and ignored: an old setting alone fails Compose validation instead of silently falling back. For command-line Compose, supply values through the shell or an ignored `.env` file based on `.env.example`. For Portainer, configure them as Stack environment variables. Host paths are never passed to Backend. Never commit a real API key or bake it into a container image.

Before deployment, create the host parent directory, for example `/path/to/genzoroom`. The backend runs as UID/GID `10001:10001`; grant that user/group parent write/traverse access and existing `data`/DB read/write access, including SQLite WAL/SHM creation. `create_host_path: false` prevents implicit host-directory creation. Before Export recovery, Backend checks Linux mount information for the exact `/genzoroom` parent mount, creates only `data` if absent and probes file creation/write/removal there. It then validates existing SQLite integrity/schema and writer access before schema initialization. It never moves, overwrites or resets an existing DB. The DB is `/genzoroom/data/genzoroom.db`; mount the parent, not the DB file. Storage must support local SQLite WAL locking; verify this on the target Docker host.

Startup errors distinguish the failed check:

| Error code | Meaning / check |
| --- | --- |
| `storage_root_not_mounted` | The exact `/genzoroom` mount is missing or Linux mount information cannot be read. |
| `storage_root_may_be_data_directory` | A DB is at the mount root, but not at `data/genzoroom.db`; check that the parent rather than the old data directory was selected. No automatic move is performed. |
| `storage_data_not_writable` | Creating/accessing `data`, or the disposable file's create/write/flush/delete probe, failed. Check UID/GID permissions and read-only mounts. |
| `storage_database_unavailable` | An existing DB cannot be inspected/opened for SQLite writes, or DB/WAL/SHM access, I/O or writer-lock acquisition fails. This is separate from directory write access and from DB corruption. |
| `storage_database_empty` | An existing DB is zero bytes; it is rejected rather than treated as a fresh installation. |
| `storage_database_uninitialized` | An existing SQLite file has no supported GenzoRoom schema version. |
| `storage_database_corrupt` | SQLite integrity/format or required-schema validation failed. Preserve the files for diagnosis; there is no automatic repair. |
| `unsupported_db_schema` | The DB schema is newer than this Backend supports. |
| `persistence_unavailable` | SQLite schema initialization/migration or connection setup failed after preliminary validation, including for a new installation. |

For existing NAS data, use `/share/Container/genzoroom` for development and `/share/Container/genzoroom-release` for release validation. Their existing `data/genzoroom.db` files remain physically unchanged. Before redeployment, stop the writer and back up the complete data directory including WAL/SHM; remove `GENZOROOM_DATA_PATH` and verify the new parent resolves to that same existing DB. If the old override pointed to custom storage, explicitly choose a parent containing its existing `data/genzoroom.db`; do not guess a new root or start against an empty directory. A wrong existing root is indistinguishable from a deliberate fresh installation. Never run two Backends against one DB. Rollback requires stopping the new writer and restoring the previous Compose mount/settings against the same physical data, with no file conversion.

Future storage uses `/genzoroom/cache`, `/genzoroom/config` and `/genzoroom/logs` under the same parent mount, creating only directories actually needed by implemented features. They are not created now. An optional extra bind to `/genzoroom/cache` can place future cache data on another pool; the ordinary Compose needs no extra mounts.

## Choose an Immich connection route

GenzoRoom always uses `IMMICH_URL` and `IMMICH_API_KEY` at the application level. Choose an `IMMICH_URL` that is reachable from the backend container.

### Network-accessible Immich

Use `compose.release.yml` for distribution, or `docker-compose.yml` for development, when Immich is reachable through a LAN or routed address:

```env
IMMICH_URL=http://192.168.1.50:2283
IMMICH_API_KEY=replace-with-your-api-key
GENZOROOM_PORT=3190
```

An HTTPS URL such as `https://photos.example.com` can also be used. TLS certificate verification remains enabled. This route does not require access to an Immich Docker network.

### Immich on the same Docker host

Some Docker hosts cannot route a container back to a service through the host's own LAN address. In that case, connect only the GenzoRoom backend to Immich's existing Docker network and use the Immich server's Docker DNS name.

Identify the actual Immich network and service or container name before deployment. These values belong to the local environment and are not hardcoded by GenzoRoom. Example values are:

```env
IMMICH_DOCKER_NETWORK=your-existing-immich-network
IMMICH_URL=http://your-immich-server-name:2283
IMMICH_API_KEY=replace-with-your-api-key
```

The external network must already exist. Distribution uses `compose.release.yml` plus `compose.release.immich-network.yml`; Portainer Web editor can instead use the complete `compose.release.immich-standalone.yml` file described below. Development combines its standard configuration with `docker-compose.immich-network.yml`:

Distribution retains its project-local `outbound` bridge for the LAN/HTTPS route and adds the existing Immich network for Docker DNS access. `external: true` means Compose does not own/create the network; it does not guarantee internet/LAN egress (the existing network may be internal or have host-specific routing restrictions). The same-host standalone file retains `outbound` to match base+override and avoid assuming that existing network's egress settings. If the Immich network alone supplies all required reachability, including the selected `IMMICH_URL`, operators may omit `outbound` from the complete standalone file. This is an optional local simplification, not a prerequisite or extra security setting; no new network is added by this revision. A plain default bridge could also serve the LAN route, but renaming this already working bridge supplies no functional gain.

```sh
docker compose \
  -f docker-compose.yml \
  -f docker-compose.immich-network.yml \
  up -d --build
```

The override attaches only the backend to the external network. The frontend remains isolated from Immich. `IMMICH_DOCKER_NETWORK` is consumed by Compose and is not read by the GenzoRoom application.

## Install the GHCR distribution without cloning source

Obtain only `compose.release.yml` from the repository file download, after the maintainer has made this configuration available. For LAN/HTTPS Immich access this is the complete deployment file. For same-host Immich, also obtain `compose.release.immich-network.yml`, or use the single complete `compose.release.immich-standalone.yml` instead. These files contain `image:`, not `build:`. Do not use `--build` for distribution.

### Prepare storage and runtime settings

Install/start Docker Engine and Compose v2 (or a compatible newer Compose) on the target Linux amd64 host. Portainer must manage that same Docker Standalone endpoint. Prepare a local filesystem supporting SQLite WAL locks. For a new installation, replace this example path with the chosen application parent:

```sh
sudo mkdir -p /share/Container/genzoroom-release
sudo chown 10001:10001 /share/Container/genzoroom-release
sudo chmod u+rwx /share/Container/genzoroom-release
```

For existing installations, check ownership/access of `data`, DB and any WAL/SHM too; changing the parent alone does not grant access to existing children. Preserve the existing files. Select the application parent, never `data` itself. A new installation creates only `data`; existing installations continue using the same `data/genzoroom.db`. Stop the old writer before reusing its storage. Do not deploy development and distribution against the same DB together.

In Immich Settings, create a dedicated API key with the scopes listed in Requirements above. Set the actual reachable `IMMICH_URL` and the key as runtime values. For CLI use an untracked `.env` alongside the downloaded Compose file:

```env
GENZOROOM_IMAGE_TAG=replace-with-an-already-published-tag
GENZOROOM_PERSIST_ROOT=/share/Container/genzoroom-release
GENZOROOM_PORT=3190
IMMICH_URL=https://photos.example.com
IMMICH_API_KEY=replace-with-your-api-key
```

Copy the exact validation tag from the maintainer's successful workflow summary: `sha-<40-character-commit>-run<run-id>-attempt<attempt>`. Once a stable release has actually been published, use its fixed tag, for example `v0.1.0`; that example is not a claim it is available now. Leaving the tag or storage root empty makes Compose validation fail before pull/start. Do not share resolved Compose output containing the API key.

### CLI Compose

Run from the directory containing the Compose file and `.env`:

```sh
docker compose -f compose.release.yml config --quiet
docker compose -f compose.release.yml pull
docker compose -f compose.release.yml up -d
docker compose -f compose.release.yml ps
docker compose -f compose.release.yml logs --tail=100 genzoroom
```

A Public GHCR package requires no registry login. A pull failure may mean the tag is unpublished, the package is still Private or the host architecture is unsupported. Do not infer anonymous availability from a successful publishing workflow; maintainer checks are in [release-validation.md](release-validation.md#github-setup-and-anonymous-pull).

For same-host Immich, set `IMMICH_DOCKER_NETWORK` to the existing network and `IMMICH_URL` to the Immich server's actual Docker DNS name. Use both `-f compose.release.yml -f compose.release.immich-network.yml` on every command above. Neither file creates the Immich network. Using `-f compose.release.immich-standalone.yml` alone is equivalent.

### Portainer Web editor

Create a new Stack on the Docker Standalone endpoint. Select Web editor, paste the entire `compose.release.yml` for LAN/HTTPS or `compose.release.immich-standalone.yml` for same-host networking, and add the five runtime variables above under Stack environment variables. The same-host file also requires `IMMICH_DOCKER_NETWORK`. Pre-create the storage parent on the endpoint host, not on the computer running the browser. Deploy the Stack after an actual tag is Public and anonymously pullable. Do not select Git Repository build or paste only the small network override into Web editor.

### Verify, update and back up

Open `http://<host>:3190` (or the selected port), confirm Backend and Immich connection, and check `/api/health` and `/api/immich/status` as described under Verify below. Edit a test JPEG, wait for a confirmed Recipe/History save, recreate the container with the same parent, and reopen it to confirm restoration. Container replacement must preserve Queue/Runtime too; use the NAS checks in [release-validation.md](release-validation.md#nas-acceptance-checks).

Before updating, request Export Stop-after-current and wait for idle, complete edit saves, stop the sole writer and copy the entire `data` directory (DB plus any WAL/SHM) to a separate backup location. Record the previous image tag/digest and runtime settings. Do not copy a live DB alone. CLI update:

```sh
docker compose -f compose.release.yml stop
# Back up the stopped data/ here, then set GENZOROOM_IMAGE_TAG to the new published tag.
docker compose -f compose.release.yml config --quiet
docker compose -f compose.release.yml pull
docker compose -f compose.release.yml up -d
```

For Portainer, stop the service/Stack, back up the endpoint-host data, change `GENZOROOM_IMAGE_TAG` in Stack settings and use Update Stack with image pull/re-pull enabled. Confirm the new container's image and connection/save results. Re-pulling without changing a fixed tag is not version selection. UI wording depends on Portainer version. Keep the same Compose file/network route and storage parent during updates. To roll back, stop the new writer first; use the previous image only if its schema is compatible, otherwise restore the consistent pre-update backup and matching image. No automatic downgrade, file move or data conversion is provided. `down` or Stack removal retains bind-mounted host data and the external Immich network.

## Development: deploy source with Docker Compose

1. Clone the repository into a deployment directory, or place the complete repository contents there by another method. Do not copy local `node_modules`, virtual environments, or build output.
2. Supply the environment variables described above. To use a local `.env` file, copy `.env.example`, replace its example values, and keep `.env` untracked.
3. Validate, build, and start the standard deployment:

   ```sh
   docker compose config
   docker compose up -d --build
   docker compose ps
   ```

For the same-host Immich route, include both Compose files in validation and operational commands:

```sh
docker compose -f docker-compose.yml -f docker-compose.immich-network.yml config
docker compose -f docker-compose.yml -f docker-compose.immich-network.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.immich-network.yml ps
```

The frontend image uses Vite only during the build. nginx serves the resulting static files in the running container. To update a repository checkout, obtain the new repository contents and run the appropriate `up -d --build` command again.

### Optional checks before deployment

Local checks can catch syntax and configuration errors, but they do not replace validation on the target Docker host. The current development toolchain uses Node.js 24 and Python 3.14. Start from the repository root with a Python virtual environment activated:

```sh
cd frontend
npm ci
npm test
npm run build

cd ../backend
python -m pip install -r requirements.txt
python -m py_compile main.py immich.py edit_state.py edit_store.py
python -m unittest discover -s tests

cd ..
docker compose config
```

Run the Backend checks from `backend/` so the tests can import `main` and `immich`. For the same-host Immich route, use both Compose files for the final configuration check as shown above.

For optional frontend development, `npm run dev` proxies `/api/` to loopback port `8000`. A directly launched Backend now requires a writable Linux parent mount at `/genzoroom`, just like the containers; unmounted Windows/local starts deliberately fail. Automated Backend tests inject temporary storage separately. The Vite development server is not used in deployed containers.

## Development: deploy with a Portainer Git Repository Stack

Portainer can fetch, build, and deploy GenzoRoom directly from any Git repository it can access. Manual copying to the deployment host is not required.

1. Create a Stack using a Git repository as its source or build method.
2. Enter the repository URL and select the required branch or reference.
3. Set the Compose path to `docker-compose.yml`.
4. Add `IMMICH_URL` and `IMMICH_API_KEY` as Stack environment variables. Set `GENZOROOM_PERSIST_ROOT` to the prepared application parent directory (not `data`). Remove the retired `GENZOROOM_DATA_PATH` setting. Add `GENZOROOM_PORT` only to change the default port.
5. Build and deploy the Stack.

For same-host Immich networking, add `docker-compose.immich-network.yml` as an additional Compose path and set `IMMICH_DOCKER_NETWORK` to the existing Immich network name. The Stack must target the Docker endpoint where that network exists.

After repository updates become available, use Portainer's pull and redeploy action to rebuild and update the Stack. UI labels vary between Portainer versions, but the workflow must refresh the Git source and recreate the services from the current Compose configuration.

The current configuration targets Docker Standalone and is not a Docker Swarm deployment.

## Verify the deployment

1. Open `http://<HOST-IP>:3190`, or the configured `GENZOROOM_PORT`.
2. Confirm that the UI reports `Backend: Connected` and `Immich: Connected`.
3. Confirm that recent photos and thumbnails appear.
4. Select or open a photo and confirm that Anshitsu loads its preview and available EXIF data.
5. Open `http://<HOST-IP>:3190/api/health` and confirm:

   ```json
   {"status":"ok"}
   ```

6. Open `http://<HOST-IP>:3190/api/immich/status` and confirm:

   ```json
   {"configured":true,"connected":true}
   ```

Missing connection variables produce `Immich: Not configured`. Rejected credentials, unreachable servers, insufficient permissions, or unexpected Immich responses produce a failed connection or photo-loading state without exposing the API key.

Successful execution in a local development environment does not establish deployment compatibility. Verify container startup, proxy behavior, browser access, photo loading, and failure recovery on the target Docker host.

## Logs and troubleshooting

Distribution uses `docker compose -f compose.release.yml logs genzoroom` (include the selected network file when applicable). Development uses both service logs:

```sh
docker compose logs frontend backend
```

When using the same-host override, include both `-f` arguments in operational commands. Portainer users can inspect the equivalent container logs and console through the Stack's Docker environment.

Check the following when the backend or Immich connection fails:

- Confirm that `IMMICH_URL` is reachable from the backend container, including its scheme, host, and port.
- Confirm that `IMMICH_API_KEY` is current and has the scopes listed under Requirements; use the endpoint mapping in [release-validation.md](release-validation.md#immich-api-key-scopes) for Export, Trash, Calendar, Album and Tag failures.
- If the connection check succeeds but photos fail, verify `asset.read` and `asset.view` specifically.
- If photo browsing works but STACK management cannot resolve or send Stacks, verify `stack.read` and the required `stack.create`, `stack.update`, and `stack.delete` permissions. `asset.download` is used only for selected JPEG originals; `server.about` is optional Settings information.
- For same-host deployments, confirm the external network name, Immich Docker DNS name, additional Compose path, and Docker endpoint.
- Backend port `8000` is intentionally unavailable from the host; test through the frontend's `/api/` routes.

To check failure recovery, stop the backend, use **Check again** in the UI, restart the backend, allow time for startup and Docker DNS refresh, and check again.

## Security and host isolation

- Only nginx port `8080` is published. Backend `8000` is loopback in distribution or on the internal Docker network in development.
- The Immich API key is supplied only to the backend and must not be stored in the repository.
- The development same-host override attaches only Backend to Immich. Distribution attaches the combined nginx/Backend container; both processes share that network namespace, while Uvicorn still binds only loopback.
- Both containers run as non-root users, drop Linux capabilities, and disable privilege escalation.
- The Compose files do not use privileged mode or host networking. The development backend (or release service) mounts only the application parent at `/genzoroom`.
- TLS certificate verification for HTTPS Immich URLs remains enabled.
- GenzoRoom does not require changes to Docker host OS settings or system files.

## Stop or remove GenzoRoom

Stop and remove the distribution with `docker compose -f compose.release.yml down`, including the selected network override when used, or `-f compose.release.immich-standalone.yml` for the complete same-host file. Development uses:

```sh
docker compose down
```

For a same-host deployment, use the same pair of Compose files:

```sh
docker compose -f docker-compose.yml -f docker-compose.immich-network.yml down
```

In Portainer, remove the GenzoRoom Stack. The shared Immich network is external and is not removed by GenzoRoom Compose commands.

The backend data bind mount remains on the host when the Stack is removed; do not remove it without checking saved edits. Anshitsu autosaves dirty JPEG edit state after five seconds without an edit, saves a dirty photo before a Filmstrip switch, and performs a final sequential save with History compaction for all photos edited in that Anshitsu session when the Home control is used. If a final save fails, the user can stay in Anshitsu or exit without saving; already confirmed saves remain in the database. Browser Back, page reload, tab close, and browser close do not trigger a final save, so edits from the last debounce interval or an in-flight request may be lost. For backup, stop the backend container and copy the entire data directory. Do not recommend copying a live `genzoroom.db` alone while WAL is active; a future online backup may use SQLite's backup API.
