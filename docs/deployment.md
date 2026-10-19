# GenzoRoom Deployment Guide

English | [日本語](deployment.ja.md)

This guide explains how to deploy GenzoRoom using the official Docker image published on GitHub Container Registry (GHCR).

GenzoRoom runs as a single container and can be deployed using Docker Compose.

## Requirements

- Docker Engine and Docker Compose v2
- A Linux amd64 (x86-64) Docker host
- An Immich server accessible from the GenzoRoom container
- An Immich API key with the required permissions
- A web browser to access GenzoRoom

Arm64 environments are not currently tested or supported.

## Immich API Key

Sign in to Immich and navigate to **Account Settings → API Keys** to create a dedicated API key for GenzoRoom.

Enable the following permissions when creating the key.

| Permission | Purpose |
| --- | --- |
| `user.read` | Verify the authenticated connection |
| `asset.read` | Retrieve photo metadata |
| `asset.view` | Display thumbnails and previews |
| `asset.download` | Download original JPEG files |
| `asset.upload` | Upload developed JPEG files |
| `asset.delete` | Move explicitly confirmed assets to Trash |
| `album.read` | Browse albums and retrieve source Album membership for Export |
| `albumAsset.create` | Add exported JPEG files to the source Albums |
| `tag.read` | Retrieve tag information |
| `tag.create` | Create the GenzoRoom tag |
| `tag.asset` | Apply and repair asset tags |
| `stack.read` | Retrieve Stack information |
| `stack.create` | Create Stacks |
| `stack.update` | Update Stacks |
| `stack.delete` | Remove or dissolve Stacks |

The `server.about` permission is optional. When enabled, GenzoRoom can display Immich version information in Settings and related diagnostics.

When exporting an Asset that belongs to Albums, GenzoRoom looks up those Albums and adds the developed JPEG to each one before creating or updating its Stack. This keeps the Album's visible Stack COVER in the Album after Reload. Assets with no Album membership follow the existing Export flow. If even one Album addition fails, Export stops before stacking; the uploaded JPEG and any successful earlier Album additions may remain for a later Retry. The Retry reuses the same Export timestamp when the saved edits are unchanged to avoid creating another output Asset.

Album membership lookup needs `album.read`. Adding the JPEG needs `albumAsset.create`; `album.create` does not grant this operation. The configured Immich user must own each source Album or have Editor access. A failed membership lookup stops before upload. A missing `albumAsset.create` permission or insufficient Album access makes the addition fail and stops Export before Stack creation.

The Immich v3.3.3 native Album screen may not show a Stack icon for the exported photo even when the Album membership and Stack are correct. GenzoRoom does not change this Immich display behavior.

After upgrading to a version with database schema v6, an older GenzoRoom version cannot open the migrated database. To roll back, restore the complete data-directory backup made before the upgrade; there is no downgrade migration.

GenzoRoom uses Immich's regular Trash mechanism when moving assets to Trash. It does not permanently delete photos.

## Environment Variables

| Variable | Description |
| --- | --- |
| `IMMICH_URL` | Immich URL accessible from the GenzoRoom container |
| `IMMICH_API_KEY` | Dedicated Immich API key for GenzoRoom |
| `GENZOROOM_PERSIST_ROOT` | Host directory for persistent application data |
| `GENZOROOM_IMAGE_TAG` | Docker image tag; normally `latest` |
| `GENZOROOM_PORT` | Published host port; defaults to `3190` |

Example:

```env
GENZOROOM_IMAGE_TAG=latest
GENZOROOM_PORT=3190
GENZOROOM_PERSIST_ROOT=/path/to/genzoroom

IMMICH_URL=http://immich-server:2283
IMMICH_API_KEY=your-immich-api-key
```

Adjust `IMMICH_URL` and `GENZOROOM_PERSIST_ROOT` to match your environment.

## Persistent Storage

GenzoRoom stores editing recipes, History, the Export Queue, and export processing state in SQLite.

The database is stored at:

```text
/genzoroom/data/genzoroom.db
```

Bind mount a host directory to `/genzoroom`:

