# Provisional Architecture

**Status: Early Development — the first-stage connectivity scaffold is implemented. Photo features are not implemented.**

This document describes the current minimal implementation and possible future extensions. The architecture remains provisional: components, interfaces, and deployment choices may change during development.

## Current request flow

```text
Browser: http://<NAS-IP>:3190
  ↓
Frontend: nginx on container port 8080
  ├─ /             → built React / TypeScript frontend
  └─ /api/health   → internal Docker network
                       ↓
                     Backend: Uvicorn / FastAPI on port 8000
                       └─ GET /health → {"status":"ok"}
```

React renders the title, early development status, and backend connectivity result. It fetches the relative URL `/api/health`, verifies the HTTP response and JSON status, and displays checking, connected, or failed states. A five-second timeout handles unresponsive services. A button repeats the check; there is no background polling.

The frontend image builds static assets using Vite and TypeScript with Node.js 24, then serves them with nginx. No Node.js or Vite development server runs in the final frontend image. nginx strips the `/api/` prefix before forwarding to `backend:8000`; the browser never connects directly to port 8000. Docker DNS resolution is refreshed so a recreated backend can be found again.

The backend uses Python 3.13, FastAPI, and Uvicorn. Its only application endpoint is `GET /health`; automatically generated API documentation endpoints are disabled. There is no database, authentication, Immich connection, or image processing.

For optional local development, Vite provides the same `/api/` prefix mapping to a loopback backend. This is separate from the production nginx configuration.

## Docker deployment

`docker-compose.yml` defines two services:

| Service | Container port | Host exposure | Role |
| --- | --- | --- | --- |
| `frontend` | `8080` | `${GENZOROOM_PORT:-3190}` | Static file serving and API proxying. |
| `backend` | `8000` | None | Health endpoint. |

Only the frontend publishes a host port. Both services join a project-scoped `api` network marked `internal: true`; the backend joins no other network. The frontend also joins a `web` bridge network for its published entry point. There is no host networking, GPU requirement, privileged mode, or host directory bind mount.

Both containers run as non-root users, drop Linux capabilities, and disable privilege escalation. Runtime temporary files stay inside containers. No persistent application state or volumes are needed at this stage. `.env` is an optional deployment input for the host port, not a file mounted into the application.

Compose starts the backend before the frontend but does not wait for API readiness. Startup failures are visible in container logs and the UI; the user can check again after services become ready. Both services use `restart: unless-stopped`.

The files support builds on a Docker Compose NAS. Portainer use requires a Docker Standalone workflow with the full build contexts, or management of containers already started by Compose. The configuration does not provide prebuilt registry images or Swarm deployment support.

See [the README](../README.md) for startup, verification, and removal commands. Removing the Compose deployment removes its containers and networks; copied deployment files and built images remain until explicitly removed.

## Future direction (not implemented)

The eventual integration path is expected to be:

```text
Browser → Frontend → Backend API → Immich API
```

Possible extensions include:

- Immich API integration; credentials handling and asset access are undecided.
- JPEG / HEIC handling and later RAW / DNG processing, potentially using LibRaw or rawpy.
- Non-destructive edit parameter storage separate from original images; storage and schema are undecided.
- Responsive preview rendering, with client-side GPU assistance only if useful.
- High-quality server-side final rendering; output storage and export behavior are undecided.
- Exposure, contrast, highlights, shadows, white balance, tone curve, HSL, and histogram tools, with waveform and RGB parade as later possibilities.
- Explicit Docker volumes if persistent data becomes necessary.

These are provisional directions, not available functionality or delivery commitments. The current internal-only backend network will need deliberate review when connectivity to an external Immich instance is implemented.

## Portability and validation

The Windows workspace is only a development directory. Application code and deployment files must not depend on its absolute path or Windows-specific runtime behavior. Deployment must not modify NAS host OS settings or install application files into host system directories. Future persistent data must use explicitly declared container storage or Docker volumes.

The validation workflow is to develop locally, copy or deploy the required files to the NAS, start them with Docker Compose / Portainer, and verify actual behavior there. Successful Windows checks alone do not constitute completed runtime validation.

The NAS acceptance check is to open the Web UI, confirm `Backend: Connected`, and obtain `{"status":"ok"}` from `/api/health`. Also verify the visible error state with the backend stopped and recovery after restarting it. Container builds, nginx routing, and restart behavior still require target-environment validation; static checks alone cannot establish them.
