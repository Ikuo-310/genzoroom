# Single-container release validation

Distribution uses a prebuilt GHCR image and one nginx/FastAPI container. Development continues to build two containers through unchanged `docker-compose.yml` and `docker-compose.immich-network.yml` from `main`. Both mount the application storage parent at `/genzoroom`. The workflow/configuration is implemented here; no actual Actions run, registry publication, Git tag, `latest` alias or GitHub Release is performed by this change. Do not assume an image exists until the maintainer completes the steps below.

## Maintainer publishing workflow

`.github/workflows/publish-image.yml` builds `Dockerfile.release` with the checked-out source directory as context. Docker official actions and checkout are pinned to verified release commit SHAs. `contents: read` is the workflow default; only the publish job receives `packages: write`. Login uses `GITHUB_TOKEN` after the smoke test, with no PAT or Immich secret. Source/revision/version OCI labels identify the exact source and image tag. Checkout credentials are not persisted. No PR or ordinary branch-push publishing trigger is present.

The 2026-10-10 pre-release review checked the following non-prerelease official releases, tag-to-commit refs and their pinned `action.yml` definitions. All use `node24`; their previously pinned versions used `node20`. All three checkout steps retain `persist-credentials: false`. Current inputs remain supported: checkout's fork-PR protection does not affect these dispatch/tag triggers; Buildx removed deprecated inputs not used here; login's optional authentication scope remains unset, preserving ordinary Docker CLI push authentication. Node 24 requires Actions Runner 2.327.1 or newer; this workflow continues using GitHub-hosted `ubuntu-24.04`, not a self-hosted runner. No runtime-forcing environment variable is used.

