# Deployment

This guide covers the supported Docker Compose and Portainer deployment workflows for GenzoRoom. It is written for general Docker and self-hosted NAS environments; exact host, repository, network, and container names depend on the deployment.

GenzoRoom exposes only its frontend. The default Web UI host port is `3190`. nginx serves the built frontend and forwards same-origin `/api/` requests to the backend over an internal Docker network. Backend port `8000` is not published to the host, and the frontend does not receive the Immich API key.

## Requirements

- Docker Engine with Docker Compose v2, or Portainer connected to a Docker Standalone environment.
- Access to the repository contents and internet access during the initial image build.
- An existing Immich deployment reachable from the GenzoRoom backend.
- A dedicated Immich API key with these minimum permissions:
  - `user.read` for the authenticated connection check.
  - `asset.read` for recent-photo metadata and asset details.
  - `asset.view` for thumbnails and previews.

GenzoRoom currently uses read-only Immich endpoints. Do not grant upload, update, delete, or other write permissions unless a future feature explicitly requires them.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `IMMICH_URL` | Yes | Immich base URL as reached from the backend container. |
| `IMMICH_API_KEY` | Yes | Dedicated Immich API key. Keep the real value outside the repository. |
| `GENZOROOM_PORT` | No | Frontend host port; defaults to `3190`. |
| `IMMICH_DOCKER_NETWORK` | Same-host route only | Existing external Docker network used by Immich. |

For command-line Compose, these values can be supplied by the shell or an ignored `.env` file based on `.env.example`. For Portainer, configure them as Stack environment variables. Never commit a real API key or bake it into a container image.

## Choose an Immich connection route

GenzoRoom always uses `IMMICH_URL` and `IMMICH_API_KEY` at the application level. Choose an `IMMICH_URL` that is reachable from the backend container.

### Network-accessible Immich

Use `docker-compose.yml` by itself when Immich is reachable through a LAN or routed address:

```env
IMMICH_URL=http://192.168.1.50:2283
IMMICH_API_KEY=replace-with-your-api-key
GENZOROOM_PORT=3190
```

An HTTPS URL such as `https://photos.example.com` can also be used. TLS certificate verification remains enabled. This route does not require access to an Immich Docker network.

### Immich on the same Docker host

Some Docker hosts cannot route a container back to a service through the host's own LAN address. In that case, connect only the GenzoRoom backend to Immich's existing Docker network and use the Immich server's Docker DNS name.

Identify the actual Immich network and service or container name before deployment. These values belong to the local environment and are not hardcoded by GenzoRoom. Example values are:

```env
IMMICH_DOCKER_NETWORK=your-existing-immich-network
IMMICH_URL=http://your-immich-server-name:2283
IMMICH_API_KEY=replace-with-your-api-key
```

The external network must already exist. Combine the standard configuration with `docker-compose.immich-network.yml`:

```sh
docker compose \
  -f docker-compose.yml \
  -f docker-compose.immich-network.yml \
  up -d --build
```

The override attaches only the backend to the external network. The frontend remains isolated from Immich. `IMMICH_DOCKER_NETWORK` is consumed by Compose and is not read by the GenzoRoom application.

## Deploy with Docker Compose

1. Clone the repository into a deployment directory, or place the complete repository contents there by another method. Do not copy local `node_modules`, virtual environments, or build output.
2. Supply the environment variables described above. To use a local `.env` file, copy `.env.example`, replace its example values, and keep `.env` untracked.
3. Validate, build, and start the standard deployment:

   ```sh
   docker compose config
   docker compose up -d --build
   docker compose ps
   ```

For the same-host Immich route, include both Compose files in validation and operational commands:

```sh
docker compose -f docker-compose.yml -f docker-compose.immich-network.yml config
docker compose -f docker-compose.yml -f docker-compose.immich-network.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.immich-network.yml ps
```

The frontend image uses Vite only during the build. nginx serves the resulting static files in the running container. To update a repository checkout, obtain the new repository contents and run the appropriate `up -d --build` command again.

### Optional checks before deployment

Local checks can catch syntax and configuration errors, but they do not replace validation on the target Docker or NAS host. The current development toolchain uses Node.js 24 and Python 3.13. Typical checks are:

```sh
cd frontend
npm ci
npm run build

cd ..
python -m py_compile backend/main.py backend/immich.py
python -m unittest discover -s backend/tests
docker compose config
```

