# GenzoRoom

**Status: Early Development — authenticated Immich connectivity and a small recent-photo view are available. Photo editing is not implemented.**

GenzoRoom is a hobby and learning project aiming to become a self-hosted photo development and color correction interface for photos managed by Immich, accessible through a web browser.

The name comes from the Japanese word **現像 (genzō)**, meaning photographic development, and evokes a photo development room.

## Current state

The scaffold contains a React / TypeScript / Vite frontend, a Python 3.13 / FastAPI / Uvicorn backend, and Docker Compose configuration. The page shows separate backend and Immich connection states and up to 10 recent photos in a simple thumbnail grid. The button reloads both states and the photo list; there is no background polling.

GenzoRoom's UI currently supports English and Japanese. It initially follows the browser language and remembers a language selected in the UI.

nginx serves the built frontend and forwards same-origin API requests to the backend. `GET /api/health` checks GenzoRoom's backend. `GET /api/immich/status` makes the backend call Immich's authenticated current-user endpoint. `GET /api/assets/recent` returns limited metadata, and thumbnail requests are also proxied through the backend so the Immich API key is never sent to the browser. The backend can reach Immich through a routed network, an HTTPS URL, or an optional shared Docker network. Photo detail views, image processing, editing, and GenzoRoom user authentication are not implemented.

## Choose an Immich connection route

GenzoRoom always uses `IMMICH_URL` and `IMMICH_API_KEY` for the application-level connection. Choose a URL that is reachable from the backend container. Never commit a real API key or place it in source code or an image.

The API key needs only `user.read` for the connection check, `asset.read` for recent-photo metadata, and `asset.view` for thumbnails. Do not grant write, upload, delete, or download permissions for this stage.

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

## Deployment

GenzoRoom supports two deployment workflows. Use Docker Compose when you want to manage the repository and commands directly on the host. Use a Portainer Git Repository Stack when you want Portainer to fetch, build, and deploy the project from a Git repository. Both workflows use the same Compose configuration and expose only the frontend port, which defaults to `3190`; the backend port `8000` remains internal to Docker.

### Docker Compose

On a NAS or other server with Docker Engine and Docker Compose available:

1. Clone this repository into a deployment directory, or place the complete repository contents there using an equivalent method. Do not include local `node_modules`, virtual environments, or build output.
2. Supply `IMMICH_URL` and `IMMICH_API_KEY` as environment variables using one of the connection routes above. You can copy `.env.example` to the ignored `.env` file and replace its example values. Never commit a real API key. `GENZOROOM_PORT` is optional and defaults to `3190`.
3. For network-accessible Immich, start the standard Compose configuration:

   ```sh
   docker compose config
   docker compose up -d --build
   docker compose ps
   ```

   For Immich on the same Docker host, use both Compose files for validation, startup, status checks, and later operational commands:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.immich-network.yml config
   docker compose -f docker-compose.yml -f docker-compose.immich-network.yml up -d --build
   docker compose -f docker-compose.yml -f docker-compose.immich-network.yml ps
   ```

The initial build requires internet access for base images and dependencies. Vite runs only during the build; nginx serves the built static files during operation.

### Portainer Git Repository Stack

Portainer can fetch the project directly from any Git repository it can access, so the repository does not need to be copied manually to the deployment host.

1. Create a Stack that uses a Git repository as its source or build method.
2. Enter the repository URL and select the required branch or reference.
3. Set the Compose path to `docker-compose.yml`.
4. Add `IMMICH_URL` and `IMMICH_API_KEY` as Stack environment variables. Add `GENZOROOM_PORT` only when you want to override the default frontend port of `3190`. Keep the real API key outside the repository.
5. Build and deploy the Stack.

When Immich runs on the same Docker host and requires shared-network access, also add `docker-compose.immich-network.yml` as an additional Compose path and set `IMMICH_DOCKER_NETWORK` to the name of the existing Immich network. The external network must already exist on the same Docker endpoint. The override connects only the backend to that network; the frontend remains isolated from it.

Use a Docker Standalone workflow that provides the complete repository as the build context and can build both services. This Compose configuration is not intended for Swarm. After repository updates are available, use Portainer's pull and redeploy action to rebuild and update the Stack.

### Verify the deployment

1. Open `http://<NAS-IP>:3190` or the configured port. Confirm `Backend: Connected`, `Immich: Connected`, and a grid containing up to 10 recent photos. Missing environment variables show `Immich: Not configured`; rejected credentials, unreachable servers, insufficient asset permissions, and unexpected API responses produce a failed state or photo-loading message.
2. Open `http://<NAS-IP>:3190/api/health` and confirm `{"status":"ok"}`.
3. Open `http://<NAS-IP>:3190/api/immich/status` and confirm `{"configured":true,"connected":true}`.

For troubleshooting, inspect the frontend and backend container logs. With Docker Compose, run `docker compose logs frontend backend`; when using the shared-network override, include both `-f` arguments in operational commands. To verify the error state, stop the backend, click **Check again**, and confirm a connection failure. Restart the backend and check again to confirm recovery; allow a few seconds for startup and internal DNS refresh.

Stop and remove a Docker Compose deployment with `docker compose down`, including both `-f` arguments when the shared-network override is in use. In Portainer, remove the Stack. This stage creates no application volumes, persistent data, or host bind mounts. Repository files and built images remain until explicitly removed.

## Planned direction

The following capabilities are ideas for future development, **not implemented features or delivery commitments**:

- Browser-based photo development and color correction for Immich photos.
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
2. Prepare the repository on the NAS for Docker Compose, or configure Portainer to fetch it directly from an accessible Git repository.
3. Start the application on the NAS using Docker Compose or a Portainer Git Repository Stack.
4. Verify actual behavior in the NAS environment.

The default Web UI host port is **3190**, configurable through `GENZOROOM_PORT`. The backend container port is **8000**, reachable by the frontend over the internal Docker network and not published to the host.

The design must avoid Windows-specific runtime dependencies, hardcoded Windows application paths, and NAS host OS configuration changes. Application-specific configuration and persistent data must live inside containers or explicitly declared Docker volumes, without writing application settings directly into the NAS host OS. Cleanup should leave no unnecessary host settings or files behind.

Local checks do not establish NAS compatibility. NAS container startup, proxy behavior, browser connectivity, and failure recovery must be verified on the target environment.

## Local development checks

Use Node.js 24 and Python 3.13 for development. From `frontend/`, run `npm ci` and `npm run build` to check TypeScript and build static assets. From the repository root, run `python -m py_compile backend/main.py backend/immich.py`, `python -m unittest discover -s backend/tests`, and `docker compose config` for basic static checks.

For optional local development, install `backend/requirements.txt` in a Python virtual environment, then run `uvicorn main:app --host 127.0.0.1 --port 8000` from `backend/`. Run `npm run dev` from `frontend/`. Vite proxies `/api/` to the local backend; browser code always uses a relative same-origin URL. This development server is not used in the NAS deployment.

## Documentation and contribution conventions

Public-facing documentation and [the changelog](CHANGELOG.md) are written in English. Commit messages are written in Japanese; Conventional Commits prefixes may be in English, for example `docs: READMEを更新`. Commit message bodies should also remain in Japanese.

The changelog follows a simple Keep a Changelog-style structure with an `Unreleased` section. Record changes meaningful to users. Minor refactoring, variable renaming, comment corrections, and internal test-only changes do not need entries unless they affect users.

## License

GenzoRoom is licensed under the [MIT License](LICENSE).
