# GenzoRoom

**Status: Early Development — Immich browsing and minimal JPEG Exposure/Contrast/Highlights/Whites/Shadows/Blacks adjustments are available. RAW development is not implemented.**

GenzoRoom is a hobby and learning project aiming to become a self-hosted browser interface for developing and color-correcting photos managed by [Immich](https://immich.app/).

The name comes from the Japanese word **現像 (genzō)**, meaning photographic development, and evokes a photo development room.

## Current state

GenzoRoom currently provides:

- Authenticated, read-only connectivity to Immich.
- A grid of up to 50 recent photos with proxied thumbnails.
- Image format badges for JPEG, HEIC, DNG, and other recognized extensions.
- Client-side RAW and Non-RAW filtering.
- Ordered multi-photo selection and transfer to the **Anshitsu** development workspace.
- A large preview, EXIF display, Filmstrip, and active-photo switching in Anshitsu.
- Fit, 1:1, zoom, and pan controls, with independently collapsible and resizable desktop side panels whose widths are remembered.
- Non-destructive JPEG Exposure, Contrast, Highlights, Whites, Shadows, and Blacks adjustments with compact slider/direct-value controls, per-asset in-memory recipes, grouped Undo/Redo and History, individual resets, and All Reset. This initial version uses Immich previews as a temporary input.
- English and Japanese UI, remembered language selection, and locale-aware date and time display.

All current Immich operations are read-only. The browser uses same-origin `/api/` routes through GenzoRoom, and the Immich API key remains in the backend.

The following are not implemented:

- HEIC adjustments and JPEG adjustments other than Exposure, Contrast, Highlights, Whites, Shadows, and Blacks.
- RAW development.
- Persistent storage of non-destructive edit recipes.
- Scope displays, including Histogram, Waveform, and RGB Parade.
- Export or write-back to Immich.
- Immich asset Stack handling.

## Requirements

- A host with Docker Engine and Docker Compose, or a Portainer environment that can build a Git Repository Stack.
- An Immich server reachable from the GenzoRoom backend container.
- An Immich API key with `user.read`, `asset.read`, and `asset.view` permissions.
- A browser that can reach the GenzoRoom Web UI port. The default host port is `3190` and can be changed with `GENZOROOM_PORT`.

The backend listens on port `8000` inside Docker and is not published to the host.

## Quick Start

1. Create a dedicated Immich API key with `user.read`, `asset.read`, and `asset.view` permissions.
2. Configure `IMMICH_URL` and `IMMICH_API_KEY`. Optionally set `GENZOROOM_PORT`; it defaults to `3190`.
3. Deploy with Docker Compose or a Portainer Git Repository Stack. For example, from a repository checkout:

   ```sh
   docker compose up -d --build
   ```

4. Open `http://<HOST-IP>:3190`, or the configured port.

Never commit a real API key. If Immich runs on the same Docker host and the host LAN address is not reachable from containers, use the optional shared-network deployment described in the [deployment guide](docs/deployment.md).

## Documentation

- [Deployment guide](docs/deployment.md) — Docker Compose, Portainer, Immich network routes, verification, and troubleshooting.
- [Provisional architecture](docs/architecture.md) — current request flow, container boundaries, and planned architecture.
- [Development notes (Japanese)](docs/development-notes.ja.md) — internal, developer-oriented history and design decisions.
- [Deployment notes (Japanese)](docs/deployment-notes.ja.md) — internal notes for the project's currently validated NAS environment.

## License

GenzoRoom is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
