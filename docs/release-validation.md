# Single-container release validation

Distribution uses a prebuilt GHCR image and one nginx/FastAPI container. Development continues to build two containers through unchanged `docker-compose.yml` and `docker-compose.immich-network.yml` from `main`. Both mount the application storage parent at `/genzoroom`. This workflow change has not been run: no image, Git tag or GitHub Release is created as part of this implementation task. Do not assume a tag exists until the maintainer runs the workflow.

## Maintainer publishing workflow

`.github/workflows/publish-image.yml` builds `Dockerfile.release` with the checked-out source directory as context. Docker official actions and checkout are pinned to verified release commit SHAs. `contents: read` is the workflow default; the publish job alone receives `packages: write`, and a dependent stable-release job alone receives `contents: write`. Login and Release creation use `GITHUB_TOKEN`; no PAT or Immich secret is used. OCI source/revision labels identify the source; the OCI version label matches the embedded application version (`0.0.0-validation` or the stable version). Checkout credentials are not persisted. No PR or ordinary branch-push publishing trigger is present.

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
| Stable tag push | Fixed `vMAJOR.MINOR.PATCH`, plus `latest` when this is not older than the current latest | Strict numeric version without leading zeroes or prerelease/build suffix; tagged commit belongs to main, still matches the triggering commit, and its CHANGELOG section exists. |

The push filter `v*.*.*` is only an initial filter; the script rejects `v0.1.0-rc.1` and similar prereleases. A manual validation build keeps its unique SHA/run/attempt tag and only eligible current-main validation builds update `alpha`; neither `latest` nor a GitHub Release is touched. A stable tag publishes the version tag after Smoke Test and advances `latest` only if the target SemVer is newer than the existing OCI version (or `latest` is a validation image). Re-running an older tag therefore cannot roll `latest` back. An existing version tag is never overwritten: when the local rebuild differs, its source/version labels must match and the already-published image passes Smoke Test again before it is reused; mismatched metadata fails closed. It verifies registry digest equality whenever `latest` points to the target version. Once GHCR checks succeed, a separate least-privilege job creates a public, non-draft, non-prerelease GitHub Release using `--verify-tag`; the existing Git tag is required and no tag is generated. An existing correctly named Release is reused without editing its body; inconsistent Release metadata fails unchanged.

The Release body is extracted from only `## [vX.Y.Z]` or `## [X.Y.Z]` in the tagged source's `CHANGELOG.md`, and includes the fixed GHCR image reference and deployment-guide link. Missing, duplicate or empty version sections stop the workflow before image publication. `CHANGELOG.md` now has a concise `v0.1.0` section dated `2026-10-10`; review that it still matches the final release contents and publication date before pushing the tag. The older detailed entries are retained under `Development history before v0.1.0`, outside the generated Release Notes. The workflow does not infer or rewrite changelog content. No formal `v0.1.0` tag or GitHub Release has been created by this documentation update. Restrict main modifications, workflow dispatch rights and `v*` tag creation/update/deletion to trusted maintainers with repository branch/tag rulesets; a workflow cannot protect itself against someone authorized to replace its contents. Avoid moving stable tags or rerunning them to change a previously distributed image; the reported digest is the immutable deployment identity.

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

Use `compose.release.yml` for LAN/HTTPS or combine it with `compose.release.immich-network.yml` for same-host Immich. Set `IMMICH_DOCKER_NETWORK` to an existing network; the override does not create it. Both configurations use runtime `IMMICH_URL` / `IMMICH_API_KEY`. No source build is required by users. Follow [deployment.md](deployment.md) for storage preparation, API scopes, and Compose steps.

Set `GENZOROOM_PERSIST_ROOT` to the host parent (for NAS validation, `/share/Container/genzoroom-release`) and prepare that parent first. UID/GID `10001:10001` needs access to the root, `data` and the existing DB, including WAL/SHM creation. The single parent bind maps to `/genzoroom`; Backend creates `data` only when absent and verifies mount/write access before recovery. Missing host roots are refused with `create_host_path: false`; missing container mounts or unwritable data abort Backend startup and terminate the release container through supervision. Existing DBs are used without relocation or format changes. Remove retired `GENZOROOM_DATA_PATH`; it no longer supplies a mount source, and setting it alone fails Compose validation. Check the selected parent contains the intended existing `data/genzoroom.db` before deploying. Use local storage supporting SQLite locking.

For validation set `GENZOROOM_PORT=3191` in Portainer; the default remains 3190. Use a separate Stack/project name and storage parent with its own `data` restored from a consistent stopped-container backup. Request Export Stop and wait for idle before making that validation copy: an active Runtime copied into another DB can resume automatically against the configured Immich, and separate storage roots alone do not prevent two copies from replaying the same remote intent. Use test assets for recovery checks. The copied `/share/Container/genzoroom-release/data/genzoroom.db` needs no move; development keeps `/share/Container/genzoroom/data/genzoroom.db`. **Do not run development and release Backends against the same database simultaneously**: Export recovery assumes one Backend process, not a distributed lease. Stop the old deployment before switching the production storage parent to the release Stack.

