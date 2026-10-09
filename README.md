# GenzoRoom

GenzoRoom is a self-hosted, Immich-oriented photo-development workflow for browsing photos, organizing RAW/JPEG capture stacks, developing JPEGs, and exporting developed JPEGs to Immich. Confirmed Export uploads a new JPEG, adds the GenzoRoom tag, and makes it the source Stack's Cover while preserving its members. Ordinary photo browsing is read-focused; STACK management sends Stack changes and reserved photo trash moves to Immich only after explicit user confirmation. Anshitsu applies adjustments locally and does not modify image originals.

This is not yet a RAW development pipeline. RAW files can be browsed and filtered, but RAW processing itself is not implemented. The name comes from the Japanese word **現像 (genzō)**, meaning photographic development.

![GenzoRoom Anshitsu workspace showing a JPEG before and after photo development](docs/images/Anshitsu_Sakura.jpg)

*Before and after comparison of a JPEG edited in the desktop Anshitsu workspace.*

## Current features

### Immich browsing and Anshitsu

- Authenticated Immich photo access through the backend, with confirmed STACK management writes described below.
- Home has six tabs: Recent, Albums, Calendar, Favorites, Stacks (STACK管理), and Export (出力管理). A visual gap separates the four browsing tabs from the two management tabs; the independent 「暗室へ」 button at the right opens the separate Anshitsu workspace.
- Home uses a compact dark header, tabs, toolbar, and content area; the header, tabs, and toolbar stay fixed while the content scrolls. Its neutral dark theme is shared with STACK management. The desktop-oriented layout adapts at narrower widths.
- Home photo lists exclude Immich trash assets. For Recent, Favorites, Albums, and Calendar date results, an Immich Stack is represented by its primary/Cover photo; child assets are not shown as separate cards. Invalid or ambiguous Stack metadata is quarantined from Home rather than turning one bad Stack snapshot into a failed photo list. Albums retain Immich's existing album visibility behavior, including Archive assets.
- Stack cards show the member count and unique image formats in the Stack, with the Cover format first (for example, JPEG, DNG, or HEIC). Click a format badge to turn all eligible assets of that format on or off for Anshitsu. Long filenames in Home and Export cards use middle ellipsis that keeps the extension and a useful trailing identifier visible when space is limited.
- In Recent, Albums, Calendar, and Favorites, open a Stack's Cover card in Anshitsu to send multiple Stack assets. The initial selection includes every unexported Non-RAW asset, falling back to every unexported RAW asset when none are available. Assets carrying the GenzoRoom tag are excluded from Stack candidates. The context menu's upper section lets you choose assets individually; its lower section adds or removes edited assets from Export Queue. Checking items does not navigate to Anshitsu. Manual choices are shared across the four tabs for the browser session. A standalone asset keeps the browser's standard context menu, and pressing `D` with no Gallery card selection still resumes the previous Anshitsu session. RAW assets can be displayed in Anshitsu, but RAW development is not implemented.
- Recent shows Immich Timeline images in descending order. Choose 50–500 photos in steps of 50 (100 by default); Archive assets are excluded.
- Albums lists Immich albums and opens each album in the shared photo grid. Album visibility follows the existing Immich album behavior.
- Calendar provides year, month, and date-detail views. Month cells show representative thumbnails; dates are active only when a Timeline image exists. Archive-only and video-only dates are not treated as photo days. Month view and date detail use the same Immich Timeline local-day boundary, so timezone offsets that cross a UTC date boundary do not place a photo in a different day detail than its month cell.
- In Calendar, unmodified Left / Right arrows move backward / forward by month, year, or (in date detail) to the previous / next day containing photos. Date navigation skips days without photos.
- Favorites shows favorited Timeline images and reuses a successfully loaded list while Home remains mounted.
- Photo grids support RAW / Non-RAW and edited / unedited filters. Each filter is independent per Home tab, and the two filters combine.
- Recent, Album, and Calendar photo views can filter stacked versus unstacked assets. Stack cards retain member-count metadata and aggregate edit status across known members. Favorites uses the same primary-only Home data boundary while retaining its existing filter behavior.
- Choose the thumbnail size used by the Home grids with the shared controller; Numpad `-` / `+` steps it down or up. When shortcut explanations are enabled, the button tooltips include these hints.
- Home shows a 「現」 badge on photos carrying Immich's `GenzoRoom` tag. If the tag is missing from a matching GenzoRoom-exported JPEG, Home silently restores it after checking the filename and embedded JPEG identity; no toast is shown.
- Recent, Favorites, Album details, and Calendar date details have an ordered selection toolbar. Album lists and Calendar month/year views do not show photo selection controls. Select All adds currently visible photos and preserves hidden selections; the selection order is retained.
- A normal photo-card click selects only that photo; `Primary`+click toggles it, and `Shift`+click adds the inclusive range from the anchor. A first Shift+click without an anchor does nothing. Checkboxes toggle selection, with Shift+click adding a range. Clear or Escape clears selection; opening Anshitsu uses `D` or the selection toolbar.
- Home shortcuts are `R` Recent, `A` Albums, `C` Calendar, `F` Favorites, `E` Export, `S` STACK management, and `D` Anshitsu. Home tabs use click or these direct commands; Left / Right / Home / End do not switch tabs. Their optional visible suffixes are `[R]`, `[A]`, `[C]`, `[F]`, `[E]`, `[S]`, and `[D]`; `Primary+A` is not shown as a suffix. Settings can hide suffixes and shortcut explanations without disabling commands. `Primary+A` selects all visible photos in photo views and mutable Queue cards in Export (Ctrl+A on Windows/Linux, ⌘A on macOS); native editing, Album lists, and Calendar year/month views keep their normal behavior.
- `S` always opens the STACK management tab. When entering from a Gallery view, a nonempty selection starts or resumes the session for that Asset ID set; with no selection, the previous session resumes, or the first visit shows an empty state. Switching from Export management back to STACK management resumes the retained Stack session. `D` and 「暗室へ」 open Anshitsu from Gallery; without a selection they resume the previous Anshitsu session when one exists. The button and `D` are disabled while STACK management is active.
- Home restores the browsing tab, detail view, and scroll position after returning from Anshitsu or STACK management, and remembers scroll position for each Home view while navigating between tabs.
- Active-photo switching through the Filmstrip, with EXIF details for the current photo.
- Temporarily exclude a Filmstrip photo with its top-left × button, or press `X` for the active photo. The last remaining photo cannot be excluded. Excluding the active photo moves to the next photo, or the previous photo at the end; excluding another photo keeps the current display. `Primary+Z` restores the most recent exclusion in its original position: it displays a restored active photo, but keeps the current display when restoring an inactive photo. This one-shot Undo expires on the next edit, manual photo change, exclusion, or return to Gallery. Photos, Recipe, and History are preserved; exclusions apply only to the current Anshitsu session and reset on reentry.
- Shortcut modifier labels follow the platform: Windows/Linux use Ctrl, Alt, and Shift, while macOS uses Command (⌘), Option (⌥), and Shift (⇧).
- `G` returns from Anshitsu to Gallery/Home. In Anshitsu, `F` toggles Viewer focus mode, `Shift+Z` (shown as `⇧+Z` on macOS) switches between Fit and the previous zoom/pan, and `Primary+Shift+←/→` (shown with ⌘+⇧ on macOS) moves between Filmstrip photos.
- Home and Filmstrip continue to use Immich thumbnails. Anshitsu starts with the Immich preview and acquires only the selected JPEG original in the background; JPEG-only captures and Pixel `RAW-01.COVER.jpg` use the same path. The original is reused while that photo remains selected and released when leaving it. Acquisition or decode failure leaves preview editing available. Immich API credentials stay in the backend.
- Switch between Preview and Original beside Before / After. Both display modes share the same Recipe, History, Undo / Redo, and adjustment ON/OFF state; the display choice is temporary and is not saved. The original is also available to Before / After, Fit, 1:1, and Histogram. Original Info shows its embedded color-profile description and image dimensions, including while Preview is displayed.
- Viewer shortcuts: `]` toggles Preview / Original, and holding Backslash temporarily displays Before. `Shift+Z` toggles Fit and the previous zoom/pan. On JIS keyboards, `]` takes priority when the event code is `Backslash`; while the original is loading or unavailable this key does not invoke the Backslash action. Existing text-input, IME, dialog, and menu guards remain active.
- The Viewer toolbar places Preview / Original before Before / After. The left History and right Develop panel buttons use state-aware arrow icons with Japanese and English tooltips.
- Per-photo JPEG edit recipes and History restored from SQLite when a photo is opened and saved before a dirty Filmstrip switch.
- Dirty JPEG edits are autosaved after five seconds without an editing change; Filmstrip switches still save immediately.
- Returning Home from Anshitsu saves every photo edited during that Anshitsu session and compacts its History.
- The Home grid and Filmstrip show an edited marker for photos with saved edits; Home supports Shift+click range selection in the visible photo order.
- The shared GenzoRoom title returns from Anshitsu to Home through the existing save-and-exit flow; Home's title remains on Home.
- Undo / Redo (`Primary+Z`, `Primary+Shift+Z`, `Primary+Y`), individual adjustment Reset, category Reset, and All Reset.
- History rows can jump directly to an edit state. Header and right-click row menus provide History compaction, clearing, partial deletion from the clicked row, and edit initialization. Compaction, clear, and partial deletion can be immediately undone; clear and reset use localized Cancel / Continue confirmations, with an irreversible-action warning for reset only.
- Copy and paste adjustment values between photos: `Primary+C` copies the current slider operation target, or all values when the Viewer is the target; `Primary+V` applies the copied values to the active photo without requiring slider or Viewer focus. `Primary+Alternate+C` and `Primary+Alternate+V` open item-selection dialogs, and the Viewer’s `⋯` menu offers all four actions.
- Copy / Paste uses one tab-local GenzoRoom clipboard for all 16 numeric adjustments. Enabled flags are never copied, the clipboard survives navigation Home and back within the tab, and it is cleared by a page reload or tab close. OS clipboard contents are not used.
- Web Worker and optional WebGPU rendering for JPEG previews and selected originals, with only the latest pending edit retained and a main-thread fallback if the Worker is unavailable or fails.
- Fit, 1:1, zoom, and pan controls.
- Before / After display toggle and hold the Backslash key for temporary Before; comparison bypasses develop adjustments without changing edits or zoom/pan.
- An 8-bit sRGB Histogram from JPEG previews and selected originals, with 256 bins each for R, G, B, and Y′. The Scope supports individual RGB visibility while keeping at least one channel on, Y Only, a Normal scale based on the shared RGB maximum, and an Expanded scale using nearest-rank P99. It follows both persistent and temporary Viewer Before / After display. On desktop, its height can be resized from 15% to 40% of the right panel (30% by default) and is remembered by the browser.
- Histogram shortcuts: Numpad 0 toggles Y Only; Numpad 1, 2, and 3 toggle R, G, and B; Numpad Decimal toggles Normal / Expanded. While Y Only is active, the first Numpad 1–3 press restores the previous RGB selection; the next press toggles that channel. Text and number fields keep native keypad input.
- RGB visibility, Y Only, and scale mode remain selected when switching photos in Anshitsu.
- Independently collapsible and resizable desktop sidebars with remembered widths.
- A shared Settings dialog available from Home and Anshitsu. It offers Auto, Japanese, and English display language; Auto follows the browser's preferred languages and falls back to English. Date and time locale is independent of display language, with Auto using the browser's regional settings and choices including Japan, the US, the UK, and other supported regions. Calendar week start can be Auto, Sunday, or Monday. A keyboard-shortcut display setting controls shortcut explanations in Tooltips and Menus; turning explanations off leaves the shortcuts active.
- Browser-saved image preferences, including WebGPU enablement and Anshitsu's initial image choice (Auto, Original preferred, or Preview preferred). Auto prefers the original when WebGPU is enabled and available; otherwise it keeps the preview. The preview is shown while a selected JPEG original loads, then switches automatically when ready unless Preview is preferred or the user has manually chosen a source.
- Settings shows Immich server version and available build information alongside GenzoRoom and backend connection status. Preferences are stored in the browser; the Immich API key stays on the backend.

