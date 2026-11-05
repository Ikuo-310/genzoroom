# RAW Optics Phase 6 validation (2026-11-05)

Baseline: `8d899b67a5559f3a1c67c1967a7fb06c601135e2`, managed LightCraft v0.18.1. No production defect was reproduced. Changes are limited to focused verification and this record; no rendering algorithm, settings, geometry, Native patch, or Before/After contract was changed.

## Results and boundaries

| Item | Result | Evidence / boundary |
| --- | --- | --- |
| Whole Optics settings and regeneration | PASS | Existing Backend adapter/Optics History tests and Frontend document tests cover readback, revisions and superseded image rejection. Actual Native synthetic DNG renders all 13 cases below. |
| Region revision and Geometry ownership | PASS | Existing Region delivery/auto/overlay tests cover stale replies, mutation invalidation, zoom/pan and Draft/Full transitions. Actual Native Whole and Region geometry IDs and dimensions agree in all cases. |
| Saved Optics settings in Export | PASS | Added Queue/runtime test checks nondefault Optics and Straighten settings reach the exporter unchanged, remain frozen after a concurrent Recipe save, and the artifact reaches the Registrar. Existing Retry/Recovery tests check fresh retry and frozen recovery Recipes. |
| Actual JPEG generation | PASS | Native produces valid full-resolution JPEGs matching the output frame dimensions, preserving settings before/after rendering and export. This is functional consistency, not JPEG byte/pixel equality with Preview. |
| History, Undo/Redo, Reset, Recipe | PASS | Existing Optics tests exercise all 13 numeric controls and two flags, section operations and session restoration. Native probe checks Reset and exact settings readback after restore. |
| Crop/Straighten | PASS | Synthetic Native cases include constrained output, manual Crop, angle, orientation and flips. Existing Backend HTTP test now uses the current managed executable and passes actual Native History/reload/Preview checks. |
| Pixel embedded profile: OFF, 0/100 distortion and vignetting | NOT VERIFIED | No identified real Pixel DNG was available in the inspected repository fixtures. Synthetic DNG has no embedded lens profile; its profile flag/amount readbacks do not prove an embedded correction's visual effect. |
| PENTAX K-S2 manual correction and profile unknown | PARTIAL | Synthetic profile-less RAW confirms manual distortion/vignetting and CA/defringe paths. Manual desktop acceptance on the actual K-S2 DNG is recorded below. LightCraft official also fails to identify its lens; exact extraction cause remains unresolved upstream. |
| Real Desktop appearance and Immich registration | NOT VERIFIED | Registrar invocation is tested with mock; no live Immich write or browser/Desktop visual test was performed. |

## Actual Native probe

Command: `.venv/Scripts/python.exe native/lightcraft/optics_crop_probe.py .tmp/lightcraft-0.18.1/target-lens-profile-info/release/lightcraft-cli.exe`.

CPU and DX12 both passed 13 cases: plain, Crop, manual distortion, distortion+Crop, lateral CA, Straighten, rotate/flip, auto CA flag, profile OFF, profile amounts 0, profile amounts 100, manual vignetting+Straighten, defringe+blue CA+Straighten. Every case checks Draft/Full geometry, Whole/Region geometry and dimensions, settings preservation, JPEG dimensions, Recipe readback/restore and Reset. The preexisting probe also compares same-scale Whole/Region pixels with its existing tolerance; no new pixel-matching system or Preview/Export pixel equality was introduced. On profile-less synthetic data, profile controls and automatic CA may have no visible effect; only their contracts and successful rendering are established.

The actual binary SHA-256 remains `1a2006fe083eeb15ff7dc7d054183cf5405c68cdca66c7a7bdc154d745871a3c`, matching its existing receipt. No Native rebuild or receipt update is needed because Native source and patches are unchanged.

## Code review and focused regression

`useRawDocument.ts` fences image publication by current document/revision and display generation. `rawRegionAuto.ts` requires the current Whole revision/token and includes revision, Geometry ID and dimensions in its intent key; delivery and overlay validate ownership before adoption. Optics uses the same settings acknowledgment/invalidation path as other RAW controls. `raw_export_artifact.py` freezes the supplied settings, applies them to an isolated Native session, and requires full readback equality before and after export. Queue snapshots retain the full Recipe including Optics and Crop.

Backend selection: `test_lightcraft_raw`, `test_raw_region`, `test_raw_region_delivery`, `test_raw_optics_history`, `test_raw_geometry`, `test_raw_recipe_restore`, `test_raw_export_runtime`, `test_raw_export_artifact`, `test_export_retry_identity`, `test_export_recovery`: 343 unique tests. Initial run: 341 passed, two verification failures. After the test fixes below, focused rerun of the actual Native geometry test and Export runtime suite: 16 passed, closing both failures. Successful results on unchanged code were retained.

Frontend selection: `useRawDocument`, `rawRegionAuto`, `rawRegionDelivery`, `rawRegionOverlay`, `rawRecipeSave`, `rawApi`: 339 passed across six files. TypeScript, production build and `git diff --check` passed. Existing large-chunk and React Router directive build warnings remain. No full Frontend suite was run.

## Findings and remaining acceptance

- High: none identified within the tested scope.
- Medium: none identified within the tested scope.
- Low: the existing actual Native geometry test hard-coded `target-managed`, whose artifact failed the current receipt gate. It now uses the existing managed executable resolver. This was a test-selection defect; production resolution was already correct.
- The new Export test initially omitted the required import-default fingerprint and was rejected as ineligible. Supplying the existing store contract fixed the fixture; no eligibility behavior changed.

## Subsequent Desktop observations

These are manual observations after the automated Phase 6 run above; they do not change its fixture scope, test counts or PASS/NOT VERIFIED results.

- Lensfun manager opened from the Windows File menu, downloaded and installed the database, and displayed 1,568 lenses. Native recognized the database. A successful match to a real lens profile was not confirmed.
- On a PENTAX K-S2 DNG taken with `HD PENTAX-DA 55-300mm F4.5-6.3 ED PLM WR RE`, Immich displayed the lens name, while GenzoRoom could not retrieve it. LightCraft official displayed “This file has no lens name”; the Lensfun database contains an entry for the lens. This suggests the upstream inability to retrieve the name from this DNG prevents profile matching, but the precise cause (including any MakerNote parsing issue) is unconfirmed. No GenzoRoom-specific extraction was added.
- LightCraft official recognized the embedded profile in a Pixel DNG. Visually, correction OFF and ON with distortion amount 0 showed no composition change. Amount 100 changed composition/geometry and appeared to worsen straight lines compared with the paired JPEG and a sign. This is an upstream investigation candidate only; direction or coordinate-transform error is not established. The automated Native probe did not use a real Pixel DNG, so its NOT VERIFIED result above remains.
- After the Frontend Geometry constraint fix at commit `35f5d740a1a2c7cf07169ed0c2fa3b65ea99a9d3`, the Desktop successfully switched to Before with lens correction OFF. Before itself also showed lens correction, matching the observed LightCraft official behavior. This confirms switching success only; all aspect-ratio, Fit, Zoom/Pan and Region combinations were not exhaustively checked.

Still unverified: Pixel embedded-profile distortion validity, exact K-S2 name-extraction cause, successful real Lensfun profile matching, visual comparison of a real Pixel DNG across all GenzoRoom paths, live Immich Export/registration with Optics, and exhaustive Desktop Fit/Zoom/Pan combinations. The planned implementation and limited verification are closed; closure does not mean these open observations were resolved. Before/After fixes continue to require matching geometry only for shared Region processing, not independent Whole switching.