```sh
docker compose -p genzoroom-release -f compose.release.yml config --quiet
docker compose -p genzoroom-release -f compose.release.yml pull
docker compose -p genzoroom-release -f compose.release.yml up -d
# Same-host route: add this argument to every command:
# -f compose.release.immich-network.yml
```

Set `GENZOROOM_IMAGE_TAG` to the intended published validation tag explicitly for maintainer checks; the distribution Compose defaults to `latest`. The maintainer build uses Node 24 and the existing Frontend production build, then copies only its output. Python dependencies use existing pinned requirements on Python 3.14. The final Python slim image adds nginx and tini; no Node or Frontend development dependencies are copied. `Dockerfile.release.dockerignore` allows only required build inputs; `.env`, data, Git, automation files and local dependencies are excluded. Credentials are runtime environment values, never build arguments or frontend inputs.

## Process and persistence behavior

tini is PID 1, forwards termination to the Python supervisor and reaps orphaned descendants. Each service has its own process group. The supervisor detects any unsolicited nginx/Uvicorn exit (including exit code zero), stops the survivor, reaps children and exits nonzero. Compose can then restart the whole container with `unless-stopped`; no half-running service is retained.

SIGTERM/SIGINT requests nginx graceful QUIT and Uvicorn TERM. The supervisor allows 60 seconds for shutdown, then kills remaining groups and exits nonzero. Compose gives 75 seconds before Docker's own SIGKILL. Existing FastAPI lifespan waits for tag repair and Export Runtime; it may drain the entire run, rather than imply Stop-after-current. If the drain exceeds 60 seconds, persisted checkpoints remain for existing startup recovery. The limit is not a guarantee that a large JPEG or long Export finishes during shutdown. Request Stop in the application and wait for idle when a planned maintenance stop must finish the current item first.

Uvicorn has exactly one worker and binds `127.0.0.1:8000`; nginx alone listens externally on 3190. Both use UID/GID `10001:10001`, drop all capabilities and disable privilege escalation. nginx PID/temp files are under `/tmp`; SQLite uses `/genzoroom/data/genzoroom.db`. Schema v6 adds per-item Export timestamps for unchanged registration Retry; the transactional migration backfills existing run items from their parent run's `created_at`. Release and development nginx share all location bodies, 8 MiB request limit, 3-second connect timeout, general 10-second read timeout, Stack 90-minute exception and the three Export Engine 1-hour exceptions. Only the upstream becomes loopback.

Recipe and History formats are unchanged. Export registration now resolves source Album membership, uploads and tags the output, adds it to every source Album, then creates or updates the Stack and verifies the output COVER. Any Album addition failure stops the item before Stack processing; successful earlier Album additions and the uploaded output can remain. Recovery reuses frozen Recipe/revision/timestamp, regenerates JPEGs and relies on Immich checksum duplicate handling, tag reapplication and current Stack inspection. An unchanged explicit Retry after registration failure also reuses the item's Export timestamp. Unknown remote outcomes retain existing handling; duplicate prevention is not a distributed transaction or an absolute guarantee. Stop intent remains durable and completes the recovered current item before releasing the suffix.

The existing Developer Diagnostics build and hidden entry operation remain. Frontend/Backend structured buffers, independent levels, JSON reports, WebGPU, Real JPEG and Export Engine remain available. Release validation should check that Settings shows the validation channel and short source SHA without a version-check request. Every downloaded diagnostics file uses schemaVersion 2 with matching build metadata and one safe `server.about` result; the direct Backend Logs API remains schemaVersion 1. About failures do not block downloads or imply photo API failure. Local diagnostics API failures use `backend_unreachable` for network/timeout, or `backend_request_failed` for non-2xx responses; upstream Immich failures retain their existing `ImmichAbout` error codes. Container stdout is shared infrastructure output, separate from those application diagnostic buffers. No menu or public entry point is added.

## Immich API key scopes

The current calls were checked against Immich **v3.2.4** controller permission decorators, the version used by the existing Export contract. These are API key scopes, separate from Immich ownership/access checks. Paths below are relative to Immich's `/api`.

| Scope | Current request / purpose |
| --- | --- |
| `user.read` | `GET /users/me`, `/users/me/calendar-heatmap`; connection and Calendar |
| `asset.read` | `GET /assets/{id}`, `POST /search/metadata`, `GET /timeline/bucket`; browsing, family discovery, registration verification |
| `asset.view` | `GET /assets/{id}/thumbnail`; thumbnails and previews |
| `asset.download` | `GET /assets/{id}/original`; JPEG originals |
| `album.read` | `GET /albums`; Home albums and Export source membership via `assetId` (album members use metadata search) |
| `albumAsset.create` | `PUT /albums/{id}/assets`; add Export outputs, Stack COVERs and released photos |
| `albumAsset.delete` | `DELETE /albums/{id}/assets`; normalize ordinary non-COVER members |
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