### Export management

- Open Export / 出力管理 with its Home tab or `E`, keeping the Gallery view state while using the same Header / Tabs / Toolbar / Content shell.
- The persistent Export Queue is displayed as individual photo cards. Two or more queued assets from the same Immich Stack share a group; only queued members appear. Groups start at their first Queue member, preserve member order, and become standalone cards when only one member remains. Thumbnail sizing is shared with Home.
- Export cards currently show Immich source thumbnails to identify Queue assets; they are not previews rendered with the GenzoRoom Recipe.
- Select cards with normal click, Primary+click, Shift+click, checkboxes, or Select All / `Primary+A`; Shift ranges follow the displayed group order. Clear and Escape clear selection.
- `W` explicitly marks selected mutable cards ready to export. Mixed selections turn readiness ON; an entirely ready selection turns it OFF. Readiness survives clearing selection and switching Home tabs, but is temporary and is not saved across reloads. It is separate from persistent Queue membership and the runtime status `waiting`.
- Ready cards show **Ready to export / 出力待機中** in a full-width, 28px-high status bar over the thumbnail's bottom edge.
- While failed exports are being retried, only failed cards can be managed. Other queued cards keep their readiness internally but temporarily hide the ready badge and disable selection/removal. The tab bar explains this restriction; normal controls return once Retry finishes without failed items.
- `Q` or Remove from Queue removes selected `queued` / `failed` assets sequentially. Successful removals disappear immediately; failures retain successful work and trigger a refresh with a localized alert. `waiting`, `encoding`, and `registering` cards are locked against selection, readiness changes, and removal. Gallery and Anshitsu keep their own Queue-toggle behavior.
- In Export, `Primary+Z` (Ctrl+Z / ⌘Z) undoes the latest W readiness or Q removal operation once. It does not restore selection; there is no Redo.
- **Export to Immich / Immichへ出力** confirms and starts ready `queued` assets in Queue order, using their saved Recipes. Output is a full-resolution JPEG with a family-based `GenzoNN` filename, the GenzoRoom tag, and the source Stack's Cover. Cancel export confirms stopping after the current photo. When failed items exist, **Retry export / 出力を再試行** confirms and starts only those items with their latest saved Recipes. Start, Cancel, Retry, and successful export are outside W/Q Undo.
- Interrupted runs resume after Backend restart. Partial registration can leave an uploaded asset, and rare duplicate output is possible.

