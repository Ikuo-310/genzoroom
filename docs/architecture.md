# Provisional Architecture

**Status: Early Development — authenticated photo browsing, Anshitsu, and minimal JPEG Exposure/Contrast/Highlights/Shadows adjustments are implemented. RAW development is not implemented.**

This document describes the current minimal implementation and possible future extensions. The architecture remains provisional: components, interfaces, and deployment choices may change during development.

## Current request flow

```text
Browser: http://<HOSTNAME-OR-IP>:3190
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

React renders the title, connection states, and up to 10 recent photos with format badges, RAW filtering, and ordered multi-photo selection. Selected photos can be opened in Anshitsu, where the active asset drives the preview, filename, date, EXIF data, and Filmstrip selection. The desktop workspace keeps History and EXIF in the independently collapsible left reference panel, places Scope above Develop controls in the independently collapsible right panel, and reserves the bottom row for the Filmstrip. It uses only same-origin `/api/` URLs. There is no background polling, pagination, or search. JPEG Exposure, Contrast, Highlights, and Shadows adjustments run locally in the browser.

Anshitsu is desktop-first because practical photo development requires adequate space for the Viewer, Scope, Develop controls, and Filmstrip. Narrow layouts should remain usable enough to avoid critical breakage, but a dedicated mobile development workspace, or a Drawer, Tab, or vertically stacked redesign, is outside the current architecture unless explicitly planned separately. Possible future mobile workflows such as asset selection, stack management, preset application, or sending completed results to Immich should be treated separately from the full Anshitsu editing interface.

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

## JPEG editing foundation

Anshitsu owns an in-memory map keyed by Immich asset ID. Each session contains a JSON-serializable recipe (`{ version: 3, adjustments: { exposure: 0, contrast: 0, highlights: 0, shadows: 0 } }`), committed history entries (`kind`, `before`, `after`), a history cursor, and an optional pending transaction. Only JPEG assets are editable. Filmstrip switches preserve each asset's recipe and history; leaving Anshitsu or reloading discards them.

`editing.ts` provides pure begin/update/commit/reset/undo/redo transitions. Preview changes use the current recipe immediately. Pointer release/cancel, control unmount, or 500 ms keyboard inactivity commits one operation. Keyboard input resets the timer on every accepted keydown; keyup, pointer leave, and focus changes do not commit it early. No-op operations compare the complete adjustment recipe and do not create history or discard redo. A new committed edit after Undo replaces the redo branch. Each adjustment Reset and All Reset has a separate operation kind; all are undoable. All Reset restores all four parameters in one history operation. History labels are localized at display time rather than stored in recipes. Adding the required Shadows field changes the in-memory recipe schema to version 3; persistent migration is still out of scope.

`AdjustmentSlider` supplies a compact reusable adjustment row with its label, native range input, synchronized direct numeric input, optional fixed-width unit slot, and inline reset in one responsive grid row. The label truncates when necessary while the range column consumes the remaining sidebar width. Direct input updates the current recipe only for finite normalized values, commits on Enter or blur, and restores its pre-edit value on Escape or invalid input. `editShortcuts.ts` protects text and number inputs, textarea, select, contenteditable, and IME input from the hover/focus slider shortcuts. Focused other sliders retain their own behavior. Exposure is bounded to −5…+5 EV in 0.01 EV increments with two displayed decimal places; Contrast, Highlights, and Shadows are bounded to −100…+100 in integer steps.

The current rendering path is:

```text
Temporary Immich preview adapter (editImageSource.ts)
  → browser decode into sRGB RGBA
  → exposurePipeline.ts (immutable source → linear-light Exposure gain 2^EV → sRGB midpoint Contrast → Highlights → Shadows)
  → GenzoRoom Canvas preview → existing Viewer transforms
```

The pipeline preserves alpha, clips display output to the sRGB range, and returns exact source bytes when all four adjustments are zero. Exposure converts sRGB to linear light, applies `2^EV`, and returns to sRGB. Contrast then scales each sRGB channel around the 0.5 midpoint by `1 + contrast / 100`. Highlights uses a smooth luminance weight above 0.5. Shadows runs last with the mirrored smooth weight below 0.5, interpolating luminance toward `sqrt(Y)` for positive values or `Y²` for negative values. Both tonal controls apply the resulting luminance ratio equally to RGB to limit hue shifts. Shadows protects division with a small epsilon, and every output channel is clipped to 0…1. Each update starts from the untouched decoded buffer, so clipping is not accumulated. Rendering is coalesced with requestAnimationFrame. No CSS filter, GPU, rendered asset, or backend change is involved. Source loads are aborted/ignored on asset changes and decoded bitmap resources are closed. Viewer source identity remains stable during adjustments, preserving Zoom/Pan.

This is an 8-bit browser-managed sRGB preview, not an original-quality rendering or RAW workflow. Immich-generated preview dimensions still define Viewer 1:1. Full-sized pixel processing runs on the main thread; large-source performance, wide-gamut/HDR fidelity, and color-profile matching need separate work before final rendering. Original acquisition is isolated from recipe and processing code: the next source adapter should provide JPEG original → GenzoRoom pipeline → GenzoRoom preview without silently treating existing preview-based recipes as equivalent original-based results.

Future persistence should validate/migrate recipe versions, associate recipes with stable asset and source identity (including processing/color-space version), and save committed recipes atomically. Decide separately whether to persist undo history and its cursor. Do not serialize transient decoded buffers, pending gestures, or translated labels. There is currently no DB, localStorage recipe storage, container volume, original mutation, or Immich write-back.

## Future direction (not implemented)

The current authenticated read path is:

```text
Browser → Frontend → Backend API → Immich API
```

Possible extensions include:

- Expanded Immich asset browsing; connection credentials currently come only from backend environment variables.
- Original-based JPEG processing, HEIC handling, and later RAW / DNG processing, potentially using LibRaw or rawpy.
- Non-destructive edit parameter storage separate from original images; storage and schema are undecided.
- Responsive preview rendering, with client-side GPU assistance only if useful.
- High-quality server-side final rendering; output storage and export behavior are undecided.
- Further adjustments beyond JPEG Exposure, Contrast, Highlights, and Shadows: white balance, tone curve, HSL, and histogram tools, with waveform and RGB parade as later possibilities.
- Explicit Docker volumes if persistent data becomes necessary.

These are provisional directions, not available functionality or delivery commitments. The current Immich integration is limited to authenticated read-only browsing, generated image previews, and the initial Anshitsu workspace described above.

## Portability and validation

The Windows workspace is only a development directory. Application code and deployment files must not depend on its absolute path or Windows-specific runtime behavior. Deployment must not modify NAS host OS settings or install application files into host system directories. Future persistent data must use explicitly declared container storage or Docker volumes.

The validation workflow is to develop locally, copy or deploy the required files to the NAS, start them with Docker Compose / Portainer, and verify actual behavior there. Successful Windows checks alone do not constitute completed runtime validation.

The NAS acceptance check is to open the Web UI, confirm `Backend: Connected`, `Immich: Connected`, and up to 10 recent thumbnails, obtain `{"status":"ok"}` from `/api/health`, and obtain a connected result from `/api/immich/status`. Also verify the empty and failed photo-list states, missing Immich settings, rejected credentials, and the backend stopped. Container builds, nginx routing, real Immich photo and thumbnail access, and restart behavior still require target-environment validation; static checks alone cannot establish them.