For optional frontend development, run Uvicorn from `backend/` on loopback port `8000` and `npm run dev` from `frontend/`. Vite proxies `/api/` to that local backend. The Vite development server is not used in the deployed frontend container.

## Deploy with a Portainer Git Repository Stack

Portainer can fetch, build, and deploy GenzoRoom directly from any Git repository it can access. Manual copying to the deployment host is not required.

1. Create a Stack using a Git repository as its source or build method.
2. Enter the repository URL and select the required branch or reference.
3. Set the Compose path to `docker-compose.yml`.
4. Add `IMMICH_URL` and `IMMICH_API_KEY` as Stack environment variables. Add `GENZOROOM_PORT` only to change the default port.
5. Build and deploy the Stack.

For same-host Immich networking, add `docker-compose.immich-network.yml` as an additional Compose path and set `IMMICH_DOCKER_NETWORK` to the existing Immich network name. The Stack must target the Docker endpoint where that network exists.

After repository updates become available, use Portainer's pull and redeploy action to rebuild and update the Stack. UI labels vary between Portainer versions, but the workflow must refresh the Git source and recreate the services from the current Compose configuration.

The current configuration targets Docker Standalone and is not a Docker Swarm deployment.

## Verify the deployment

1. Open `http://<HOST-IP>:3190`, or the configured `GENZOROOM_PORT`.
2. Confirm that the UI reports `Backend: Connected` and `Immich: Connected`.
3. Confirm that recent photos and thumbnails appear.
4. Select or open a photo and confirm that Anshitsu loads its preview and available EXIF data.
5. Open `http://<HOST-IP>:3190/api/health` and confirm:

   ```json
   {"status":"ok"}
   ```

6. Open `http://<HOST-IP>:3190/api/immich/status` and confirm:

   ```json
   {"configured":true,"connected":true}
   ```

Missing connection variables produce `Immich: Not configured`. Rejected credentials, unreachable servers, insufficient permissions, or unexpected Immich responses produce a failed connection or photo-loading state without exposing the API key.

Successful execution in a local development environment does not establish NAS compatibility. Verify container startup, proxy behavior, browser access, photo loading, and failure recovery on the target host.

## Logs and troubleshooting

Inspect both service logs first:

```sh
docker compose logs frontend backend
```

When using the same-host override, include both `-f` arguments in operational commands. Portainer users can inspect the equivalent container logs and console through the Stack's Docker environment.

Check the following when the backend or Immich connection fails:

- Confirm that `IMMICH_URL` is reachable from the backend container, including its scheme, host, and port.
- Confirm that `IMMICH_API_KEY` is current and has `user.read`, `asset.read`, and `asset.view` permissions.
- If the connection check succeeds but photos fail, verify `asset.read` and `asset.view` specifically.
- For same-host deployments, confirm the external network name, Immich Docker DNS name, additional Compose path, and Docker endpoint.
- Backend port `8000` is intentionally unavailable from the host; test through the frontend's `/api/` routes.

To check failure recovery, stop the backend, use **Check again** in the UI, restart the backend, allow time for startup and Docker DNS refresh, and check again.

## Security and host isolation

- Only the frontend port is published. Backend port `8000` remains on GenzoRoom's internal Docker network.
- The Immich API key is supplied only to the backend and must not be stored in the repository.
- The optional same-host override attaches only the backend to the Immich network; the frontend remains isolated.
- Both containers run as non-root users, drop Linux capabilities, and disable privilege escalation.
- The Compose files do not use privileged mode, host networking, or host directory bind mounts.
- TLS certificate verification for HTTPS Immich URLs remains enabled.
- GenzoRoom does not require changes to NAS host OS settings or system files.

## Stop or remove GenzoRoom

Stop and remove a standard Compose deployment with:

```sh
docker compose down
```

For a same-host deployment, use the same pair of Compose files:

```sh
docker compose -f docker-compose.yml -f docker-compose.immich-network.yml down
```

In Portainer, remove the GenzoRoom Stack. The shared Immich network is external and is not removed by GenzoRoom Compose commands.

GenzoRoom currently creates no application volumes, persistent application data, or host bind mounts. Repository files and built images remain until explicitly removed. Future persistent-data features must distinguish container removal from volume removal.
