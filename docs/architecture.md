# Provisional Architecture

**Status: Early Development — authenticated photo browsing, Anshitsu, and minimal JPEG White Balance, Basic, Color Grading, and Color adjustments are implemented. RAW development is not implemented.**

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

React renders the title, connection states, and up to 50 recent photos with format badges, RAW filtering, and ordered multi-photo selection. Selected photos can be opened in Anshitsu, where the active asset drives the preview, filename, date, EXIF data, and Filmstrip selection. The desktop workspace keeps History and EXIF in the independently collapsible left reference panel, places Scope above Develop controls in the independently collapsible right panel, and reserves the bottom row for the Filmstrip. It uses only same-origin `/api/` URLs. There is no background polling, pagination, or search. JPEG White Balance, Basic tone, Shadows Temperature/Tint Color Grading, Vibrance, and Saturation adjustments run locally in the browser.

Anshitsu is desktop-first because practical photo development requires adequate space for the Viewer, Scope, Develop controls, and Filmstrip. Narrow layouts should remain usable enough to avoid critical breakage, but a dedicated mobile development workspace, or a Drawer, Tab, or vertically stacked redesign, is outside the current architecture unless explicitly planned separately. Possible future mobile workflows such as asset selection, stack management, preset application, or sending completed results to Immich should be treated separately from the full Anshitsu editing interface.

The frontend image builds static assets using Vite and TypeScript with Node.js 24, then serves them with nginx. No Node.js or Vite development server runs in the final frontend image. nginx strips the `/api/` prefix before forwarding to `backend:8000`; the browser never connects directly to port 8000. Docker DNS resolution is refreshed so a recreated backend can be found again.

The backend uses Python 3.13, FastAPI, Uvicorn, and HTTPX. `GET /immich/status` calls the stable Immich `GET /api/users/me` endpoint. `GET /assets/recent` calls stable `POST /api/search/metadata`, filters for `IMAGE`, orders by `fileCreatedAt` descending, limits the result to 50, and returns the metadata needed by the grid. `GET /assets/{id}` returns selected non-GPS details and EXIF data. The thumbnail and preview routes proxy Immich-generated images at the corresponding sizes. All Immich calls use the official `x-api-key` header from backend environment variables. The key needs `user.read`, `asset.read`, and `asset.view`; no write endpoint is used. Redirects are not followed, TLS verification remains enabled, and requests use a five-second overall timeout with a three-second connection timeout and no retries.

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

Anshitsu owns an in-memory map keyed by Immich asset ID. Each session contains a JSON-serializable recipe (`{ version: 12, whiteBalanceEnabled: true, basicEnabled: true, colorGradingEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, vibrance: 0, saturation: 0 } }`), committed history entries (`kind`, `before`, `after`), a history cursor, and an optional pending transaction. Only JPEG assets are editable. Filmstrip switches preserve each asset's recipe and history; leaving Anshitsu or reloading discards them.

`editing.ts` provides pure begin/update/commit/reset/undo/redo transitions. Preview changes use the current recipe immediately. Pointer release/cancel, control unmount, or 500 ms keyboard inactivity commits one operation. Keyboard input resets the timer on every accepted keydown; keyup, pointer leave, and focus changes do not commit it early. No-op operations compare the complete recipe, including all four category flags and twelve adjustment values, and do not create history or discard redo. A new committed edit after Undo replaces the redo branch. Each adjustment Reset, category toggle, category Reset, and All Reset has a separate operation kind; all are undoable. White Balance, Basic, Color Grading, and Color Reset affect only their own values and preserve their enabled flags. All Reset restores all twelve values and all four category flags to true in one operation. Their History labels stay concise and are localized at display time rather than stored in recipes. The flat in-memory schema is version 12. No persistence or migration framework is introduced.

`AdjustmentSlider` supplies a compact reusable adjustment row with its label, native range input, synchronized direct numeric input, optional fixed-width unit slot, and inline reset in one responsive grid row. The label truncates when necessary while the range column consumes the remaining sidebar width. Direct input updates the current recipe only for finite normalized values, commits on Enter or blur, and restores its pre-edit value on Escape or invalid input. `editShortcuts.ts` protects text and number inputs, textarea, select, contenteditable, and IME input from the hover/focus slider shortcuts. Focused other sliders retain their own behavior. Exposure is bounded to −5…+5 EV in 0.01 EV increments with two displayed decimal places; every other current adjustment uses −100…+100 integer steps. Temperature, Tint, Shadows Temperature, and Shadows Tint have directional gradient tracks; Vibrance and Saturation use normal tracks with no unit, in that order. The categories appear as White Balance, Basic, Color, then Color Grading; this display order is independent from the pixel pipeline order. Each category’s expanded state is local UI state that starts expanded on every Anshitsu entry and is not persisted. When a category is disabled, only its controls are disabled and dimmed while its values remain intact; only that category’s adjustments are bypassed. The temporary-preview notice remains outside the collapsible categories.

