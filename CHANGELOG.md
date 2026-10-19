# Changelog

Meaningful user-facing changes to GenzoRoom will be documented here in English, using a simple Keep a Changelog-style structure.

Internal changes are omitted unless they affect users.

## [Unreleased]

### Fixed

- Windows PoC Developer Diagnostics now offers a save destination for JSON reports, supports consecutive exports, and reports save failures while treating cancellation normally.
- Windows PoC now opens connection recovery Settings when its selected local database cannot be opened at startup, retaining the saved credentials and profile data.
- Windows PoC now exits safely when its initial UI cannot become ready, correlates close failures to their request, confirms before closing during a page reload, and blocks a second Tauri host while an older WebView remains open.
- Windows diagnostic Settings now displays the active environment-based Immich target instead of a different saved connection.

### Changed

- Windows desktop now has a bilingual per-user NSIS installer with app shortcuts, bundled Backend and WebView2 setup, and prompts users to close GenzoRoom before installing or uninstalling. Choosing uninstall from the same-version setup flow exits the installer after removal succeeds.

## [0.2.2] - 2026-10-17

### Added

- Anshitsu Filmstrip now scrolls horizontally with vertical mouse-wheel input: up moves left, down moves right, and scrolling stops at either end. Native horizontal touchpad scrolling remains available.
- Anshitsu Immersive Preview now moves between photos with unmodified Left / Right arrows. Normal darkroom slider arrows and Primary+Shift photo navigation remain available.

### Changed

- Standardized JPEG Temperature correction in White Balance and 3WAY Color Grading: negative values cool toward blue, zero is neutral, and positive values warm toward red. The shared slider gradient runs from cool blue through neutral to warm red/orange. This remains a relative adjustment, not an absolute Kelvin temperature.
- Increased the Anshitsu Filmstrip height by 10px to give thumbnails more vertical viewing area; thumbnail width is unchanged.
- Replaced the arrow-only back buttons in Calendar date and Album detail views with localized text buttons: “カレンダーに戻る” / “Back to Calendar” and “アルバム一覧に戻る” / “Back to Albums”. Their existing return behavior remains unchanged.
- Unified the Anshitsu Filmstrip and Stack management X icons as centered 14px SVGs, improving their alignment and visibility.

### Fixed

- Anshitsu Filmstrip now preserves manual browsing position during unrelated state updates and follows the active photo only after a photo switch or an actual Recipe change.

## [0.2.1] - 2026-10-14

### Changed

- Expanded X exclusion Debug logs to distinguish Backend configuration from Frontend confirmation and identify unconfirmed targets.

### Fixed

- Fixed stale Gallery Stack ownership after Stack writes, which could show X exclusion status warnings or block re-entry to Stack management from Calendar.
- Refresh Gallery views after Stack writes so cached photo membership is updated across Recent, Favorites, Albums, and Calendar.

## [0.2.0] - 2026-10-13

### Added

- Added persistent Gallery development exclusions for standalone photos and whole Stacks, toggled with `X`; excluded thumbnails and filenames are dimmed, and existing Queue entries are removed before exclusion is saved.
- Added protection that keeps excluded or unconfirmed photos out of Anshitsu, Stack management, Queue additions, and Immersive Preview.
- Added Immersive Preview to Gallery, Export management, and Stack management, with browsing based on the visible photo list, selected photos, or Stack candidate group.
- Added bounded photo navigation and context-specific selection, Queue, and export-readiness controls to Immersive Preview.

### Changed

- Changed Anshitsu's Viewer focus-mode shortcut from `F` to `V`; the Favorites tab remains on `F`.
- Stack management's Edited Preview setting now also controls whether Immersive Preview prefers a rendered thumbnail or uses the Immich preview directly.

### Fixed

- Fixed unrelated standalone photos becoming unavailable for exclusion when trashed Immich Stack members made the Stack snapshot incomplete.
- Fixed exclusion and session re-entry inconsistencies when Stack membership changed or a retained session was reused.
- Fixed stale rendered thumbnails in Export management when reopening the tab by refreshing their image URLs on each entry.
- Prevented application shortcuts behind Immersive Preview from changing controls such as thumbnail size.
- Restored the 「現」 badge for GenzoRoom exports opened from Export management.
- Prevented deferred photo clicks from changing selection after Settings opens or the screen becomes inactive.
- Kept the filename centered in narrow Immersive Preview windows.

