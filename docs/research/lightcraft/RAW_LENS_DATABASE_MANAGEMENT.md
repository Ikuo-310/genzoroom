# RAW Lensfun Database Management

Phase 5 exposes LightCraft's existing Lensfun database manager in the Windows desktop without adding another download or persistence implementation.

## Native ownership and data source

LightCraft v0.18.1 owns the database lifecycle. `lens.databaseStatus` reports the active database and in-progress download; `lens.downloadDatabase` starts an explicit download into LightCraft's managed database directory. The pinned upstream Lensfun revision is `43f9e001ab66c4fcdd4f400463f13b72f94b2288`. The Native downloader fetches its fixed XML file set over HTTPS, validates each file against the pinned byte count and SHA-256, installs from a staging directory, and can restore the previous directory after a failed replacement. Lensfun data is licensed under CC BY-SA 3.0. GenzoRoom does not vendor, edit, or independently refresh this data.

On Windows, LightCraft's default database is under `%APPDATA%\LightCraft\lensfun` (subject to LightCraft's normal configuration and portable-mode rules). If `LIGHTCRAFT_LENSFUN_DIR` is configured, GenzoRoom preserves it through the child-process environment allow-list. The dialog then reports that the selected location is respected and disables its download/update action: LightCraft's managed download targets its default directory, so silently downloading a separate copy would not update the selected database.

## GenzoRoom API and UI

The desktop File menu opens the bilingual Lensfun dialog. It calls `GET /api/raw/lens-database` for status and `POST /api/raw/lens-database` for an explicit download/update through the existing managed RAW session. The Backend serializes these calls with the RAW API operation lock, validates Native response shapes, rejects duplicate starts, and returns only availability, count, safe progress fields, and whether a user directory is configured. Native absolute paths and raw error details are never returned.

Progress displays the byte counts reported by Native. Once transfer completes, the dialog indicates verification/installation while Native still reports `running`; it does not invent a percentage. Closing the dialog does not cancel the Native operation. Failed downloads leave the existing database under LightCraft's staging/rollback contract.

The database update does not rewrite already imported photo records or saved edit state. On explicit reopen of the same RAW source, the existing RAW adapter asks Native to refresh the lens profile for only that photo ID, then reads its current profile metadata. Persisted Recipe restoration occurs afterward, so existing user settings remain authoritative. No automatic all-library refresh, Recipe or History mutation, profile picker, database management screen in Web mode, Before/After behavior, or JPEG path is introduced.

## Verification boundary

GenzoRoom contract tests cover the sanitized existing RAW API, explicit-start and custom-directory guards, the reopened-photo refresh target, frontend status validation, and the desktop dialog's explicit action. The managed binary contract probe checks that the three required LightCraft commands are available. Real database download, real-camera profile matching, and visual desktop acceptance require a separate environment with network access and representative RAW files.