The current rendering path is:

```text
Temporary Immich preview adapter (editImageSource.ts)
  → browser decode into sRGB RGBA
  → adjustmentPipeline.ts (immutable source → linear-light Temperature → linear-light Tint → linear-light Exposure gain 2^EV → sRGB midpoint Contrast → Highlights → Whites → Shadows → Blacks → masked linear-light Shadows Temperature → masked linear-light Shadows Tint → Vibrance → Saturation)
  → GenzoRoom Canvas preview → existing Viewer transforms
```

effectiveAdjustments independently substitutes defaults for disabled White Balance, Basic, Color Grading, and Color values, preserving other fields. Category flags do not cause a pipeline-wide early return. The no-op check considers all twelve effective values and returns exact source bytes when they are zero. Alpha is preserved. Existing White Balance and tone formulas, luminance-region skips, intermediate rounding, and stage order are unchanged. After Blacks, Color Grading calculates `Y = 0.2126R + 0.7152G + 0.0722B` once from the current normalized sRGB bytes. With `x = clamp((Y - 0.15) / 0.20, 0, 1)`, the shared Shadows weight is `w = 1 - x²(3 - 2x)`: full strength through 0.15, a smooth fade across the shadow range, and zero at and above 0.35. Shadows Temperature first applies the existing Temperature gains in linear RGB as `effectiveGain = gain^w`, preserving reciprocal warm/cool behavior. Shadows Tint then uses the existing global Tint targets (`R = B = 1.3^t`, `G = 1.3^-t`, `t = shadowsTint / 100`) with the same `effectiveGain = gain^w`, giving green for negative values and magenta for positive values. Each stage clips, encodes back to sRGB, and rounds before the next; Vibrance follows Shadows Tint. Vibrance uses the same luminance definition; its chroma is `max(|R-Y|, |G-Y|, |B-Y|)` and `lowSatWeight = 1 - clamp(chroma / 0.5, 0, 1)`. For positive values, `strength = 0.75 × lowSatWeight`; for negative values, `strength = 0.6 × (0.25 + 0.75 × lowSatWeight)`. It then uses `factor = 1 + vibrance / 100 × strength` and `outC = clamp(Y + (C-Y) × factor, 0, 1)`. The result is rounded to 8-bit before the unchanged Saturation stage. Zero-valued stages are skipped for byte identity. Each update starts from the untouched decoded buffer, so clipping is not accumulated. Rendering is coalesced with requestAnimationFrame. No CSS filter, GPU, rendered asset, or backend change is involved.

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
- Further adjustments beyond JPEG Temperature, Tint, Exposure, Contrast, Highlights, Whites, Shadows, Blacks, Vibrance, and Saturation: tone curve, HSL, and histogram tools, with waveform and RGB parade as later possibilities.
- Explicit Docker volumes if persistent data becomes necessary.

These are provisional directions, not available functionality or delivery commitments. The current Immich integration is limited to authenticated read-only browsing, generated image previews, and the initial Anshitsu workspace described above.

## Portability and validation

The Windows workspace is only a development directory. Application code and deployment files must not depend on its absolute path or Windows-specific runtime behavior. Deployment must not modify NAS host OS settings or install application files into host system directories. Future persistent data must use explicitly declared container storage or Docker volumes.

The validation workflow is to develop locally, copy or deploy the required files to the NAS, start them with Docker Compose / Portainer, and verify actual behavior there. Successful Windows checks alone do not constitute completed runtime validation.

The NAS acceptance check is to open the Web UI, confirm `Backend: Connected`, `Immich: Connected`, and up to 50 recent thumbnails, obtain `{"status":"ok"}` from `/api/health`, and obtain a connected result from `/api/immich/status`. Also verify the empty and failed photo-list states, missing Immich settings, rejected credentials, and the backend stopped. Container builds, nginx routing, real Immich photo and thumbnail access, and restart behavior still require target-environment validation; static checks alone cannot establish them.