## [0.1.4] - 2026-10-12

### Added

- Added saved-Recipe JPEG thumbnail previews to Gallery photo lists, the Develop filmstrip, and Export Management, so you can review corrections before export without changing the source photo.
- Added an Edited preview toggle and `\` (Backslash) shortcut in Stack Management to switch between rendered thumbnails and Immich thumbnails.
- Returning to Gallery after sending Stack changes to Immich now automatically reloads the currently displayed photo view.
- Added blank-area selection clearing to Gallery photo lists, Export Management, and the Unmatched area in Stack Management. Photo cards and their usual controls continue to work normally.

## [0.1.3] - 2026-10-11

### Changed

- Made the Settings dialog more compact, grouped connection details by GenzoRoom and Immich, and unified the WebGPU ON/OFF switch and status display.

### Fixed

- Export management no longer fails as a whole when Immich cannot provide details for queued photos. Only available photos are shown and can be managed, so unavailable failed photos do not block exports of available photos. Queue records remain intact, and photos reappear with their original Queue state when details become available after re-entering the tab.
- Fixed Export for JPEG images recognized as MPO by using the first frame.

## [0.1.2] - 2026-10-11

### Added

- Added a Gallery Toolbar `Reload` button and `Shift+R` shortcut to refresh the current Recent, Albums, Calendar, or Favorites view from Immich while preserving its Gallery context without a full browser reload.

## [0.1.1] - 2026-10-11

### Changed

- GenzoRoom's frontend container and nginx listen port now use `3190` instead of `8080`, matching the existing default host port. Official Compose deployments therefore use `3190:3190`; users with custom v0.1.0 mappings targeting container port `8080` must update the target to `3190`.

## [0.1.0] - 2026-10-10

### Added

- Immich-connected photo browsing with Recent, Albums, Calendar, Favorites, and tools for organizing capture Stacks.
- Non-destructive JPEG development in Anshitsu, with saved Recipes, edit History, Undo/Redo, and optional WebGPU acceleration with CPU fallback.
- A persistent Export Queue that creates developed JPEGs in Immich, applies the GenzoRoom tag, and preserves the source Stack relationship.
- SQLite-backed persistence for edit state, History, Export Queue, and Export Runtime across container restarts.
- A single-container GHCR distribution for Linux `amd64`, alongside the two-container source-build setup used for development.

## [Development history before v0.1.0]

### Added

- Anshitsu Filmstrip photos can be temporarily excluded with the top-left × button or `X`, then restored once with `Primary+Z`. Exclusion confirms saved edits and preserves photos, Recipe, and History.
- STACK management can reserve existing non-COVER, non-RAW members for Immich's normal trash through a right-click menu, cancel reservations, and undo one local edit. Confirmed Send applies reservations alongside Stack changes without permanently deleting photos. Newly added or moved-in photos remain outside trash eligibility.
- Home's tab bar now includes STACK management between the four browsing tabs and Export management. STACK candidates and unmatched photos appear in independently scrolling upper and lower frames; drag the separator to adjust the initial 2:1 split from 1:1 to 4:1. The lower frame accepts Stack-member removal drops, and Stack filenames use Gallery's middle-ellipsis display.
- STACK editing drafts and Undo remain available when switching Home tabs or visiting Anshitsu during the same SPA session. `S` opens the STACK tab with or without a Gallery selection; no selection resumes the previous session or shows an empty first session.
- Gallery Stack Cover cards in Recent, Albums, Calendar, and Favorites can open all selected Stack assets in Anshitsu. Initial selection prefers every unexported Non-RAW asset and falls back to every unexported RAW asset; format badges toggle all eligible assets of that format, and the Stack context menu supports individual Anshitsu selection and per-asset Export Queue changes. Manual selections are shared across Gallery tabs for the browser session, and exported or inconsistent Stack candidates are handled safely.
- Home silently repairs a missing GenzoRoom tag on eligible non-Cover assets in Immich Stacks as well as their representative assets.
- Stack context-menu Queue actions handle unavailable edit-state and Queue information safely, preserve canonical Queue state, and keep the menu positioned and keyboard focus usable as its contents change.
- Home Stack cards show the unique image formats in each Stack, with the Cover format first, alongside the member count. Home and Export cards preserve filename endings through shared middle-ellipsis display. Home marks GenzoRoom-tagged exports with a 「現」 badge and silently restores a missing tag on verified GenzoRoom JPEGs during browsing.
- The shared thumbnail-size controller supports Numpad `-` / `+` on Gallery/Home, Export management, and STACK management. Shortcut hints appear in its button tooltips when shortcut explanations are enabled.

Earlier Phase 5 foundation entries below describe their completion state; production Export is enabled by the Phase 5E integration and current Retry UI described first.

- Exported JPEGs now inherit the Immich Favorite state of their source photos.

- Enabled confirmed Export to Immich for ready Queue items, with full-resolution JPEG upload, GenzoRoom tagging, source Stack membership preservation, and the generated output as Cover. Interrupted registration reuses duplicate uploads where possible; Cancel confirms stopping after the current export. Live NAS/Immich integration verification remains Phase 5F.

- Export's primary action now retries all failed Queue items in order and starts them together after confirmation; ordinary ready items remain a separate confirmed Export flow. During Retry, unrelated queued items retain their readiness for later but are not shown, selectable, or removable as Retry targets. Stop-requested status appears only on later waiting items, while the current item keeps its active status.

- Added Export Runtime Stop-after-current, atomic failed-item Retry preparation and restart recovery, with waiting/activity/failure status bars and Retry/Cancel UI foundations. Production Export to Immich remains disabled until actual family lookup and upload/registration/tag/Stack/COVER integration are connected.

- Added the internal backend Export Runtime foundation with persistent ordered runs, frozen Recipe snapshots, serial processing and owned Queue transitions. Actual Immich registration and the production Export start action remain unavailable.
- Added the Home Export management tab (`E`) with Queue photo cards, grouping of queued members from the same Immich Stack, shared thumbnail sizing, and card selection. Cards show Immich source thumbnails, not Recipe-rendered export previews. `W` marks selected photos ready to export independently of selection; `Q` removes them from Queue, retaining successful removals after partial failures. `Primary+Z` undoes the latest W or Q operation once. Ready cards show a full-width, 28px status bar at the thumbnail's bottom edge.
- Added persistent Export Queue controls to Home and Anshitsu. Edited photos can be queued from Home; a Stack badge is ON when any member is queued and can add edited members or remove all queued members. `Q` toggles Queue membership for eligible Home selections. Dirty Anshitsu edits are saved before enqueue, and saving a default Recipe removes that asset's queued/failed intent while preserving active work.
- Home marks a photo as edited only when its current Recipe is non-default. Retained History has a separate indicator in the Anshitsu Filmstrip.
- Added the backend JPEG processing foundation with Recipe v18 compatibility, full-resolution sRGB output, and quality 95 / 4:4:4 encoding. Artifact preparation now assigns family-based `GenzoNN` filenames, preserves supported capture/GPS/user metadata, and regenerates output dimensions, orientation, timestamps and GenzoRoom identification while excluding private camera and auxiliary source metadata. Production Export execution and Immich upload/registration remain unavailable; the Export to Immich action remains disabled.
- Added Structured Logs to Developer Diagnostics, with separate Frontend and Backend level controls, combined or source-specific views, clear, refresh, and JSON export.
- Added Immich STACK management for detecting RAW / JPEG candidates, editing existing and manual Stacks, choosing Covers, adding or purging members, and moving photos with desktop Drag & Drop. Dropping one unmatched photo onto another creates a manual Stack; `Primary+Z` undoes one local draft edit. Confirmed drafts can be written back to Immich.

- Added an opt-in Developer Diagnostics page with WebGPU capability and synthetic smoke diagnostics, Real JPEG CPU/GPU/Histogram measurements, and Full, JPEG-only, and WebGPU-only JSON reports.

- Home browsing tabs for Albums, Calendar, and Favorites alongside Recent. Calendar includes year, month, and date views; Favorites lists favorited Timeline images.
- Calendar date details can move directly to the previous or next day containing photos with toolbar arrows or ArrowLeft / ArrowRight; days without photos are skipped.
- Home keyboard commands for `R` / `A` / `C` / `F` tab navigation, `S` for STACK management, `D` for Anshitsu, and `Primary+A` to select visible photos in photo views.
- Shift+click to start selection with one photo, then extend an anchored range; Select All adds visible photos while preserving hidden selections and selection order.
- Independent per-tab RAW / Non-RAW and edited / unedited photo filters, adjustable Home thumbnail sizing, and ordered multi-photo selection with Shift+click ranges.
- Home browsing-state and per-view scroll restoration when switching tabs and returning from Anshitsu or STACK management.
- Keyboard navigation: Home `D` opens the current selection or resumes the last Anshitsu workspace in the same SPA session; unmodified `G` returns from Anshitsu to Gallery/Home. STACK management is a Home tab and is not exited with `G`; `D` and its button are unavailable while that tab is active. Anshitsu `F` toggles Viewer-only focus mode, and `Shift+Z` (⇧+Z on macOS) switches between Fit and the previous zoom/pan. Filmstrip photos move with the platform's Primary+Shift+←/→ (Ctrl+Shift on Windows/Linux, ⌘+⇧ on macOS); relevant shortcuts remain available while focus mode hides their controls. Shortcut explanations appear in applicable Tooltips and Menus, with a Settings option to hide those explanations while keeping the shortcuts active. Platform labels use Ctrl / Alt / Shift on Windows/Linux and ⌘ / ⌥ / ⇧ on macOS.
- A shared Settings dialog from Home and Anshitsu for browser-saved display language, independent date and time locale, calendar week start, WebGPU preference, initial Preview / Original choice, and keyboard-shortcut explanation visibility. Auto language follows browser preference with English fallback; Auto image choice prefers the JPEG original when WebGPU is enabled and available, switching from Preview when the original finishes loading unless the user has chosen a source manually. Settings also displays Immich server version and available build information.
- Optional WebGPU image processing for JPEG previews and originals in Anshitsu, with a remembered GPU ON/OFF preference and automatic CPU fallback when GPU processing is unavailable or fails.
- Anshitsu can acquire the selected JPEG original through the backend and switch between Preview and Original. Home and Filmstrip retain thumbnail browsing; both viewer sources share the current edits, and Original Info reports embedded profile details.
- Preview / Original and Before / After controls, with `]` for source switching and held Backslash for temporary Before. JIS `]` key events take priority over the Backslash comparison shortcut. History and Develop panel toggles now use directional icon buttons with localized tooltips.
- An RGB / Y′ Histogram Scope for JPEG previews, with per-channel visibility, Y Only, Normal shared-maximum and Expanded P99 scales, and synchronization with the Viewer’s persistent and temporary Before / After display. Numpad 0–3 and Numpad Decimal control the display.
- Recipe v18 adds independent ON/OFF switches for all 16 numeric adjustments alongside the four category and three Color Grading range switches. Disabled values remain stored; reset, History, and processing respect each switch level.
- Home Shift+click range selection, edited markers in Home and Filmstrip, connection details, and the shared GenzoRoom Home navigation are available. UI improvements add independent edit-panel scrolling and focus navigation, category/adjustment/3WAY range switches and context menus (including reset and numeric Copy/Paste), and Viewer Before / After operations.
- A desktop-oriented neutral dark Home shell with fixed Header, Tabs, and Toolbar regions, a scrolling content region, compact selection controls on photo views, and responsive Album / Calendar detail controls.
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
- 3WAY Color Grading with Temperature and Tint for Shadows, Midtones, and Highlights. The six controls use integer steps, default to zero, and share each range's luminance weight. Category bypass, value resets, localized History, Undo/Redo, and per-photo session state are supported.
- Worker-based JPEG preview rendering with one in-flight request and only the latest pending recipe, stale-result rejection, and a main-thread fallback.
- A White Balance category above Basic with relative JPEG preview Temperature and Tint, both step 1 and default 0. Directional gradient tracks, independent collapse and bypass, individual/category Reset, and localized History with Undo/Redo are included. Temperature and Tint use reciprocal linear-RGB gains before Exposure while preserving alpha.
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

- The STACK management send button now uses the Export Immich action color. STACK candidate and unmatched photo cards use Gallery's shared middle-ellipsis filename display.
- Refreshed Home to a neutral dark four-region desktop layout, sharing the basic theme with STACK management while retaining green status colors and Developer Diagnostics' console theme.
- Integrated photo selection and Album / Calendar view controls into the Home Toolbar; compact English action labels and optional shortcut suffixes keep the controls concise.
- Changed Gallery return from `H` to unmodified `G` in Anshitsu. STACK management now returns to Gallery through Home tab navigation.
- Home shortcut hints use compact `[X]` suffixes when enabled in Settings; hiding hints leaves the shortcuts active.
- ArrowLeft / ArrowRight move backward / forward through Calendar months, years, and photo days. Home tabs no longer switch with ArrowLeft / ArrowRight / Home / End; click and the existing direct tab commands remain available.

- Home photo lists exclude Immich trash assets and show only the primary photo for each valid Immich Stack. Incomplete or ambiguous Stack metadata is quarantined from Home without relaxing strict Stack management validation. Singleton Stacks are visibly abnormal and can only be removed through the normal confirmed delete workflow.
- Home photo views can filter stacked versus unstacked cards; valid Stack cards carry member-count metadata. STACK management uses the same Immich API key and requires Stack read/write permissions.
- Recent photo count can be selected from 50 to 500 in steps of 50, with 100 as the default. Japanese Album periods use compact `YYYY/MM` labels.
- Extended the desktop right panel to the bottom edge while placing the Filmstrip below only the left panel and Viewer. The Scope selector now sits in its heading, and its height can be resized from 15% to 40% (30% by default) and remembered by the browser; the mobile stacked layout is retained.
- Advanced the flat recipe to version 18 with `adjustmentEnabled` flags for all sixteen numeric adjustments; Recipe v17 remains readable and migrates to v18. The recipe version is independent of edit-state snapshot format v2 and SQLite schema v2.
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

- STACK trash protects both the original and current COVER, preserves completed Stack updates when trash fails, and distinguishes uncertain trash outcomes while allowing independent failed Stack candidates to be retried. Reserved Stacks show unavailable editing actions, and the trash menu closes when leaving the STACK tab.
- Fixed outer-page scrolling in Chrome by containing STACK accessibility labels within their frame, and added scrollbar clearance so Firefox's overlay scrollbar does not crowd the last card. Empty unmatched frames now shrink with their Grid track instead of clipping their contents.
- Fixed Export registration rejecting healthy source/output Stack ownership because unrelated Immich Stacks were malformed or ambiguous; unsafe ownership of the export targets still fails safely.

- Unified Calendar date-detail boundaries with the month view's Immich Timeline local-day rule, fixing photos with timezone offsets that cross UTC midnight appearing in the previous day's detail.
- Prevented the Home detail Toolbar from clipping selection controls at intermediate widths and preserved pending Home scroll restoration when leaving for Anshitsu or STACK management.
- Disabled Calendar date-detail arrows use a normal cursor when no adjacent photo day is available.
- Prevented incomplete Immich Stack snapshots from failing Home photo lists or exposing surviving Stack children as ordinary photos; Recent continues paging as needed after excluded entries.
- Long-running Stack sends use a dedicated proxy timeout; a response from a previous Stack selection cannot change a new draft; long filename candidates remain writable; and re-detection supports selections over 1,000 assets.
- Prevent Undo/Redo shortcuts from changing the background edit session while save-failure dialogs are open.
- Keep NumLock-off Histogram keypad shortcuts from being consumed as adjustment-slider arrow controls while preserving native numeric input.
- Preserve the exact snapshot, expected revision, and save ID for retries when a PUT may have committed but its response is uncertain, including HTTP 408/5xx and unreadable or invalid success responses. Genuine 409 conflicts are not automatically merged.
- Keep the known saved edited state visible after discarding newer unsaved edits; invalidate an old batch status when the persisted state is unknown.
- Prevent global workspace shortcuts from running while the Viewer `⋯` menu is open, restore trigger focus on Escape, and clear stale 3WAY heading focus after real pointer movement to another slider.
- Treat non-finite optional EXIF integers as missing values so malformed ISO, width, or height metadata does not fail the entire asset detail response.
- Include all backend application modules in the production image so the backend can start with the Immich connectivity module.