```yaml
volumes:
  - type: bind
    source: ${GENZOROOM_PERSIST_ROOT}
    target: /genzoroom
    bind:
      create_host_path: false
```

Create the host directory before deployment and ensure that UID/GID `10001:10001`, used by the GenzoRoom container, has write access.

For a new installation, GenzoRoom creates the `data` directory and database.

When updating an existing installation, use the same storage directory. Pointing the container to a different empty directory may cause GenzoRoom to start as a new installation.

Do not run multiple GenzoRoom containers against the same database.

## Connecting to Immich

Set `IMMICH_URL` to an Immich server URL reachable from inside the GenzoRoom container.

Depending on your environment, this may be a LAN address, an HTTPS URL, or a service name on a shared Docker network.

If accessing Immich through an existing Docker network, attach the GenzoRoom container to that network as needed.

## Deployment with Docker Compose

### 1. Prepare the Configuration

Download the following files from the repository:

- [compose.release.yml](../compose.release.yml)
- [.env.example](../.env.example)

Copy `.env.example` to `.env` and configure the Immich connection, image tag, persistent storage path, and other settings.

Create the persistent storage directory and configure its permissions before starting the container.

### 2. Start the Container

Run the following commands from the directory containing the configuration files:

```sh
docker compose -f compose.release.yml config --quiet
docker compose -f compose.release.yml pull
docker compose -f compose.release.yml up -d
```

### 3. Open GenzoRoom

With the default port configuration, open:

```text
http://<host-ip>:3190
```

If you changed the published port, use that port instead.

Check the Backend and Immich connection status in GenzoRoom Settings.

## Updates and Backups

GenzoRoom stores editing recipes, Export Queue entries, and related persistent data in the configured storage directory.

Before updating, ensure that active export operations have finished and that any editing changes have been saved.

**To back up GenzoRoom, stop the container and copy the entire `data` directory from the host storage location.**

SQLite uses WAL mode, so include the associated WAL/SHM files rather than copying only `genzoroom.db`.

Continue using the same persistent storage directory when updating. Recreating the container does not remove the saved editing data as long as the host storage is preserved.

When rolling back to an earlier version, consider database schema compatibility. Restore a backup from before the update if necessary.

## Verifying the Deployment

After installation, confirm the following:

1. The GenzoRoom interface loads.
2. The Backend and Immich connection statuses are healthy.
3. Immich photos and thumbnails appear in the Gallery.
4. A JPEG photo can be opened and edited in Develop.
5. Saved editing changes are restored when reopening the photo.

The following endpoints can also be used for connection checks:

```text
http://<host-ip>:3190/api/health
http://<host-ip>:3190/api/immich/status
```

## Troubleshooting

### Cannot Connect to Immich

Verify that `IMMICH_URL` is reachable from inside the GenzoRoom container.

Also check `IMMICH_API_KEY`, its required permissions, and your Docker network configuration.

### Photos Are Not Displayed

If Immich is connected but photos are missing, verify the `asset.read`, `asset.view`, and related API permissions.

For issues with Stack Management or Export, check the corresponding `stack.*`, `asset.upload`, and `tag.*` permissions.

### Database Is Unavailable

Check the `GENZOROOM_PERSIST_ROOT` path, bind mount configuration, and directory permissions for UID/GID `10001:10001`.

For an existing installation, verify that GenzoRoom is using the intended `data/genzoroom.db` file.

### WebGPU Is Unavailable

WebGPU requires compatible GPU hardware, drivers, a supported browser, and a secure context.

It is normally available over HTTPS or localhost. Some browsers may allow WebGPU over LAN HTTP connections using developer settings.

GenzoRoom can also perform editing using CPU rendering when WebGPU is unavailable.

## Stopping and Removing GenzoRoom

To stop and remove the container:

```sh
docker compose -f compose.release.yml down
```

Data stored in the bind-mounted host directory is preserved.

To remove editing history, Export Queue entries, and other persistent data, back up anything you need and then separately delete the host storage directory.

---

For an overview of GenzoRoom's features, see the [README](../README.md).
