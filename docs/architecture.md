# Provisional Architecture

**Status: Early Development — design only, with no application implementation.**

This document describes an initial direction, not an implemented system or a stable specification. Every component, technology choice, interface, and deployment detail is provisional and may change during development.

## Intended request flow

```text
Browser
  ↓
Frontend
  ↓
Backend API
  ↓
Immich API
```

The browser would access a frontend built with React and TypeScript. The frontend would communicate with a FastAPI / Python backend, which would integrate with the Immich API. Authentication, credentials handling, API compatibility, and asset access behavior remain to be designed.

To keep the backend private to the Docker network, the frontend-facing service is expected to forward browser API requests to the backend. The exact routing mechanism has not been selected; the browser should not need direct access to the backend container port.

## Planned responsibilities

| Component | Tentative responsibility |
| --- | --- |
| Frontend | Browser-based photo display, editing controls, and visual feedback using React and TypeScript. |
| Backend API | Immich integration, edit parameter coordination, and rendering orchestration using FastAPI and Python. |
| Immich API | Access to photos managed by the user's Immich instance; integration details remain undecided. |
| Edit parameter storage | Store non-destructive edit parameters separately from original images. The storage engine and schema are undecided. |
| Preview rendering | Provide responsive editing previews, potentially using client-side GPU assistance where useful. The division between client and server work is undecided. |
| Final rendering | Produce high-quality output on the server. Output formats, persistence, and export or Immich write-back behavior remain undecided. |
| RAW processing | Evaluate LibRaw, rawpy, or alternatives for future RAW / DNG development. No library has been selected or integrated. |

JPEG and HEIC support are planned; RAW and DNG development are longer-term possibilities. Planned editing controls include exposure, contrast, highlights, shadows, white balance, tone curve, and HSL. A histogram is envisaged, with waveform and RGB parade as possible later additions. None of these capabilities is available yet.

The non-destructive design aims to preserve original images and store editing instructions independently. Parameter versioning, preview caching, rendering consistency, and handling of derived images require further design.

## Intended Docker deployment and network

The target deployment environment is a self-hosted NAS using Docker Compose / Portainer. Dockerfiles and Compose configuration have not been created.

| Endpoint | Proposed port | Exposure policy |
| --- | --- | --- |
| Web UI | Host port `3190` by default | User-facing entry point; the future Compose configuration must allow changing the host port. |
| Backend API | Container port `8000` | Docker internal network only; no host port publication unless explicitly required. |

The future default access URL is `http://<NAS-IP>:3190`. The frontend container's listening port is undecided. Only the frontend-facing service is intended to publish a host port by default.

## Portability, storage, and cleanup constraints

- Do not introduce Windows-specific runtime dependencies or hardcode Windows paths in application code.
- Do not require NAS host OS configuration changes or write application-specific files and settings directly into the NAS host OS.
- Manage application-specific configuration and persistent data inside Docker containers or explicitly declared Docker volumes. Data that must survive container replacement belongs in declared persistent volumes.
- Copying or deploying project files into a designated NAS deployment directory is part of the workflow; it must not require modifying host OS configuration or installing application components into host system directories.
- Favor a removable deployment that leaves no unnecessary host settings or files. Future operational instructions should distinguish removing containers from explicitly deleting persistent volumes so that user data is not removed unintentionally.

Volume names, configuration delivery, credentials storage, backups, and cache retention are not yet specified.

## Development and runtime validation

The Windows workspace is only a local development and working directory. Its location is not a runtime dependency and must not be embedded in application code or deployment configuration.

The intended validation workflow is:

1. Develop in the local Windows workspace.
2. Copy or deploy the necessary files to the NAS.
3. Start the services on the NAS using Docker Compose / Portainer.
4. Verify real application behavior in the NAS environment.

Successful execution on local Windows alone does not constitute completed runtime validation. NAS-based checks will be needed for deployment, connectivity to Immich, supported image handling, rendering, and persistence as those features are implemented. No runtime validation is possible for this documentation-only scaffold.