### STACK management

- STACK management is a normal Home tab. Send an ordered Home selection, including RAW assets and Favorites selections, to the editor; existing Immich Stacks are resolved with their complete membership before editing. With no Gallery selection, the previous editing session resumes, or a first visit shows an empty state. The same Asset ID set, regardless of order, keeps its draft; a different nonempty set starts a fresh session. Switching tabs and visiting Anshitsu preserve unsent edits and Undo for the current SPA session.
- The editor always shows STACK candidates above unmatched photos in two independently scrolling frames. The initial height ratio is 2:1; drag the separator to set the upper frame between 50% and 80% (1:1 to 4:1). The ratio lasts for the Home session and returns to 2:1 after reload. The whole lower frame accepts a Stack-member drop to remove it; a photo-card drop uses its existing card action.
- Detect RAW / JPEG candidates by exact filename family, including supported Pixel RAW and Motion Photo naming patterns. When names differ, a unique one-RAW / one-Non-RAW pair can be suggested when TIME, camera make/model, and GPS EXIF evidence all match.
- Untouched auto candidates show NAME / TIME / CAM / GPS evidence. Existing Immich groups keep the IMMICH indicator (yellow when modified); manual groups and auto groups with member changes show MANUAL. The workspace selects a COVER automatically and lets you change it.
- Add unmatched photos to a Stack, Purge groups or members, create manual Stacks, and use desktop Drag & Drop to move unmatched photos into a Stack, move members between Stacks, or return members to unmatched. Dropping one unmatched photo onto another creates a two-member MANUAL Stack; dropping onto the unmatched section's empty space does nothing. Returning a group to its original Immich membership and COVER restores its original Stack lineage.
- Use `Primary+Z` to undo the last local Stack-structure edit once, including D&D-created manual Stacks. Undo does not rewind Immich source data or send results; Redo and an Undo button are not provided.
- Right-click an existing Stack's non-COVER, non-RAW member and choose **Move to trash / ゴミ箱に入れる** to reserve it; a trash icon marks its thumbnail. The current COVER and the COVER originally loaded from Immich are protected. Newly added or moved-in photos are not eligible. Choose **Cancel trash reservation / ゴミ箱予約を取り消す** to cancel, or use the same one-step `Primary+Z` Undo before sending.
- Reservations take effect together with Stack edits through **Send to Immich / Immichへ送信**. Photos move to Immich's normal trash, without permanent deletion. **Purge** only removes photos from the Stack draft and leaves them in Immich; it is different from moving a photo to trash. While a Stack has reservations, cancel them before changing its COVER, purging it, or moving its members; adding unmatched photos remains available.
- On confirmed send, the final draft is classified as unchanged, create, update, or delete. Unchanged Stacks do not issue a write; Cover-only changes update the primary. Immich v3.2.4 membership changes release the old Stack and create its replacement. Partial outcomes are shown; uncertain outcomes block blind retry and require re-detection.
- Stack cards use the shared Gallery middle-ellipsis filename display. The Immich send button uses the same red action style as Export.
- The workspace is desktop-browser oriented. Touch Drag & Drop, Stack/group reordering, and external file drop are not supported.
- A one-member Immich Stack is shown as an abnormal Stack, including a red `1` badge in Home and a warning in STACK management. It cannot be edited as a normal Stack; only purging the group is allowed, which follows the existing confirmed delete plan. An untouched singleton creates no write operation.
- The toolbar shows pending create / update / delete counts only when there are operations to send. A send with no operations reports that there are no changes.

