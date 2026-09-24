# GenzoRoom

GenzoRoom is an early-development, self-hosted browser interface for developing and color-correcting photos managed by [Immich](https://immich.app/). It connects to Immich through a read-only backend and currently applies non-destructive adjustments locally to Immich-generated JPEG previews.

This is not yet a RAW development pipeline. RAW files can be browsed and filtered, but RAW processing itself is not implemented. The name comes from the Japanese word **現像 (genzō)**, meaning photographic development.

![GenzoRoom Anshitsu workspace with the viewer, History, EXIF, Develop controls, and Filmstrip](docs/images/anshitsu-overview.png)

*The current desktop-focused Anshitsu workspace.*

## Current features

### Immich browsing and Anshitsu

- Authenticated, read-only Immich connectivity.
- Up to 100 recent photos with proxied thumbnails and format badges.
- Client-side RAW / Non-RAW filtering.
- Ordered multi-photo selection into the **Anshitsu** development workspace.
- Active-photo switching through the Filmstrip, with EXIF details for the current photo.
- Per-photo edit recipes and History during the current Anshitsu session.
- Undo / Redo, individual adjustment Reset, category Reset, and All Reset.
- Fit, 1:1, zoom, and pan controls.
- Independently collapsible and resizable desktop sidebars with remembered widths.
- English and Japanese UI with remembered language selection and locale-aware dates.

Edit state is held in browser memory per photo. Filmstrip switching preserves it during the session; leaving Anshitsu or reloading discards it.

### Current adjustments

Editing is currently available for JPEG assets only and uses the Immich-generated JPEG preview as its source.

| Category | Adjustments |
| --- | --- |
| White Balance | Temperature, Tint |
| Basic | Exposure, Contrast, Highlights, Whites, Shadows, Blacks |
| Color | Vibrance, Saturation |
| Color Grading | Shadows Temperature, Shadows Tint, Midtones Temperature, Midtones Tint, Highlights Temperature, Highlights Tint |

Each category can be collapsed, temporarily bypassed without losing its values, and reset independently. Adjustment changes and category operations participate in History and Undo / Redo. Processing is performed locally in the browser; Immich originals are not modified.

## Current limitations

- Adjustments operate on Immich-generated JPEG previews, not original files or an original-quality rendering path.
- HEIC, PNG, RAW, and other non-JPEG assets are not editable.
- The preview pipeline is browser-managed 8-bit sRGB; wide-gamut, HDR, color-profile matching, and large-image performance need further work.
- Edit recipes and History are session-only and are not persisted to a database or browser storage.
- Recent Photos is limited to 100 items and currently has no pagination or search.
- Anshitsu is desktop-first; there is no dedicated mobile editing workspace.
- Immich asset Stack handling is not implemented.

## Not implemented

- RAW development pipeline.
- Persistent edit recipes.
- Export or write-back to Immich.
- Scopes such as Histogram, Waveform, and RGB Parade; the current Scope area is a placeholder.
- Masking or local adjustments.
- Crop or rotate tools.
- AI-assisted adjustments.
- Noise reduction.

These are current boundaries, not release commitments or a promised roadmap.

## Security and data handling

- GenzoRoom currently calls read-only Immich endpoints. Use a dedicated API key with only `user.read`, `asset.read`, and `asset.view` permissions.
- The Immich API key is supplied to the backend through environment variables. It is not sent to the frontend or embedded in the frontend image.
- Browser requests use same-origin `/api/` routes. The backend port is not published to the host in the provided Compose configuration.
- TLS certificate verification remains enabled for HTTPS Immich URLs. Upstream response bodies, credentials, and internal exception details are not exposed to the browser.
- The provided containers run as non-root users, drop Linux capabilities, and disable privilege escalation.
- GenzoRoom does not currently modify originals, persist edit data, or call Immich write endpoints.

Never commit a real API key or bake one into a container image. See the [deployment guide](docs/deployment.md) for configuration and network options.

## Requirements

- Docker Engine with Docker Compose v2, or Portainer connected to a Docker Standalone environment.
- An existing Immich server reachable from the GenzoRoom backend container.
- A dedicated Immich API key with `user.read`, `asset.read`, and `asset.view` permissions.
- A browser that can reach the GenzoRoom frontend. The default host port is `3190` and can be changed with `GENZOROOM_PORT`.

## Quick start

1. Create a dedicated Immich API key with the minimum permissions listed above.
2. For Docker Compose, copy [`.env.example`](.env.example) to `.env` and configure `IMMICH_URL` and `IMMICH_API_KEY`. Portainer users can set the same values as Stack environment variables. Optionally set `GENZOROOM_PORT`; it defaults to `3190`.
3. From a repository checkout, build and start the standard Docker Compose deployment:

   ```sh
   docker compose up -d --build
   ```

4. Open `http://<HOST-IP>:3190`, or the configured port.

If Immich runs on the same Docker host and is not reachable through the host LAN address, use the optional shared-network configuration documented in the [deployment guide](docs/deployment.md). Portainer Git Repository Stack instructions are covered there as well.

## Architecture and documentation

- [Architecture](docs/architecture.md) — request flow, container boundaries, editing model, and current technical limitations.
- [Deployment](docs/deployment.md) — Docker Compose, Portainer, Immich network routes, verification, troubleshooting, and removal.
- [Development notes (Japanese)](docs/development-notes.ja.md) — implementation history and design decisions.
- [Deployment notes (Japanese)](docs/deployment-notes.ja.md) — notes for the currently validated NAS environment.

## License

GenzoRoom is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
