# Changelog

Meaningful user-facing changes to GenzoRoom will be documented here in English, using a simple Keep a Changelog-style structure.

Internal changes are omitted unless they affect users.

## [Unreleased]

### Added

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

### Fixed

- Include all backend application modules in the production image so the backend can start with the Immich connectivity module.
