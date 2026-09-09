# Provisional Architecture

**Status: Early Development — authenticated photo browsing and the initial Anshitsu workspace are implemented. Photo development and image adjustment are not implemented.**

This document describes the current minimal implementation and possible future extensions. The architecture remains provisional: components, interfaces, and deployment choices may change during development.

## Current request flow

```text
Browser: http://<NAS-IP>:3190
  ↓
Frontend: nginx on container port 8080
  ├─ /             → built React / TypeScript frontend
  ├─ /api/health         → internal Docker network
  ├─ /api/immich/status  → internal Docker network
  ├─ /api/assets/recent        → internal Docker network
  ├─ /api/assets/{id}          → internal Docker network
  ├─ /api/assets/{id}/thumbnail → internal Docker network
  └─ /api/assets/{id}/preview  → internal Docker network
                       ↓
                     Backend: Uvicorn / FastAPI on port 8000
                       ├─ GET /health → {"status":"ok"}
                       ├─ GET /immich/status
                       ├─ GET /assets/recent
                       ├─ GET /assets/{id}
                       ├─ GET /assets/{id}/thumbnail
                       └─ GET /assets/{id}/preview
                            ↓ x-api-key (server-side only)
                          Immich: authenticated read-only API
                            via LAN / routed network,
                            HTTPS URL, or shared Docker network
```

React renders the title, connection states, and up to 10 recent photos with format badges, RAW filtering, and ordered multi-photo selection. Selected photos can be opened in Anshitsu, where the active asset drives the preview, filename, date, EXIF data, and Filmstrip selection. It uses only same-origin `/api/` URLs. There is no background polling, pagination, search, or image adjustment.

The frontend image builds static assets using Vite and TypeScript with Node.js 24, then serves them with nginx. No Node.js or Vite development server runs in the final frontend image. nginx strips the `/api/` prefix before forwarding to `backend:8000`; the browser never connects directly to port 8000. Docker DNS resolution is refreshed so a recreated backend can be found again.

The backend uses Python 3.13, FastAPI, Uvicorn, and HTTPX. `GET /immich/status` calls the stable Immich `GET /api/users/me` endpoint. `GET /assets/recent` calls stable `POST /api/search/metadata`, filters for `IMAGE`, orders by `fileCreatedAt` descending, limits the result to 10, and returns the metadata needed by the grid. `GET /assets/{id}` returns selected non-GPS details and EXIF data. The thumbnail and preview routes proxy Immich-generated images at the corresponding sizes. All Immich calls use the official `x-api-key` header from backend environment variables. The key needs `user.read`, `asset.read`, and `asset.view`; no write endpoint is used. Redirects are not followed, TLS verification remains enabled, and requests use a five-second overall timeout with a three-second connection timeout and no retries.

Application code uses only the configured `IMMICH_URL`; it does not know whether Docker DNS, a LAN route, or HTTPS provides the route. Selecting and operating that route is a deployment responsibility.

The status response distinguishes missing URL, missing key, unreachable server, rejected or insufficient credentials, and unexpected API responses using safe error codes and messages. Asset endpoints also return only generic configuration, reachability, authentication, or upstream-response errors. They do not return the upstream response body, URL, API key, or internal exception text. The frontend intentionally reduces these details to concise user-facing states.

For optional local development, Vite provides the same `/api/` prefix mapping to a loopback backend. This is separate from the production nginx configuration.

## Docker deployment

`docker-compose.yml` defines two services:

| Service | Container port | Host exposure | Role |
| --- | --- | --- | --- |
| `frontend` | `8080` | `${GENZOROOM_PORT:-3190}` | Static file serving and API proxying. |
| `backend` | `8000` | None | Connectivity checks, asset metadata, EXIF filtering, and image proxying. |

Only the frontend publishes a host port. Both services join a project-scoped `api` network marked `internal: true`. The frontend also joins a `web` bridge network for its published entry point, while the backend joins a separate `outbound` bridge network for LAN, routed, and HTTPS connections. Joining `outbound` does not publish backend port 8000. There is no host networking, GPU requirement, privileged mode, or host directory bind mount.

The standard `docker-compose.yml` has no dependency on an Immich Docker network. The optional `docker-compose.immich-network.yml` attaches only the backend to an existing external network selected with `IMMICH_DOCKER_NETWORK`. This enables Docker DNS access to an Immich service on the same host without exposing the backend or attaching the frontend to Immich. The external network and Immich service name belong to the deployment environment and are never hardcoded by GenzoRoom. The application still receives only `IMMICH_URL` and `IMMICH_API_KEY`; `IMMICH_DOCKER_NETWORK` is consumed by Compose.

Both containers run as non-root users, drop Linux capabilities, and disable privilege escalation. Runtime temporary files stay inside containers. No persistent application state or volumes are needed at this stage. `.env` can provide local Compose inputs for the host port and Immich connection, but it is not mounted into the application; Portainer can supply the same values through stack environment variables.

Compose starts the backend before the frontend but does not wait for API readiness. Startup failures are visible in container logs and the UI; the user can check again after services become ready. Both services use `restart: unless-stopped`.

The files support builds on a Docker Compose NAS. A Portainer Git Repository stack can use `docker-compose.yml` as its Compose path and, when same-host networking is needed, `docker-compose.immich-network.yml` as an additional path. Portainer must target the Docker endpoint where the external network already exists. The configuration does not provide prebuilt registry images or Swarm deployment support.

See the [deployment guide](deployment.md) for startup, verification, troubleshooting, and removal commands. Removing the Compose deployment removes its containers and networks; copied deployment files and built images remain until explicitly removed.

## Future direction (not implemented)

The current authenticated read path is:

```text
Browser → Frontend → Backend API → Immich API
```

Possible extensions include:

- Expanded Immich asset browsing; connection credentials currently come only from backend environment variables.
- JPEG / HEIC handling and later RAW / DNG processing, potentially using LibRaw or rawpy.
- Non-destructive edit parameter storage separate from original images; storage and schema are undecided.
- Responsive preview rendering, with client-side GPU assistance only if useful.
- High-quality server-side final rendering; output storage and export behavior are undecided.
- Exposure, contrast, highlights, shadows, white balance, tone curve, HSL, and histogram tools, with waveform and RGB parade as later possibilities.
- Explicit Docker volumes if persistent data becomes necessary.

These are provisional directions, not available functionality or delivery commitments. The current Immich integration is limited to authenticated read-only browsing, generated image previews, and the initial Anshitsu workspace described above.

## Portability and validation

The Windows workspace is only a development directory. Application code and deployment files must not depend on its absolute path or Windows-specific runtime behavior. Deployment must not modify NAS host OS settings or install application files into host system directories. Future persistent data must use explicitly declared container storage or Docker volumes.

The validation workflow is to develop locally, copy or deploy the required files to the NAS, start them with Docker Compose / Portainer, and verify actual behavior there. Successful Windows checks alone do not constitute completed runtime validation.

The NAS acceptance check is to open the Web UI, confirm `Backend: Connected`, `Immich: Connected`, and up to 10 recent thumbnails, obtain `{"status":"ok"}` from `/api/health`, and obtain a connected result from `/api/immich/status`. Also verify the empty and failed photo-list states, missing Immich settings, rejected credentials, and the backend stopped. Container builds, nginx routing, real Immich photo and thumbnail access, and restart behavior still require target-environment validation; static checks alone cannot establish them.