Current code does not call Asset update/copy, Tag update/delete or permanent asset deletion. Album writes add only the exported JPEG to its source's Albums and require the configured user to own the Album or have Editor access. Do not grant unrelated extra scopes for these features. `asset.delete` itself can authorize broader deletion in Immich; GenzoRoom limits its current request to Trash. Verify the same mapping against the deployed Immich version if different.

`album.read` resolves source membership with `GET /albums?assetId={sourceAssetId}`. The output is added with `PUT /albums/{albumId}/assets`, which requires `albumAsset.create`; `album.create` is not the permission for adding an Asset to an Album. A 403 or other failed Album addition stops Export before Stack creation.

### Album Export verification record

Manual verification on Immich v3.3.3 confirmed that an Album member can be exported, the generated JPEG is added to the source Album and becomes the Stack COVER, and the photo remains visible after reloading the GenzoRoom Album. The Stack membership was correct. Immich's native Album screen may omit its Stack icon despite correct Album membership and Stack structure; this is separate from the GenzoRoom issue, and no GenzoRoom display correction was added.

The related Backend tests passed: 300 tests and 10 subtests. The complete Backend suite passed 1,163 tests and 326 subtests. `git diff --check` passed, and the database assertions embedded in the Smoke Test passed for schema v6 and the `export_timestamp` column. The full Docker Smoke Test was not recorded as run here. No Frontend code changed; Frontend tests and build were not run.

## NAS acceptance checks

1. Complete the maintainer dispatch, Public visibility and separate anonymous pull/digest checks above. Set `GENZOROOM_IMAGE_TAG` to the published validation tag and `GENZOROOM_PORT=3191`, then use `compose.release.yml` (optionally combined with `compose.release.immich-network.yml`) to start both processes. Check nginx configuration and obtain `{"status":"ok"}` from `http://<host>:3191/api/health`. Confirm Immich connection by both LAN and optional external-network routes. Test omitted/alternate image tags resolve to `latest`/the selected release, and test missing storage-root settings, missing host directory and missing external network so deployment is refused.
2. Inspect process UID/GID, capabilities and privilege settings. Confirm only 3190 is exposed/listening externally and 8000 is loopback. Verify Node/npm are absent from the runtime image.
3. Confirm the intended existing DB is visible at `/genzoroom/data/genzoroom.db`, with saved Recipe/History, Queue and Runtime preserved. Check saves and WAL/SHM creation/reopening. In disposable test roots, check automatic `data` creation, unwritable data startup failure and missing `/genzoroom` mount failure without an empty DB. Confirm nonexistent host roots and retired-variable-only settings refuse deployment. Verify development/release use the same layout with separate roots; no unused cache/config/logs directories should appear. Future cache may optionally bind another pool at `/genzoroom/cache` without altering DB storage.
4. Send SIGTERM with idle Runtime and confirm clean exit within the grace period. Kill nginx and, separately, Uvicorn in a disposable test Stack; confirm supervisor/container exit and whole-service restart. Check no orphaned children remain.
5. With test assets, verify Stop-after-current, Retry and restart during encoding/registration, including persisted Stop intent, duplicate upload convergence, unknown responses and Queue removal only after complete success. For Album members, confirm the generated JPEG joins every source Album before Stack creation, becomes the COVER, and remains visible in GenzoRoom after Album Reload. Check Immich Album membership and Stack structure separately from whether its native Album UI shows a Stack icon. Allow existing partial-output limitations. Test planned stops both within and beyond the drain limit.
6. Use the existing hidden Diagnostics entry and verify separate log levels, JSON downloads, WebGPU, Real JPEG and all three Export Engine operations. Browser secure-context requirements for WebGPU remain unchanged.
7. Save Recipe/History, stop and back up `data` including WAL/SHM, then update to another published tag using pull/recreate. Confirm the selected image/digest, existing DB and Queue/Runtime survive replacement. Check the base Compose and optional external-network override both attach as configured. Roll back with the previous compatible image or the matching stopped backup; do not run a second writer against the same root.

Before backup or rollback, stop the sole writer and copy the complete data directory including any WAL/SHM. Schema v6 upgrades existing databases transactionally; there is no downgrade migration, so returning to a pre-v6 version requires restoring the pre-upgrade backup. Static Windows tests and Compose parsing do not establish Linux container or NAS/Firefox behavior.

### Stack Album normalization validation

The key needs `album.read`, `albumAsset.create`, and `albumAsset.delete`; no new `album.update` or `album.delete` is required. Validate multi-Album creation (JPEG/RAW in different Albums), COVER changes, member moves, ordinary departures, and dissolution expanding the union to all released photos. Confirm trash reservations keep membership and existing COVER/RAW protections. Non-Album operations must issue no Album writes. Lookup/pre-add failure must stop the affected Stack operation; cleanup failure preserves Stack success without rollback. Item-level duplicate additions and not_found removals are satisfied, but HTTP 404 and permission failures are not. Validate Owner and Editor access, including individual removal denial. Membership is read live for Albums visible to the configured user, with no DB mirror, historical restoration, post-send Undo, or restart recovery. Live Immich verification remains a maintainer task.
