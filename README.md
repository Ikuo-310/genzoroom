# GenzoRoom

**Status: Early Development — documentation only. No application features are available yet.**

GenzoRoom is a hobby and learning project aiming to become a self-hosted photo development and color correction interface for photos managed by Immich, accessible through a web browser.

The name comes from the Japanese word **現像 (genzō)**, meaning photographic development, and evokes a photo development room.

## Current state

This repository currently contains only initial project documentation, an MIT license, and ignore rules. There is no runnable application, installation procedure, or Docker deployment configuration yet.

## Planned direction

The following capabilities are ideas for future development, **not implemented features or delivery commitments**:

- Immich API integration and browser-based photo development and color correction.
- Non-destructive editing, with edit parameters stored separately from original images.
- JPEG and HEIC support, with RAW and DNG development considered for a later stage.
- Exposure, contrast, highlights, shadows, white balance, tone curve, and HSL controls.
- Histogram display, with waveform and RGB parade considered for a later stage.
- Preview rendering, client-side GPU assistance where useful, and high-quality server-side rendering.
- Self-hosted NAS deployment using Docker Compose, with Portainer as an intended management option.

The tentative stack is React with TypeScript for the frontend and FastAPI with Python for the backend. All architectural choices may change. See [the provisional architecture](docs/architecture.md).

## Intended deployment and validation

The target environment is a self-hosted NAS running Docker / Portainer. Windows is a local development environment; successful execution on Windows alone will not count as completed runtime validation.

Once an application and deployment configuration exist, the intended workflow is:

1. Develop in the local Windows workspace.
2. Copy or deploy the required project files to the NAS.
3. Start the application on the NAS using Docker Compose / Portainer.
4. Verify actual behavior in the NAS environment.

The planned default Web UI host port is **3190**, giving a future access URL of `http://<NAS-IP>:3190`. The host port must be user-configurable in the future Compose configuration. The planned backend container port is **8000**, reachable only over the internal Docker network unless external exposure is explicitly needed. These ports do not represent currently running services.

The design must avoid Windows-specific runtime dependencies, hardcoded Windows application paths, and NAS host OS configuration changes. Application-specific configuration and persistent data must live inside containers or explicitly declared Docker volumes, without writing application settings directly into the NAS host OS. Cleanup should leave no unnecessary host settings or files behind.

## Documentation and contribution conventions

Public-facing documentation and [the changelog](CHANGELOG.md) are written in English. Commit messages are written in Japanese; Conventional Commits prefixes may be in English, for example `docs: READMEを更新`. Commit message bodies should also remain in Japanese.

The changelog follows a simple Keep a Changelog-style structure with an `Unreleased` section. Record changes meaningful to users. Minor refactoring, variable renaming, comment corrections, and internal test-only changes do not need entries unless they affect users.

## License

GenzoRoom is licensed under the [MIT License](LICENSE).
