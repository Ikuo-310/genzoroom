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

React renders the title, connection states, and up to 100 recent photos with format badges, RAW filtering, and ordered multi-photo selection. Selected photos can be opened in Anshitsu, where the active asset drives the preview, filename, date, EXIF data, and Filmstrip selection. The desktop workspace keeps History and EXIF in the independently collapsible left reference panel, places Scope above Develop controls in the independently collapsible right panel, and reserves the bottom row for the Filmstrip. It uses only same-origin `/api/` URLs. There is no background polling, pagination, or search. JPEG White Balance, Basic tone, Shadows, Midtones, and Highlights Color Grading, Vibrance, and Saturation adjustments run locally in the browser.

Anshitsu is desktop-first because practical photo development requires adequate space for the Viewer, Scope, Develop controls, and Filmstrip. Narrow layouts should remain usable enough to avoid critical breakage, but a dedicated mobile development workspace, or a Drawer, Tab, or vertically stacked redesign, is outside the current architecture unless explicitly planned separately. Possible future mobile workflows such as asset selection, stack management, preset application, or sending completed results to Immich should be treated separately from the full Anshitsu editing interface.

The frontend image builds static assets using Vite and TypeScript with Node.js 24, then serves them with nginx. No Node.js or Vite development server runs in the final frontend image. nginx strips the `/api/` prefix before forwarding to `backend:8000`; the browser never connects directly to port 8000. Docker DNS resolution is refreshed so a recreated backend can be found again.

The backend uses Python 3.13, FastAPI, Uvicorn, and HTTPX. `GET /immich/status` calls the stable Immich `GET /api/users/me` endpoint. `GET /assets/recent` calls stable `POST /api/search/metadata`, filters for `IMAGE`, orders by `fileCreatedAt` descending, limits the result to 100, and returns the metadata needed by the grid. `GET /assets/{id}` returns selected non-GPS details and EXIF data. The thumbnail and preview routes proxy Immich-generated images at the corresponding sizes. All Immich calls use the official `x-api-key` header from backend environment variables. The key needs `user.read`, `asset.read`, and `asset.view`; no write endpoint is used. Redirects are not followed, TLS verification remains enabled, and requests use a five-second overall timeout with a three-second connection timeout and no retries.

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

Anshitsu owns an in-memory map keyed by Immich asset ID. Each session contains a JSON-serializable flat recipe (version 17), committed history entries (`kind`, `before`, `after`), a history cursor, and an optional pending transaction. The recipe has four category enabled flags, three Color Grading range enabled flags (`gradingShadowsEnabled`, `gradingMidtonesEnabled`, `gradingHighlightsEnabled`), and sixteen adjustment values. All enabled flags default to true; all adjustment values default to zero. Only JPEG assets are editable. Filmstrip switches preserve each asset's recipe and history; leaving Anshitsu or reloading discards them.

| Category | Adjustment keys | Enabled flags |
| --- | --- | --- |
| White Balance | `temperature`, `tint` | `whiteBalanceEnabled` |
| Basic | `exposure`, `contrast`, `highlights`, `whites`, `shadows`, `blacks` | `basicEnabled` |
| Color Grading | `shadowsTemperature`, `shadowsTint`, `midtonesTemperature`, `midtonesTint`, `highlightsTemperature`, `highlightsTint` | `colorGradingEnabled`, plus the three range flags above |
| Color | `vibrance`, `saturation` | `colorEnabled` |

Individual adjustment Reset changes only its value. Color Grading Reset changes its six values in one History operation and preserves the parent and all three range flags. All Reset restores every value and all seven flags. Range toggles commit pending adjustment edits first, then commit one separate toggle operation without changing values. The parent can be off while a child switch is changed; the child setting takes effect when the parent is enabled again.

`editing.ts` provides pure begin/update/commit/reset/undo/redo transitions. Preview changes use the current recipe immediately. Pointer release/cancel, control unmount, or 500 ms keyboard/wheel inactivity commits one operation. Keyboard input resets the timer on every accepted keydown; keyup, pointer leave, and focus changes do not commit it early. No-op operations compare the complete recipe, including all four category flags, three Color Grading range flags, and sixteen adjustment values, and do not create history or discard redo. A new committed edit after Undo replaces the redo branch. Each adjustment Reset, category toggle, range toggle, category Reset, and All Reset has a separate operation kind; all are undoable. White Balance, Basic, Color Grading, and Color Reset affect only their own values and preserve their enabled flags. All Reset restores all sixteen values and all seven enabled flags to defaults in one operation. Their History labels stay concise and are localized at display time rather than stored in recipes. The flat in-memory schema is version 17. No persistence or migration framework is introduced.

