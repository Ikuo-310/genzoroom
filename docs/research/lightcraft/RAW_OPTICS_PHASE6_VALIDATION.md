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
| PENTAX K-S2 manual correction and profile unknown | PARTIAL | Synthetic profile-less RAW confirms manual distortion/vignetting and CA/defringe paths. Actual K-S2 metadata and appearance require Desktop acceptance. The user reports missing lens identification in official LightCraft too; this is not a new GenzoRoom defect. |
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

User-reported official LightCraft Pixel distortion at profile amount 100 remains an upstream investigation item. This run did not independently reproduce or change it. Desktop acceptance still needs Pixel embedded-profile OFF/0/100 and vignetting 0/100 across Whole/zoomed Region/Export, real K-S2 manual controls, and visual composition/direction checks against official LightCraft. Phase 5's user-confirmed 1,568 Lensfun entries and manager behavior are prior manual evidence, not rerun here. Before/After geometry mismatch remains deferred exactly as requested.
