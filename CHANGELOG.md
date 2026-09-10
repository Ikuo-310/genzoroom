# Changelog

Meaningful user-facing changes to GenzoRoom will be documented here in English, using a simple Keep a Changelog-style structure.

Internal changes are omitted unless they affect users.

## [Unreleased]

### Added

- Non-destructive JPEG Exposure adjustment (−5 to +5 EV, 0.01 EV steps) in Anshitsu, with per-asset in-memory recipes and a Canvas linear-light preview pipeline. This initial version uses Immich previews as a temporary source.
- Grouped edit History, Undo/Redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y), Exposure Reset, and undoable All Reset.
- Reusable sliders with hover/focus arrow controls: left/right change one step, up/down ten steps. Native form editing keeps its keyboard behavior.
- Independently resizable Anshitsu side panels with remembered widths, safe sizing limits, and preserved collapse/expand behavior.

- Initial public project documentation describing the early development status, planned direction, and provisional NAS deployment architecture.
- A minimal web page showing backend connectivity, including failure feedback and a manual recheck button.
- A health endpoint and Docker Compose deployment with a configurable Web UI port (default `3190`) and same-origin API proxying. Immich integration and photo editing are not implemented.
- An authenticated Immich connectivity check, configured through backend environment variables, with connected, not configured, and failed states in the Web UI. Photo retrieval and editing remain unimplemented.
- An optional Compose override that connects only the backend to an existing Immich Docker network for same-host deployments.
- A recent-photo grid that retrieves up to 10 images from Immich and displays proxied thumbnails without exposing the Immich API key to the browser.
- English and Japanese UI support with a remembered manual language selection.
- Locale-aware photo date and time formatting for English and Japanese.
- Image format badges on photo cards, including distinct RAW format metadata for future filtering.
- Client-side RAW and Non-RAW filters for the fetched recent-photo list.
- An initial Anshitsu photo development workspace with a large preview, zoom and pan controls, collapsible side panels, selected EXIF details, and a Filmstrip foundation.
- Multi-photo selection in the recent-photo grid, with ordered selected photos sent to Anshitsu and switchable from the Filmstrip.

### Changed

- Made Anshitsu adjustment rows more compact, with synchronized direct numeric input and an inline per-adjustment reset control.
- Reorganized the Anshitsu side panels so History and EXIF remain on the left, while Scope sits above Develop controls on the right.
- Changed the project license from the MIT License to the GNU Affero General Public License v3.0 (`AGPL-3.0-only`).
- Reorganized the README around the current feature set and moved detailed deployment guidance to a dedicated document.

### Fixed

- Include all backend application modules in the production image so the backend can start with the Immich connectivity module.