### Developer Diagnostics

- The opt-in Developer Diagnostics Logs tab provides separate Frontend and Backend levels, clear and JSON export controls, refresh, and combined / source-specific views. Frontend logging is synchronized across same-origin tabs. Both collectors are turned off when Developer Diagnostics is closed; logging is off by default. Diagnostic events follow the privacy boundaries documented in [`AGENTS.md`](AGENTS.md).

### JPEG edit state and saving

Anshitsu loads saved JPEG edit state before enabling Develop controls. Dirty edits are autosaved with their full History after five seconds of inactivity, and a dirty photo is saved before a Filmstrip switch. The **Back to photos** control performs a final sequential save for every photo edited in that Anshitsu session and compacts each History. If a save response is lost, GenzoRoom retries that exact snapshot, revision, and save ID before sending a newer snapshot; genuine revision conflicts are reported without merging. Reloading or closing the browser during the debounce or an in-flight save can still lose the latest edits; Browser Back and tab-close interception are not implemented. A failed final save offers the choice to stay in Anshitsu or exit without saving.

### Current adjustments

Editing is currently available for JPEG assets only. Anshitsu begins with the Immich-generated JPEG preview and can use the selected JPEG original as its image source.

| Category | Adjustments |
| --- | --- |
| White Balance | Temperature, Tint |
| Basic | Exposure, Contrast, Highlights, Whites, Shadows, Blacks |
| Color | Vibrance, Saturation |
| Color Grading | Shadows Temperature, Shadows Tint, Midtones Temperature, Midtones Tint, Highlights Temperature, Highlights Tint |