`AdjustmentSlider` supplies a compact reusable adjustment row with its label, native range input, synchronized direct numeric input, optional fixed-width unit slot, and inline reset in one responsive grid row. The label truncates when necessary while the range column consumes the remaining sidebar width. Direct input updates the current recipe only for finite normalized values, commits on Enter or blur, and restores its pre-edit value on Escape or invalid input. `editShortcuts.ts` protects text and number inputs, textarea, select, contenteditable, and IME input from the hover/focus slider shortcuts. Focused other sliders retain their own behavior. Exposure is bounded to −5…+5 EV in 0.01 EV increments with two displayed decimal places; every other current adjustment uses −100…+100 integer steps. Temperature and Tint controls use their corresponding directional gradient tracks. Color Grading controls are ordered Shadows Temperature/Tint, Midtones Temperature/Tint, Highlights Temperature/Tint; each group header has a compact ON/OFF button that disables only its two sliders while preserving their values. Vibrance and Saturation use normal tracks with no unit. The categories appear as White Balance, Basic, Color, then Color Grading; this display order is independent from the pixel pipeline order. Each category’s expanded state is local UI state that starts expanded on every Anshitsu entry and is not persisted. When a category is disabled, only its controls are disabled and dimmed while its values remain intact; only that category’s adjustments are bypassed. The temporary-preview notice remains outside the collapsible categories.

The current rendering path is:

```text
Temporary Immich preview adapter (editImageSource.ts)
  → browser decode into sRGB RGBA
  → adjustmentWorkerClient.ts (one source copy transferred on initialization; recipes sent per render)
  → adjustmentWorker.ts → adjustmentWorkerRuntime.ts
  → adjustmentPipeline.ts (immutable source → linear-light Temperature → linear-light Tint → linear-light Exposure gain 2^EV → sRGB midpoint Contrast → Highlights → Whites → Shadows → Blacks → masked linear-light Shadows Temperature → masked linear-light Shadows Tint → masked linear-light Midtones Temperature → masked linear-light Midtones Tint → masked linear-light Highlights Temperature → masked linear-light Highlights Tint → Vibrance → Saturation)
  → result buffer transferred to AdjustedImage.tsx → adjusted Canvas → existing Viewer transforms

Decoded source pixels → unadjusted Canvas in the same Viewer position
```

`effectiveAdjustments` substitutes defaults for disabled categories and, when Color Grading is on, for each disabled Shadows, Midtones, or Highlights pair. The source recipe retains all adjustment values and range flags. Color Grading off bypasses all three ranges without changing those flags. Thus a disabled range reaches the pipeline as two zero-valued stages and skips its luminance, weight, and gain work. Color Grading Reset clears only its six values; All Reset also turns every range back on.

The no-op check considers all sixteen effective values and returns exact source bytes when they are zero. Alpha is preserved. Existing White Balance and Basic tone formulas, luminance-region skips, intermediate rounding, and stage order are unchanged. The three Color Grading pairs run after Blacks with the shared weights and gains described below; each active stage clips and rounds before the next.

Vibrance runs after Highlights Tint. It uses `Y = 0.2126R + 0.7152G + 0.0722B`, `chroma = max(|R−Y|, |G−Y|, |B−Y|)`, and `lowSatWeight = 1 − clamp(chroma / 0.5, 0, 1)`. Positive strength is `0.75 × lowSatWeight`; negative strength is `0.6 × (0.25 + 0.75 × lowSatWeight)`. With `factor = 1 + vibrance / 100 × strength`, each channel becomes `clamp(Y + (C−Y) × factor, 0, 1)` and is rounded to 8-bit before Saturation. Zero-valued stages are skipped. Every render starts from the untouched decoded source, so edits do not accumulate clipping from previous renders.

This is an 8-bit browser-managed sRGB preview, not an original-quality rendering or RAW workflow. Immich-generated preview dimensions still define Viewer 1:1. Pixel processing runs in a Web Worker with the existing main-thread fallback; large-source performance, wide-gamut/HDR fidelity, and color-profile matching need separate work before final rendering. Original acquisition is isolated from recipe and processing code: the next source adapter should provide JPEG original → GenzoRoom pipeline → GenzoRoom preview without silently treating existing preview-based recipes as equivalent original-based results.

