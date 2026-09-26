# Changelog

Meaningful user-facing changes to GenzoRoom will be documented here in English, using a simple Keep a Changelog-style structure.

Internal changes are omitted unless they affect users.

## [Unreleased]

### Added

- History rows jump directly to the selected edit state. Header and right-click row menus support compaction, clear, and deletion from the clicked row back through earlier entries; Shift+F10 is supported. Compaction, clear, and partial deletion support immediate Undo. Clear and edit initialization use localized Cancel / Continue confirmations, initially focused on Cancel, with keyboard controls; only edit initialization warns that it cannot be undone.
- A shared tab-local clipboard for all 16 JPEG recipe values, with full, selected, and single-slider Copy; full and selected Paste; and all four actions in the Viewer menu. `Ctrl+C` follows the active slider operation target (hover or focus) or copies all values from the focused Viewer; `Ctrl+V` works without slider or Viewer focus. `Ctrl+Alt+C` and `Ctrl+Alt+V` open the selection dialog. Changed Paste creates one filename-labelled, undoable History operation, preserves enabled flags, and uses the existing save path.
- Final Anshitsu exit save for every asset edited in the session, with validated History compaction, uncompressed fallback, and stay-or-exit handling for save failures.
- Five-second debounced autosave for dirty JPEG edit states, with nonblocking failure feedback and serialized saves shared with Filmstrip transitions.
- Anshitsu clears an old autosave warning after the latest edit state is confirmed saved; a successful retry of an older snapshot does not hide a newer unsaved edit.
- Anshitsu loads saved JPEG edits before editing and saves dirty photos before Filmstrip switches. Failed saves let the user stay or discard local changes and move; revision conflicts are reported without automatic merging.
- A backend SQLite edit-state store and GET/PUT API with versioned snapshot validation, optimistic revision checks, and idempotent last-save-ID retries. When a response is lost, the frontend replays the exact snapshot, expected revision, and save ID before sending newer edits; genuine revision conflicts are not merged.
- Before / After comparison in the Anshitsu viewer, including a hold-Backslash shortcut. It switches the displayed preview without changing the recipe or History.
- Separate Shadows, Midtones, and Highlights ON/OFF switches within Color Grading. Each bypasses its own Temperature and Tint while retaining both values; the parent Color Grading switch still bypasses all three. Switching is undoable.
- 3WAY Color Grading with Temperature (−100 warm to +100 cool) and Tint (−100 green to +100 magenta) for Shadows, Midtones, and Highlights. The six controls use integer steps, default to zero, and share each range's luminance weight. Category bypass, value resets, localized History, Undo/Redo, and per-photo session state are supported.
- Worker-based JPEG preview rendering with one in-flight request and only the latest pending recipe, stale-result rejection, and a main-thread fallback.
- A White Balance category above Basic with relative JPEG preview Temperature (−100 warm to +100 cool) and Tint (−100 green to +100 magenta), both step 1 and default 0. Directional gradient tracks, independent collapse and bypass, individual/category Reset, and localized History with Undo/Redo are included. Temperature and Tint use reciprocal linear-RGB gains before Exposure while preserving alpha.
- A Color category below Basic with global JPEG preview Vibrance and Saturation (−100 to +100, step 1, default 0). It has independent collapse, bypass, individual/category Reset, localized History, and Undo/Redo. After Color Grading, low-saturation-priority Vibrance runs before Saturation while preserving alpha.

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

- Initial public project documentation describing the early development status, planned direction, and provisional Docker deployment architecture.
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

- Advanced the flat in-memory recipe to version 17 with `gradingShadowsEnabled`, `gradingMidtonesEnabled`, and `gradingHighlightsEnabled`. Color Grading Reset preserves these switches; All Reset enables all three.
- Earlier recipe v15 added `highlightsTemperature`; at that stage, Color Grading Reset and All Reset included five grading values.
- Earlier recipe v16 added `highlightsTint`, completing the six grading values included in Color Grading Reset and All Reset.
- Earlier recipe v14 added `midtonesTint`; at that stage, Color Grading Reset and All Reset included four grading values.
- Increased the recent Immich photo limit from 50 to 100, including the search size and returned result cap.
- Earlier recipe v13 added `midtonesTemperature`; at that stage, Color Grading Reset and All Reset included three grading values.
- Earlier recipe v12 added `shadowsTint` alongside `colorGradingEnabled` and `shadowsTemperature`. At that stage, All Reset restored twelve values and enabled four categories; Color Grading OFF retained both Shadows values while bypassing those stages.
- Reduced JPEG preview processing work by skipping inactive luminance regions in Highlights, Whites, Shadows, and Blacks, preserving pixel output, adjustment order, and intermediate 8-bit rounding.
- Made Anshitsu adjustments single-row controls with a responsive label, slider, synchronized numeric input, optional unit, and inline per-adjustment reset; All Reset remains in the Develop controls heading.
- Removed the repeated slider keyboard instructions from the Develop panel while retaining the temporary-preview notice.
- Reorganized the Anshitsu side panels so History and EXIF remain on the left, while Scope sits above Develop controls on the right.
- Changed the project license from the MIT License to the GNU Affero General Public License v3.0 (`AGPL-3.0-only`).
- Reorganized the README around the current feature set and moved detailed deployment guidance to a dedicated document.

### Fixed

- Include all backend application modules in the production image so the backend can start with the Immich connectivity module.
