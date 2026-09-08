# GenzoRoom

**Status: Early Development — a minimal connectivity scaffold is available. Photo features are not implemented.**

GenzoRoom is a hobby and learning project aiming to become a self-hosted photo development and color correction interface for photos managed by Immich, accessible through a web browser.

The name comes from the Japanese word **現像 (genzō)**, meaning photographic development, and evokes a photo development room.

## Current state

The first-stage scaffold contains a React / TypeScript / Vite frontend, a Python 3.13 / FastAPI / Uvicorn backend, and Docker Compose configuration. The page shows checking, connected, and error states and a button to check again. A check times out after five seconds; the displayed result is the last check, not continuous monitoring.

nginx serves the built frontend and forwards same-origin `GET /api/health` requests to the backend's `GET /health`, which returns `{"status":"ok"}`. Immich integration, image loading and processing, photo editing, and authentication are not implemented.

## Run on a NAS with Docker Compose

Use a NAS with Docker Engine and Docker Compose available. From a designated deployment directory on the NAS:

1. Copy the repository, including `frontend/`, `backend/`, and `docker-compose.yml`, to that directory. Do not copy local `node_modules`, virtual environments, or build output.
2. Optionally copy `.env.example` to `.env` and change `GENZOROOM_PORT`. Without a `.env` file, the default is `3190`.
3. Run:

   ```sh
   docker compose config
   docker compose up -d --build
   docker compose ps
   ```

4. Open `http://<NAS-IP>:3190` (or the configured port). Confirm `GenzoRoom`, `Status: Early Development`, and `Backend: Connected`.
5. Open `http://<NAS-IP>:3190/api/health` and confirm `{"status":"ok"}`.

The initial build requires internet access for base images and dependencies. Vite runs at build time; nginx serves static files during NAS operation. The backend has no published host port.

Portainer can manage the resulting containers on the same Docker endpoint. For a Portainer stack, use a Docker Standalone workflow that supplies the complete repository as build context and supports building both services. Pasting only the Compose YAML into a web editor does not supply `./frontend` and `./backend`. This configuration is not intended for Swarm.

For troubleshooting, run `docker compose logs frontend backend`. To verify the error state, run `docker compose stop backend`, click **Check again**, and confirm a connection failure. Run `docker compose start backend` and check again to confirm recovery; allow a few seconds for startup and internal DNS refresh.

Stop and remove the deployment with `docker compose down`. This stage creates no application volumes, persistent data, or host bind mounts. The copied project directory and built images remain until explicitly removed.

## Planned direction

The following capabilities are ideas for future development, **not implemented features or delivery commitments**:

- Immich API integration and browser-based photo development and color correction.
- Non-destructive editing, with edit parameters stored separately from original images.
- JPEG and HEIC support, with RAW and DNG development considered for a later stage.
- Exposure, contrast, highlights, shadows, white balance, tone curve, and HSL controls.
- Histogram display, with waveform and RGB parade considered for a later stage.
- Preview rendering, client-side GPU assistance where useful, and high-quality server-side rendering.

The current stack is React with TypeScript for the frontend and FastAPI with Python for the backend. All architectural choices may change. See [the provisional architecture](docs/architecture.md).

## Intended deployment and validation

The target environment is a self-hosted NAS running Docker / Portainer. Windows is a local development environment; successful execution on Windows alone will not count as completed runtime validation.

The validation workflow is:

1. Develop in the local Windows workspace.
2. Copy or deploy the required project files to the NAS.
3. Start the application on the NAS using Docker Compose / Portainer.
4. Verify actual behavior in the NAS environment.

The default Web UI host port is **3190**, configurable through `GENZOROOM_PORT`. The backend container port is **8000**, reachable by the frontend over the internal Docker network and not published to the host.

The design must avoid Windows-specific runtime dependencies, hardcoded Windows application paths, and NAS host OS configuration changes. Application-specific configuration and persistent data must live inside containers or explicitly declared Docker volumes, without writing application settings directly into the NAS host OS. Cleanup should leave no unnecessary host settings or files behind.

Local checks do not establish NAS compatibility. NAS container startup, proxy behavior, browser connectivity, and failure recovery must be verified on the target environment.

## Local development checks

Use Node.js 24 and Python 3.13 for development. From `frontend/`, run `npm ci` and `npm run build` to check TypeScript and build static assets. From the repository root, run `python -m py_compile backend/main.py` and `docker compose config` for basic static checks.

For optional local development, install `backend/requirements.txt` in a Python virtual environment, then run `uvicorn main:app --host 127.0.0.1 --port 8000` from `backend/`. Run `npm run dev` from `frontend/`. Vite proxies `/api/` to the local backend; browser code always uses a relative same-origin URL. This development server is not used in the NAS deployment.

## Documentation and contribution conventions

Public-facing documentation and [the changelog](CHANGELOG.md) are written in English. Commit messages are written in Japanese; Conventional Commits prefixes may be in English, for example `docs: READMEを更新`. Commit message bodies should also remain in Japanese.

The changelog follows a simple Keep a Changelog-style structure with an `Unreleased` section. Record changes meaningful to users. Minor refactoring, variable renaming, comment corrections, and internal test-only changes do not need entries unless they affect users.

## License

GenzoRoom is licensed under the [MIT License](LICENSE).
