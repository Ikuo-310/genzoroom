# RAW lens profile information contract

## Scope

Phase 3 exposes read-only camera, lens and selected correction profile information for the currently open RAW photo. It uses the existing RAW settings response and the existing LightCraft session; it adds no user interface, profile picker, Lensfun download, Recipe field, History operation or database schema.

Managed LightCraft remains v0.18.1 at upstream commit `57024f072c234e0c6c850e0940a261790f976575`. The added patch is [`0003-v0.18.1-lens-profile-info.patch`](../../../../native/lightcraft/patches/0003-v0.18.1-lens-profile-info.patch), SHA-256 `61dc7e48a297bd3b8d7fd24873e692c5579d399bcc1cac1d6ba93f8b9fe5de0b`. It adds the read-only `photo.lensProfileInfo` command and no correction algorithm or profile-selection behavior. The manifest and binary receipt identify independent `lensProfileInfoContract:1`.

## Native source facts and public mapping

LightCraft's `lightcraft_meta::extract` supplies optional EXIF/XMP camera make/model and lens make/model. v0.18.1 has no normalized lens ID, so `lensId` is null. The imported catalog photo's `embedded_lens` is the actual correction selected by LightCraft: file-embedded corrections have source `file`; `lens_profiles::for_raw` uses the existing Lensfun lookup only when file correction is absent, and that result has source `database`.

| Public field | Source / rule |
|---|---|
| `cameraMake`, `cameraModel`, `lensMake`, `lensModel` | Exact optional metadata values; no heuristic completion; each is null when absent or over 512 UTF-8 bytes. |
| `lensId` | Null; LightCraft exposes no normalized ID. |
| `profileAvailable` | True when Native selected an embedded correction. False when a usable Lensfun database and identifying lens/focal metadata exist but no correction was selected. Null when Native cannot distinguish missing profile from insufficient data or an unavailable database. |
| `profileSource` | `file` / `database` for a selected correction; `none` for a known no-correction result; `unknown` otherwise. |
| `profileName` | Lensfun name from the already loaded database only when a database correction was selected and matched. File corrections do not have a synthesized name. |
| `profileApplied` | Backend-derived per settings response; see below. |

The public response is `RawSettings.lensProfileInfo`; the two Native component-presence booleans are internal to the Backend. RAW import continues if this optional read fails or is malformed, exposing null metadata and unknown availability instead. No database is downloaded. A manually installed database continues to be used by LightCraft through its existing lookup.

## Applied state and persistence boundary

`_Photo` owns the immutable camera/lens/profile metadata for its photo and Native photo ID. `DevelopSnapshot` carries that data for the existing readback path. It is not added to serialized DevelopSettings, Recipe, History snapshots, or Copy/Paste values, so another photo cannot inherit the first photo's profile identity.

For each settings/history readback, the Backend reports `profileApplied:false` when the Optics section is disabled, `lens_profile` is false, no profile is known available, or all selected profile components have a zero amount. When profile correction is enabled but availability is unknown, it reports null. It reports true only when Native selected distortion or vignetting data and the matching amount is nonzero. The static photo fields remain fixed across edits, Undo/Redo/Jump and Recipe restoration; only this derived state follows the current settings.

## Limits and evidence

- Native MCP test target: 87 passed, 1 ignored. Lens profile database lookup target: 6 passed. WB pipeline regression targets: 9 passed. The existing synthetic LensDb tests cover profile lookup/name, no-match and selection behavior.
- Backend focused settings, RAW History, session and artifact/patch-manifest tests: 178 passed. Frontend RAW API validation tests: 124 passed; TypeScript check and production build passed.
- The actual managed binary was built into the isolated `target-lens-profile-info` directory. CPU and DX12/GPU, Whole, Region, WB, Crop and the new Lens Profile Info probe passed. The new binary probe imports a metadata-free PNG and verifies the unknown/null shape and exact response keys.
- The binary SHA-256 is `1a2006fe083eeb15ff7dc7d054183cf5405c68cdca66c7a7bdc154d745871a3c`; the adjacent receipt includes upstream commit, both managed patch digests/targets, existing contracts and `lensProfileInfoContract:1`.
- No real camera RAW or production Lensfun database fixture was available for the actual binary probe. The file-correction and Lensfun matching paths are covered by LightCraft's synthetic source tests, not by a real-camera RAW. Real EXIF/XMP variation and real database population remain unverified.

This contract prepares read-only data for a later UI phase. It does not specify or implement a UI.
