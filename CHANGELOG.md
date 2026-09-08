# Changelog

Meaningful user-facing changes to GenzoRoom will be documented here in English, using a simple Keep a Changelog-style structure.

Internal changes are omitted unless they affect users.

## [Unreleased]

### Added

- Initial public project documentation describing the early development status, planned direction, and provisional NAS deployment architecture.
- A minimal web page showing backend connectivity, including failure feedback and a manual recheck button.
- A health endpoint and Docker Compose deployment with a configurable Web UI port (default `3190`) and same-origin API proxying. Immich integration and photo editing are not implemented.
- An authenticated Immich connectivity check, configured through backend environment variables, with connected, not configured, and failed states in the Web UI. Photo retrieval and editing remain unimplemented.

### Fixed

- Include all backend application modules in the production image so the backend can start with the Immich connectivity module.
