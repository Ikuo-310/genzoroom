# GenzoRoom

**Status: Early Development — backend and authenticated Immich connectivity checks are available. Photo features are not implemented.**

GenzoRoom is a hobby and learning project aiming to become a self-hosted photo development and color correction interface for photos managed by Immich, accessible through a web browser.

The name comes from the Japanese word **現像 (genzō)**, meaning photographic development, and evokes a photo development room.

## Current state

The scaffold contains a React / TypeScript / Vite frontend, a Python 3.13 / FastAPI / Uvicorn backend, and Docker Compose configuration. The page shows separate backend and Immich connection states with a button to check again. The displayed result is the last check, not continuous monitoring.

nginx serves the built frontend and forwards same-origin API requests to the backend. `GET /api/health` checks GenzoRoom's backend. `GET /api/immich/status` makes the backend call Immich's authenticated current-user endpoint. The backend can reach Immich through a routed network, an HTTPS URL, or an optional shared Docker network. Photo retrieval, image processing, editing, and GenzoRoom user authentication are not implemented.

## Choose an Immich connection route

GenzoRoom always uses `IMMICH_URL` and `IMMICH_API_KEY` for the application-level connection. Choose a URL that is reachable from the backend container. Never commit a real API key or place it in source code or an image.

### Network-accessible Immich

Use the standard `docker-compose.yml` by itself when Immich is reachable through a LAN / routed address or an HTTPS URL:

```env
IMMICH_URL=http://192.168.1.50:2283
IMMICH_API_KEY=replace-with-your-api-key
```

An HTTPS deployment can instead use a URL such as `https://photos.example.com`. No external Immich Docker network is required for this mode.

### Immich on the same Docker host

Some Docker hosts cannot route a container back to a service through the host's own LAN address. In that case, attach only the GenzoRoom backend to the existing Docker network used by Immich and address the Immich server by its Docker DNS name.

First identify the actual Immich network name and the Immich server's service or container name in your deployment. These values are deployment-specific and are not defined by GenzoRoom. Then configure values such as:

```env
IMMICH_DOCKER_NETWORK=your-existing-immich-network
IMMICH_URL=http://your-immich-server-name:2283
IMMICH_API_KEY=replace-with-your-api-key
```

The external network must already exist. Start Compose with both files:

```sh
docker compose \
  -f docker-compose.yml \
  -f docker-compose.immich-network.yml \
  up -d --build
```

The optional file adds only the backend to the external network. The frontend remains isolated from Immich. `IMMICH_DOCKER_NETWORK` is used by Compose for deployment and is not read by the GenzoRoom application.

## Run on a NAS with Docker Compose

Use a NAS with Docker Engine and Docker Compose available. From a designated deployment directory on the NAS:

1. Copy the repository, including `frontend/`, `backend/`, and the Compose files, to that directory. Do not copy local `node_modules`, virtual environments, or build output.
2. Supply `IMMICH_URL` and `IMMICH_API_KEY` as environment variables using one of the connection routes above. For local Compose use, copy `.env.example` to the ignored `.env` file and replace its example values. `GENZOROOM_PORT` is optional and defaults to `3190`.
3. For network-accessible Immich, run the standard Compose file:

   ```sh
   docker compose config
   docker compose up -d --build
   docker compose ps
   ```

   For same-host shared-network access, use both Compose files as shown above for `config`, `up`, `ps`, and later operational commands.

4. Open `http://<NAS-IP>:3190` (or the configured port). Confirm `Backend: Connected` and `Immich: Connected`. Missing environment variables show `Immich: Not configured`; rejected credentials, unreachable servers, and unexpected API responses show `Immich: Connection failed`.
5. Open `http://<NAS-IP>:3190/api/health` and confirm `{"status":"ok"}`.
6. Open `http://<NAS-IP>:3190/api/immich/status` and confirm `{"configured":true,"connected":true}`.

The initial build requires internet access for base images and dependencies. Vite runs at build time; nginx serves static files during NAS operation. The backend has no published host port.

Portainer can manage the resulting containers on the same Docker endpoint. For a GitHub Repository stack, add `IMMICH_URL` and `IMMICH_API_KEY` under the stack's Environment variables so the secret stays outside the repository. For normal network access, set the Compose path to `docker-compose.yml` and do not add the optional file.

For a same-host shared network, set the Compose path to `docker-compose.yml`, add `docker-compose.immich-network.yml` under **Additional paths**, and add `IMMICH_DOCKER_NETWORK` along with the two application variables. Portainer processes additional paths as Compose overrides. The selected external network must already exist on the same Docker endpoint. Use a Docker Standalone workflow that supplies the complete repository as build context and supports building both services. This configuration is not intended for Swarm.

For troubleshooting, run `docker compose logs frontend backend`. When using the shared-network file, include both `-f` arguments in operational commands. To verify the error state, stop the backend, click **Check again**, and confirm a connection failure. Restart the backend and check again to confirm recovery; allow a few seconds for startup and internal DNS refresh.

Stop and remove the deployment with `docker compose down`. This stage creates no application volumes, persistent data, or host bind mounts. The copied project directory and built images remain until explicitly removed.

## Planned direction

The following capabilities are ideas for future development, **not implemented features or delivery commitments**:

- Photo access through the Immich API and browser-based photo development and color correction.
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
