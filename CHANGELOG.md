# Changelog

Meaningful user-facing changes to GenzoRoom will be documented here in English, using a simple Keep a Changelog-style structure.

Internal changes are omitted unless they affect users.

## [Unreleased]

### Added

- Midtones Tint (−100 green to +100 magenta) after Midtones Temperature, sharing its luminance weight and the existing Tint gains, slider, category bypass, Reset, History, Undo/Redo, and Worker path.
- Midtones Temperature (−100 warm to +100 cool) in Color Grading, using the existing Temperature gains with a smooth midtone band from luminance 0.15 to 0.78. It shares the category's bypass, Reset, History, Undo/Redo, and per-asset behavior.
- A Color Grading category below Color with Shadows Temperature (−100 warm to +100 cool) and Shadows Tint (−100 green to +100 magenta), both step 1 and default 0. They use the global Temperature and Tint gain directions in linear RGB with one shared Shadows weight: full strength through luminance 0.15 and smoothly faded to zero at 0.35. Independent bypass, Reset, History, Undo/Redo, and per-asset state are included.
- A White Balance category above Basic with relative JPEG preview Temperature (−100 warm to +100 cool) and Tint (−100 green to +100 magenta), both step 1 and default 0. Directional gradient tracks, independent collapse and bypass, individual/category Reset, and localized History with Undo/Redo are included. Temperature and Tint use reciprocal linear-RGB gains before Exposure while preserving alpha.
- A Color category below Basic with global JPEG preview Saturation (−100 to +100, step 1, default 0). It has independent collapse, bypass, individual/category Reset, localized History, and Undo/Redo, and runs after Blacks while preserving alpha.
- Low-saturation-priority JPEG preview Vibrance (−100 to +100, step 1, default 0) above Saturation in Color. It uses the shared slider, Reset, History, and Undo/Redo behavior and runs between Blacks and Saturation.

- Non-destructive JPEG Exposure adjustment (−5 to +5 EV, 0.01 EV steps) in Anshitsu, with per-asset in-memory recipes and a Canvas linear-light preview pipeline. This initial version uses Immich previews as a temporary source.
- Non-destructive JPEG Contrast adjustment (−100 to +100, step 1), applied after Exposure with the shared slider, recipe, History, Undo/Redo, and reset infrastructure.
- Non-destructive JPEG Highlights adjustment (−100 to +100, step 1), using a luminance-weighted smooth highlight curve after Exposure and Contrast.
- Non-destructive JPEG Whites adjustment (−100 to +100, step 1), using a smooth luminance weight above 0.75 after Highlights.
- Non-destructive JPEG Shadows adjustment (−100 to +100, step 1), using a luminance-weighted smooth shadow curve after Whites.
- Non-destructive JPEG Blacks adjustment (−100 to +100, step 1), using a Master Black / Pedestal-style luminance offset that fades smoothly to zero at luminance 0.35 after Shadows.
- Grouped edit History, Undo/Redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y), individual adjustment resets, and undoable All Reset.
- Reusable sliders with hover/focus arrow controls: left/right change one step, up/down ten steps. Native form editing keeps its keyboard behavior.
- Adjustment slider wheel control while the pointer is over the range: each wheel event changes ten steps normally or one step with Shift, and consecutive input commits as one edit after 500 ms of inactivity.
- Independently resizable Anshitsu side panels with remembered widths, safe sizing limits, and preserved collapse/expand behavior.
- A compact Basic adjustment category in Anshitsu with non-persistent collapse, an undoable category bypass that preserves values, and an undoable category reset for all six current adjustments.

- Initial public project documentation describing the early development status, planned direction, and provisional NAS deployment architecture.
- A minimal web page showing backend connectivity, including failure feedback and a manual recheck button.
- A health endpoint and Docker Compose deployment with a configurable Web UI port (default `3190`) and same-origin API proxying.
- An authenticated Immich connectivity check, configured through backend environment variables, with connected, not configured, and failed states in the Web UI.
- An optional Compose override that connects only the backend to an existing Immich Docker network for same-host deployments.
- An initial recent-photo grid that retrieved up to 50 images from Immich and displayed proxied thumbnails without exposing the Immich API key to the browser.
- English and Japanese UI support with a remembered manual language selection.
- Locale-aware photo date and time formatting for English and Japanese.
- Image format badges on photo cards, including distinct RAW format metadata used by client-side filtering.
- Client-side RAW and Non-RAW filters for the fetched recent-photo list.
- An initial Anshitsu photo development workspace with a large preview, zoom and pan controls, collapsible side panels, selected EXIF details, and a Filmstrip foundation.
- Multi-photo selection in the recent-photo grid, with ordered selected photos sent to Anshitsu and switchable from the Filmstrip.

### Changed

- Advanced the flat in-memory recipe to version 14 with `midtonesTint`; Color Grading Reset and All Reset now include all four grading values.
- Increased the recent Immich photo limit from 50 to 100, including the search size and returned result cap.
- Advanced the flat in-memory recipe to version 13 with `midtonesTemperature`. Color Grading Reset and All Reset now include all three grading values.
- Updated flat in-memory edit recipes to version 12 with `shadowsTint` alongside `colorGradingEnabled` and `shadowsTemperature`. All Reset restores twelve values and enables all four categories; Color Grading OFF retains both Shadows values while bypassing only those stages.
- Reduced JPEG preview processing work by skipping inactive luminance regions in Highlights, Whites, Shadows, and Blacks, preserving pixel output, adjustment order, and intermediate 8-bit rounding.
- Made Anshitsu adjustments single-row controls with a responsive label, slider, synchronized numeric input, optional unit, and inline per-adjustment reset; All Reset remains in the Develop controls heading.
- Removed the repeated slider keyboard instructions from the Develop panel while retaining the temporary-preview notice.
- Reorganized the Anshitsu side panels so History and EXIF remain on the left, while Scope sits above Develop controls on the right.
- Changed the project license from the MIT License to the GNU Affero General Public License v3.0 (`AGPL-3.0-only`).
- Reorganized the README around the current feature set and moved detailed deployment guidance to a dedicated document.

### Fixed

- Include all backend application modules in the production image so the backend can start with the Immich connectivity module.