| Official release | Fixed commit SHA |
| --- | --- |
| [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| [docker/setup-buildx-action v4.4.1](https://github.com/docker/setup-buildx-action/releases/tag/v4.4.1) | `f87e5991a6d7451dcb8d9637bfbc97413f497069` |
| [docker/build-push-action v7.4.0](https://github.com/docker/build-push-action/releases/tag/v7.4.0) | `c3c9e263c25d99ce0380d002d59b67737d91b0dc` |
| [docker/login-action v4.6.0](https://github.com/docker/login-action/releases/tag/v4.6.0) | `dbcb813823bdd20940b903addbd779551569679f` |

Reported NAS validation of the previous GHCR image covers installation, Immich connection, existing Recipe/Queue restoration, edits surviving restart and storage surviving Portainer Stack removal/recreation. It does not validate these updated Actions or an update between different image tags. After this revision is merged, the maintainer must manually dispatch a second validation image and test that tag change with the same storage parent before the formal release decision. No formal `v0.1.0` tag or GitHub Release is to be created until then.

After the maintainer reviews and merges this configuration into `main`, open repository **Actions → Publish distribution image → Run workflow**. Select branch `main` and supply the full 40-character SHA of the main-history source to validate. An arbitrary branch dispatch is skipped; malformed SHAs and commits outside main history fail before the write-permission job starts. The selected source must contain a compatible `Dockerfile.release`, current storage layout and schema v4. Trusted automation is checked out separately from that source, so an earlier main commit cannot replace the publishing scripts. Reference: [GitHub manual workflow documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

| Event | Image tag | Conditions |
| --- | --- | --- |
| Manual dispatch on main | `sha-<full-commit-sha>-run<run-id>-attempt<attempt>` | Exact source commit already belongs to main; each run/retry gets its own tag. |
| Future stable tag push | `vMAJOR.MINOR.PATCH` | Strict numeric version without leading zeroes or prerelease/build suffix; tagged commit belongs to main and still matches the triggering commit. |

The push filter `v*.*.*` is only an initial filter; the script rejects `v0.1.0-rc.1` and similar prereleases. Validation never creates a stable version alias. Stable publishing creates no `latest` alias either. Do not push a formal `v0.1.0` tag during this validation phase. Git tags/Releases are never created by the workflow. Restrict main modifications, workflow dispatch rights and `v*` tag creation/update/deletion to trusted maintainers with repository branch/tag rulesets; a workflow cannot protect itself against someone authorized to replace its contents. Avoid moving stable tags or rerunning them to change a previously distributed image; the reported digest is the immutable deployment identity.

Only `linux/amd64` is built. Registry manifest inspection confirms `python:3.14-slim` includes linux arm64, and the pinned [numpy 2.5.3](https://pypi.org/project/numpy/2.5.3/#files) / [Pillow 12.3.0](https://pypi.org/project/Pillow/12.3.0/#files) releases provide CPython 3.14 manylinux aarch64 wheels. These prerequisites are not evidence of a working complete arm64 image: this environment has no running Docker Engine to verify Buildx/QEMU, frontend build, installation and startup there. Do not add or advertise arm64 until those checks pass. No QEMU action is needed for the native amd64 GitHub runner.

The workflow first loads the image locally, then runs a disposable bind-mounted container without Immich credentials. `release/smoke-test.sh` checks nginx `/api/health` proxying, UID/GID 10001, nginx configuration, SQLite schema/WAL/writer access, absence of Node/npm, source metadata and clean SIGTERM shutdown. The exact local image that passes is pushed, without rebuilding. A failing build or smoke test prevents login/push. This smoke check does not test real Immich, Export remote outcomes or NAS permissions. It must still be executed successfully in Actions; local static checks cannot claim it passed.

The summary records image reference, source SHA and registry digest. Track repeat builds of the same commit by the SHA prefix plus run/attempt and OCI revision. Dependencies are version-pinned but base-image tags and OS package repositories can change; a source SHA is not a promise of byte-for-byte reproducible builds. Preserve the published digest for exact identification. Loading a single-platform image disables provenance attestations; OCI source/revision labels are provided, not cryptographic provenance.

## GitHub setup and anonymous pull

1. In repository Settings → Actions, enable Actions and allow the pinned `actions/checkout` and Docker official actions. Repository/organization policy must permit this publish job's `GITHUB_TOKEN` to write packages; no user API key is needed. If a package already exists without repository linkage, open its Package settings → Manage Actions access and grant this repository Write access (or confirm inherited repository access).
2. After the first successful maintainer dispatch, open the owner's GitHub profile → Packages → `genzoroom` → Package settings. Check the repository link is `Ikuo-310/genzoroom`; publishing with `GITHUB_TOKEN` and the OCI source label links it. First publication is Private by default, independently of repository visibility.
3. At Package settings → Danger Zone → Change visibility, select Public, type the package name and confirm the visibility change. Public visibility cannot later be reverted to Private. See [GitHub package visibility and access documentation](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility) and [GHCR authentication/linking documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
4. On a Docker host without GHCR credentials, verify anonymous pull of the exact tag from the workflow summary. To avoid inherited credentials, use an empty temporary Docker CLI config for the default local endpoint:

   ```sh
   published_tag='replace-with-the-actual-tag-from-the-workflow-summary'
   anonymous_config=$(mktemp -d)
   docker --config "$anonymous_config" pull "ghcr.io/ikuo-310/genzoroom:$published_tag"
   rmdir "$anonymous_config"
   ```

   If the target uses a named/remote context, preserve its endpoint selection explicitly; an empty config does not inherit named contexts. Confirm the reported digest matches the workflow summary. Workflow success proves neither Public visibility nor anonymous pull. An ordinary-user install requires both checks.

## Configure validation deployment

Use a separate Portainer **Web editor** Stack with the complete `compose.release.yml` for LAN/HTTPS, or complete `compose.release.immich-standalone.yml` for same-host Immich. CLI may instead combine the base and `compose.release.immich-network.yml`. Set `IMMICH_DOCKER_NETWORK` to an existing network; neither route creates it. Both use runtime `IMMICH_URL` / `IMMICH_API_KEY`. No source build is required by users. Follow [deployment.md](deployment.md#install-the-ghcr-distribution-without-cloning-source) for storage preparation, API scopes, CLI and Portainer steps.

Set `GENZOROOM_PERSIST_ROOT` to the host parent (for NAS validation, `/share/Container/genzoroom-release`) and prepare that parent first. UID/GID `10001:10001` needs access to the root, `data` and the existing DB, including WAL/SHM creation. The single parent bind maps to `/genzoroom`; Backend creates `data` only when absent and verifies mount/write access before recovery. Missing host roots are refused with `create_host_path: false`; missing container mounts or unwritable data abort Backend startup and terminate the release container through supervision. Existing DBs are used without relocation or format changes. Remove retired `GENZOROOM_DATA_PATH`; it no longer supplies a mount source, and setting it alone fails Compose validation. Check the selected parent contains the intended existing `data/genzoroom.db` before deploying. Use local storage supporting SQLite locking.

For validation set `GENZOROOM_PORT=3191` in Portainer; the default remains 3190. Use a separate Stack/project name and storage parent with its own `data` restored from a consistent stopped-container backup. Request Export Stop and wait for idle before making that validation copy: an active Runtime copied into another DB can resume automatically against the configured Immich, and separate storage roots alone do not prevent two copies from replaying the same remote intent. Use test assets for recovery checks. The copied `/share/Container/genzoroom-release/data/genzoroom.db` needs no move; development keeps `/share/Container/genzoroom/data/genzoroom.db`. **Do not run development and release Backends against the same database simultaneously**: Export recovery assumes one Backend process, not a distributed lease. Stop the old deployment before switching the production storage parent to the release Stack.

```sh
docker compose -p genzoroom-release -f compose.release.yml config --quiet
docker compose -p genzoroom-release -f compose.release.yml pull
docker compose -p genzoroom-release -f compose.release.yml up -d
# Same-host route: add this argument to every command:
# -f compose.release.immich-network.yml
```

Set `GENZOROOM_IMAGE_TAG` to an actually published tag first; no default is supplied. The maintainer build uses Node 24 and the existing Frontend production build, then copies only its output. Python dependencies use existing pinned requirements on Python 3.14. The final Python slim image adds nginx and tini; no Node or Frontend development dependencies are copied. `Dockerfile.release.dockerignore` allows only required build inputs; `.env`, data, Git, automation files and local dependencies are excluded. Credentials are runtime environment values, never build arguments or frontend inputs.

## Process and persistence behavior

tini is PID 1, forwards termination to the Python supervisor and reaps orphaned descendants. Each service has its own process group. The supervisor detects any unsolicited nginx/Uvicorn exit (including exit code zero), stops the survivor, reaps children and exits nonzero. Compose can then restart the whole container with `unless-stopped`; no half-running service is retained.

SIGTERM/SIGINT requests nginx graceful QUIT and Uvicorn TERM. The supervisor allows 60 seconds for shutdown, then kills remaining groups and exits nonzero. Compose gives 75 seconds before Docker's own SIGKILL. Existing FastAPI lifespan waits for tag repair and Export Runtime; it may drain the entire run, rather than imply Stop-after-current. If the drain exceeds 60 seconds, persisted checkpoints remain for existing startup recovery. The limit is not a guarantee that a large JPEG or long Export finishes during shutdown. Request Stop in the application and wait for idle when a planned maintenance stop must finish the current item first.

Uvicorn has exactly one worker and binds `127.0.0.1:8000`; nginx alone listens externally on 8080. Both use UID/GID `10001:10001`, drop all capabilities and disable privilege escalation. nginx PID/temp files are under `/tmp`; SQLite uses `/genzoroom/data/genzoroom.db` with unchanged schema/formats. Release and development nginx share all location bodies, 8 MiB request limit, 3-second connect timeout, general 10-second read timeout, Stack 90-minute exception and the three Export Engine 1-hour exceptions. Only the upstream becomes loopback.

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

1. Complete the maintainer dispatch, Public visibility and separate anonymous pull/digest checks above. Use a published validation tag in the downloaded Compose (or pasted Portainer Web editor), start both processes, check nginx configuration and obtain `{"status":"ok"}` from `http://<host>:3191/api/health`. Confirm Immich connection by both LAN and optional external-network routes. Test missing image-tag/storage-root settings, missing host directory and missing external network: each must refuse deployment.
2. Inspect process UID/GID, capabilities and privilege settings. Confirm only 8080 is exposed/listening externally and 8000 is loopback. Verify Node/npm are absent from the runtime image.
3. Confirm the intended existing DB is visible at `/genzoroom/data/genzoroom.db`, with saved Recipe/History, Queue and Runtime preserved. Check saves and WAL/SHM creation/reopening. In disposable test roots, check automatic `data` creation, unwritable data startup failure and missing `/genzoroom` mount failure without an empty DB. Confirm nonexistent host roots and retired-variable-only settings refuse deployment. Verify development/release use the same layout with separate roots; no unused cache/config/logs directories should appear. Future cache may optionally bind another pool at `/genzoroom/cache` without altering DB storage.
4. Send SIGTERM with idle Runtime and confirm clean exit within the grace period. Kill nginx and, separately, Uvicorn in a disposable test Stack; confirm supervisor/container exit and whole-service restart. Check no orphaned children remain.
5. With test assets, verify Stop-after-current, Retry and restart during encoding/registration, including persisted Stop intent, duplicate upload convergence, unknown responses and Queue removal only after complete success. Allow existing partial-output limitations. Test planned stops both within and beyond the drain limit.
6. Use the existing hidden Diagnostics entry and verify separate log levels, JSON downloads, WebGPU, Real JPEG and all three Export Engine operations. Browser secure-context requirements for WebGPU remain unchanged.
7. Save Recipe/History, stop and back up `data` including WAL/SHM, then update to another published tag using pull/recreate (Portainer: change tag and re-pull on Update Stack). Confirm the selected image/digest, existing DB and Queue/Runtime survive replacement. Check CLI base+override and the single-file Portainer same-host example both attach the existing network. Roll back with the previous compatible image or the matching stopped backup; do not run a second writer against the same root.

Before backup or rollback, stop the sole writer and copy the complete data directory including any WAL/SHM. No new migration/downgrade is provided. Static Windows tests and Compose parsing do not establish Linux container or NAS/Firefox behavior.