Recipe v18 provides an individual ON/OFF switch for each of the 16 numeric adjustments, in addition to independent category and Color Grading range switches. These 23 switches do not enable or disable one another, and turning any switch off retains its numeric values. Individual, category, range, and all-reset operations participate in History and Undo / Redo. Processing is performed locally in the browser; Immich originals are not modified.

### Optional WebGPU acceleration

Anshitsu can use WebGPU to accelerate JPEG preview and selected-original adjustments. The WebGPU ON/OFF switch is in Settings, and its preference is remembered by the browser. Settings distinguishes the saved preference from the actual processing state. A compatible GPU, driver, and browser are required; WebGPU generally requires a Secure Context. HTTPS is recommended for general use. If WebGPU is unavailable or GPU initialization or rendering fails, Anshitsu uses the CPU Worker, with the existing main-thread fallback if the Worker also fails. Editing remains available without WebGPU.

Firefox and Edge on Windows with a Radeon RX 580 are a verified configuration; the RX 580 is not a minimum requirement. On a LAN address served over HTTP, some browsers can use WebGPU only with a browser-specific development exception that treats the origin as secure. This exception does not encrypt the connection; HTTP traffic remains unencrypted. HTTPS is recommended for general use. Detailed browser-specific exception instructions are outside this guide.

Copy / Paste transfers saved numeric values, including values in disabled categories, adjustments, or Color Grading ranges; ON/OFF switches are never copied. Paste changes only the copied adjustment values and keeps the destination photo’s enabled flags. Category, individual adjustment, and Color Grading range context menus provide their relevant copy, paste, reset, or toggle operations. A selected Paste can apply any subset without changing the clipboard. Each changed Paste appears as one undoable History entry labelled with the source filename; repeating values already present creates no new entry. Text and numeric editing fields keep their native browser Copy / Paste behavior.

## Current limitations

- The working and Histogram pipeline remains browser-managed 8-bit sRGB. Embedded sRGB and Display P3 profiles are considered during original decoding and converted into that working space; this is not a wide-gamut or HDR pipeline.
- HEIC, PNG, RAW, and other non-JPEG assets are not editable.
- RAW development, including DNG, remains unimplemented. STACK management can group a JPEG with its RAW capture, but only the JPEG is editable; a JPEG `COVER.jpg` is handled through the JPEG original path.
- Original rendering processes full-resolution pixels. WebGPU can accelerate this path when supported; CPU processing remains available and is slower on the tested NAS / Firefox setup. No detailed performance benchmark has been performed.
- Edits made within the five-second debounce or during an in-flight save can be lost on reload or tab close; these browser events are not intercepted.
- Recent displays the selected 50–500 item window and currently has no pagination or search.
- Anshitsu is desktop-first; there is no dedicated mobile editing workspace.
- STACK management is available in desktop browsers; touch Drag & Drop and Stack/group reordering are not supported.