### Color Grading weights and shared gains

Let `S(a,b,Y) = x²(3−2x)`, where `x = clamp((Y−a)/(b−a), 0, 1)`. Here Y is calculated from normalized **sRGB bytes**, not linear-light RGB. Each range calculates Y once before its Temperature stage and shares the resulting weight with its Tint stage. The next range uses the rounded output of the preceding range.

| Range | Weight | Full strength | Transition |
| --- | --- | --- | --- |
| Shadows | `1 − S(0.15,0.35,Y)` | Y ≤ 0.15 | Fade out 0.15–0.35; zero from 0.35 |
| Midtones | `S(0.15,0.35,Y) × (1 − S(0.60,0.78,Y))` | 0.35–0.60 | Fade in 0.15–0.35; fade out 0.60–0.78 |
| Highlights | `S(0.55,0.75,Y)` | Y ≥ 0.75 | Zero through 0.55; fade in 0.55–0.75 |

Temperature targets are `(1.5^−t, 1, 1.5^t)` with `t = value/100`; Tint targets are `(1.3^u, 1.3^−u, 1.3^u)` with `u = value/100`. Each range applies `targetGain^weight` in linear RGB. Each active stage clips, encodes, and rounds separately. All ranges use the same channel-gain helper and module-level 256-entry Float64 sRGB decode table. Global Tint shares one LUT for its identical red/blue gains; weighted Tint calculates their identical effective gain once per pixel. These are exact reuse operations, not approximations or stage fusion.

Range thresholds are named constants in three pure weight helpers. Future Point / Width support can parameterize these helpers, but must first define how shoulder-shaped Shadows/Highlights and the Midtones plateau map to those controls, including edge clamping and valid widths. No Point / Width fields or migration system exist in v17.

### Worker ownership and limits

`AdjustedImage` decodes the source once and retains its buffer for fallback. The client transfers a single copied source buffer to the Worker when that decoded source changes; recipe messages contain no pixel copies. `adjustmentWorkerRuntime` calls the same pure `renderAdjustments()` used by fallback, with the complete v17 recipe. It retains its source and transfers the new output buffer back. There is no separate Worker pixel algorithm or per-adjustment protocol mapping.

The Viewer keeps Before / After as display state outside the recipe and History. `AnshitsuPage` owns the persistent choice across Filmstrip asset switches; `ImageViewer` owns the temporary held-Backslash state, matched by `KeyboardEvent.code`. `AdjustedImage` draws decoded input pixels into a Before Canvas and Worker/fallback output into an overlaid After Canvas. Comparison changes only the After Canvas visibility, so it issues no render request and leaves the shared Viewer zoom/pan transform intact. A new source clears the previous canvases before its decode/result is displayed. Before bypasses develop adjustments; future geometric transforms should feed both display paths before this split.

The client permits one in-flight render and one pending latest recipe. When a newer recipe is pending, the completed older output is discarded and the latest request is sent. Request IDs and asset generations reject mismatched results. RAF coalesces changes before submission. Decode is aborted on source change/unmount; pending RAF is canceled, Worker callbacks are removed, and the old Worker is terminated. Startup, initialization, message, and runtime errors use the retained source in the main-thread fallback.

Each render still needs one output buffer of `4 × width × height` bytes, including an identity result: transferring the retained source would detach it. Main-thread fallback storage, the Worker's retained source, and the additional Before Canvas backing store for immediate comparison are intentional. Small gain/tone LUTs have 256 entries; there are no full-image per-stage buffers. Stage-specific encode/round/decode boundaries preserve current output and cannot be fused without reconsidering that behavior. Full-size CPU pixel work and Canvas upload remain proportional to pixel count. Worker scheduling improves responsiveness but cannot cancel a render already running or reduce its pixel count; sustained latency may require a separately designed reduced-resolution interaction path. No end-to-end Firefox performance claim is made from unit tests.

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

The NAS acceptance check is to open the Web UI, confirm `Backend: Connected`, `Immich: Connected`, and up to 100 recent thumbnails, obtain `{"status":"ok"}` from `/api/health`, and obtain a connected result from `/api/immich/status`. Also verify the empty and failed photo-list states, missing Immich settings, rejected credentials, and the backend stopped. Container builds, nginx routing, real Immich photo and thumbnail access, and restart behavior still require target-environment validation; static checks alone cannot establish them.
