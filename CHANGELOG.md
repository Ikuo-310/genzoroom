# Changelog

Meaningful user-facing changes to GenzoRoom will be documented here in English, using a simple Keep a Changelog-style structure.

Internal changes are omitted unless they affect users.

## [Unreleased]

### Added

- Added Structured Logs to Developer Diagnostics, with separate Frontend and Backend level controls, combined or source-specific views, clear, refresh, and JSON export.
- Added an Immich STACK management workspace for detecting RAW / JPEG candidates, editing existing and manual Stacks, choosing Covers, adding or purging members, and moving photos with desktop Drag & Drop. Dropping one unmatched photo onto another creates a manual Stack; `Primary+Z` undoes one local draft edit, and the empty unmatched drop target is larger for easier Purge. Confirmed drafts can be written back to Immich.

- Added an opt-in Developer Diagnostics page with WebGPU capability and synthetic smoke diagnostics, Real JPEG CPU/GPU/Histogram measurements, and Full, JPEG-only, and WebGPU-only JSON reports.

- Home browsing tabs for Albums, Calendar, and Favorites alongside Recent. Calendar includes year, month, and date views; Favorites lists favorited Timeline images.
- Independent per-tab RAW / Non-RAW and edited / unedited photo filters, adjustable Home thumbnail sizing, and ordered multi-photo selection with Shift+click ranges.
- Home browsing-state and per-view scroll restoration when switching tabs and returning from Anshitsu.
- Keyboard navigation: Home `D` opens the current selection or resumes the last Anshitsu workspace in the same SPA session; Anshitsu `H` returns Home, `F` toggles Viewer-only focus mode, and `Shift+Z` (⇧+Z on macOS) switches between Fit and the previous zoom/pan. Filmstrip photos move with the platform's Primary+Shift+←/→ (Ctrl+Shift on Windows/Linux, ⌘+⇧ on macOS); relevant shortcuts remain available while focus mode hides their controls. Shortcut explanations appear in applicable Tooltips and Menus, with a Settings option to hide those explanations while keeping the shortcuts active. Platform labels use Ctrl / Alt / Shift on Windows/Linux and ⌘ / ⌥ / ⇧ on macOS.
- A shared Settings dialog from Home and Anshitsu for browser-saved display language, independent date and time locale, calendar week start, WebGPU preference, initial Preview / Original choice, and keyboard-shortcut explanation visibility. Auto language follows browser preference with English fallback; Auto image choice prefers the JPEG original when WebGPU is enabled and available, switching from Preview when the original finishes loading unless the user has chosen a source manually. Settings also displays Immich server version and available build information.
- Optional WebGPU image processing for JPEG previews and originals in Anshitsu, with a remembered GPU ON/OFF preference and automatic CPU fallback when GPU processing is unavailable or fails.
- Anshitsu can acquire the selected JPEG original through the backend and switch between Preview and Original. Home and Filmstrip retain thumbnail browsing; both viewer sources share the current edits, and Original Info reports embedded profile details.
- Preview / Original and Before / After controls, with `]` for source switching and held Backslash for temporary Before. JIS `]` key events take priority over the Backslash comparison shortcut. History and Develop panel toggles now use directional icon buttons with localized tooltips.
- An RGB / Y′ Histogram Scope for JPEG previews, with per-channel visibility, Y Only, Normal shared-maximum and Expanded P99 scales, and synchronization with the Viewer’s persistent and temporary Before / After display. Numpad 0–3 and Numpad Decimal control the display.
- Recipe v18 adds independent ON/OFF switches for all 16 numeric adjustments alongside the four category and three Color Grading range switches. Disabled values remain stored; reset, History, and processing respect each switch level.
- Home Shift+click range selection, edited markers in Home and Filmstrip, connection details, and the shared GenzoRoom Home navigation are available. UI improvements add independent edit-panel scrolling and focus navigation, category/adjustment/3WAY range switches and context menus (including reset and numeric Copy/Paste), and Viewer Before / After operations.
- `POST /assets/edit-status` returns persisted edit status for up to 100 asset IDs in one request, supporting distinct unknown, unedited, and edited UI states.
- History rows jump directly to the selected edit state. Header and right-click row menus support compaction, clear, and deletion from the clicked row back through earlier entries; Shift+F10 is supported. Compaction, clear, and partial deletion support immediate Undo. Clear and edit initialization use localized Cancel / Continue confirmations, initially focused on Cancel, with keyboard controls; only edit initialization warns that it cannot be undone.
- A shared tab-local clipboard for all 16 JPEG recipe values, with full, selected, and single-slider Copy; full and selected Paste; and all four actions in the Viewer menu. `Primary+C` follows the active slider operation target (hover or focus) or copies all values from the focused Viewer; `Primary+V` works without slider or Viewer focus. `Primary+Alternate+C` and `Primary+Alternate+V` open the selection dialog. Changed Paste creates one filename-labelled, undoable History operation, preserves enabled flags, and uses the existing save path.
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
- Grouped edit History, Undo/Redo (`Primary+Z`, `Primary+Shift+Z`, `Primary+Y`), individual adjustment resets, and undoable All Reset.
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

- Home photo lists exclude Immich trash assets and show only the primary photo for each valid Immich Stack. Incomplete or ambiguous Stack metadata is quarantined from Home without relaxing strict Stack management validation. Singleton Stacks are visibly abnormal and can only be removed through the normal confirmed delete workflow.
- Home photo views can filter stacked versus unstacked cards; valid Stack cards carry member-count metadata. STACK management uses the same Immich API key and requires Stack read/write permissions.
- Recent photo count can be selected from 50 to 500 in steps of 50, with 100 as the default. Japanese Album periods use compact `YYYY/MM` labels.
- Extended the desktop right panel to the bottom edge while placing the Filmstrip below only the left panel and Viewer. The Scope selector now sits in its heading, and its height can be resized from 15% to 40% (30% by default) and remembered by the browser; the mobile stacked layout is retained.
- Advanced the flat recipe to version 18 with `adjustmentEnabled` flags for all sixteen numeric adjustments; Recipe v17 remains readable and migrates to v18. The recipe version is independent of edit-state snapshot format v2 and SQLite schema v1.
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

- Prevented incomplete Immich Stack snapshots from failing Home photo lists or exposing surviving Stack children as ordinary photos; Recent continues paging as needed after excluded entries.
- Long-running Stack sends use a dedicated proxy timeout; a response from a previous Stack selection cannot change a new draft; long filename candidates remain writable; and re-detection supports selections over 1,000 assets.
- Prevent Undo/Redo shortcuts from changing the background edit session while save-failure dialogs are open.
- Keep NumLock-off Histogram keypad shortcuts from being consumed as adjustment-slider arrow controls while preserving native numeric input.
- Preserve the exact snapshot, expected revision, and save ID for retries when a PUT may have committed but its response is uncertain, including HTTP 408/5xx and unreadable or invalid success responses. Genuine 409 conflicts are not automatically merged.
- Keep the known saved edited state visible after discarding newer unsaved edits; invalidate an old batch status when the persisted state is unknown.
- Prevent global workspace shortcuts from running while the Viewer `⋯` menu is open, restore trigger focus on Escape, and clear stale 3WAY heading focus after real pointer movement to another slider.
- Treat non-finite optional EXIF integers as missing values so malformed ISO, width, or height metadata does not fail the entire asset detail response.
- Include all backend application modules in the production image so the backend can start with the Immich connectivity module.