## Not implemented

- RAW development pipeline.
- Automatic Immich Stack attachment for assets re-imported outside GenzoRoom Export.
- Stack/group reordering through Drag & Drop.
- Touch Drag & Drop in STACK management.
- Color Grading Point / Width controls; the three tone ranges currently use fixed weights.
- Waveform Monitor (WFM), RGB Parade, and Vectorscope. Histogram is implemented in the Scope area.
- Masking or local adjustments.
- Crop or rotate tools.
- AI-assisted adjustments.
- Noise reduction.

These are current boundaries, not release commitments or a promised roadmap.

## Security and data handling

- Normal photo access uses Immich read endpoints. Confirmed STACK management uses Stack create/update/delete operations and explicitly reserved photo moves to Immich trash; it does not permanently delete assets, modify image originals, or upload files. Use a dedicated API key with `user.read`, `asset.read`, `asset.view`, `asset.download`, `asset.delete`, `server.about`, `stack.read`, `stack.create`, `stack.update`, and `stack.delete` permissions. `asset.delete` permits reserved trash moves, `asset.download` retrieves selected JPEG originals, and `server.about` supplies the server information shown in Settings.
- The Immich API key is supplied to the backend through environment variables. It is not sent to the frontend or embedded in the frontend image.
- Browser requests use same-origin `/api/` routes. The backend port is not published to the host in the provided Compose configuration.
- TLS certificate verification remains enabled for HTTPS Immich URLs. Upstream response bodies, credentials, and internal exception details are not exposed to the browser.
- The provided containers run as non-root users, drop Linux capabilities, and disable privilege escalation.
- GenzoRoom does not modify image originals. Its SQLite edit-state API stores only GenzoRoom recipes and History; Stack membership writes are limited to explicitly confirmed STACK management operations.

Never commit a real API key or bake one into a container image. See the [deployment guide](docs/deployment.md) for configuration and network options.

## Requirements

- Docker Engine with Docker Compose v2, or Portainer connected to a Docker Standalone environment.
- An existing Immich server reachable from the GenzoRoom backend container.
- A dedicated Immich API key with `user.read`, `asset.read`, `asset.view`, `asset.download`, `asset.delete`, `server.about`, `stack.read`, `stack.create`, `stack.update`, and `stack.delete` permissions. Stack permissions and `asset.delete` are used by confirmed STACK management operations.
- A browser that can reach the GenzoRoom frontend. The default host port is `3190` and can be changed with `GENZOROOM_PORT`.

## Quick start

1. Create a dedicated Immich API key with the permissions listed above.
2. For Docker Compose, copy [`.env.example`](.env.example) to `.env` and configure `IMMICH_URL` and `IMMICH_API_KEY`. Set `GENZOROOM_PERSIST_ROOT` or `GENZOROOM_DATA_PATH`, then prepare the resulting host data directory and grant UID/GID `10001:10001` write access as described in the [deployment guide](docs/deployment.md). Portainer users can set the same values as Stack environment variables. Optionally set `GENZOROOM_PORT`; it defaults to `3190`.
3. From a repository checkout, build and start the standard Docker Compose deployment:

   ```sh
   docker compose up -d --build
   ```

4. Open the configured GenzoRoom address. HTTPS is recommended for general use; the default local Compose setup publishes HTTP on port `3190` and does not encrypt that connection.

If Immich runs on the same Docker host and is not reachable through the host LAN address, use the optional shared-network configuration documented in the [deployment guide](docs/deployment.md). Portainer Git Repository Stack instructions are covered there as well.

## Architecture and documentation

- [Architecture](docs/architecture.md) — request flow, container boundaries, editing model, and current technical limitations.
- [Deployment](docs/deployment.md) — Docker Compose, Portainer, Immich network routes, verification, troubleshooting, and removal.
- [Development notes (Japanese)](docs/development-notes.ja.md) — implementation history and design decisions.
- [Deployment notes (Japanese)](docs/deployment-notes.ja.md) — notes for the currently validated deployment, including one observed QNAP networking issue.

## License

GenzoRoom is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
