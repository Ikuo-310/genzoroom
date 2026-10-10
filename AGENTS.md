# GenzoRoom Development Instructions

## Scope

These instructions apply repository-wide to all future GenzoRoom development tasks. Phase-specific implementation requirements belong in individual task instructions, not this file.

## Code comments

- Add concise English comments for non-obvious design decisions, invariants, compatibility requirements, defensive code, and complex event ordering.
- Explain why an implementation is necessary rather than merely describing what it does. Pay particular attention to interactions between keyboard focus, pointer events, asynchronous operations, History, and persistence.
- Update or remove comments when changing the behavior they describe.
- Avoid redundant comments, commented-out code, and unnecessary documentation. Do not perform unrelated comment-only rewrites during ordinary feature development.

## Source of truth

- Treat the local working tree as the authoritative source for the current task. Inspect relevant source files, tests, and documentation before modifying them.
- Preserve unrelated and uncommitted changes. Do not fetch, pull, reset, or overwrite the working tree unless explicitly requested.
- Follow the existing architecture and naming conventions.

## Implementation

- Reuse existing components, utilities, and state-management mechanisms where possible instead of duplicating functionality.
- Keep changes focused on the requested task; avoid speculative abstractions and unrelated refactoring.
- Preserve existing behavior unless the requested change explicitly modifies it.
- Identify relevant dependencies before editing a change that affects multiple subsystems.

### Structured diagnostics / logging

- For features and fixes, consider diagnostic boundaries: network request/response/failure, asynchronous start/completion, generation changes, stale results, abort/cancellation, retry/attempt, save/load, validation mismatch, fallback, partial outcomes, batch/chunk processing, and important frontend/backend state transitions. Select useful boundaries; do not log every click.
- Reuse the existing structured loggers, schemas, and privacy boundaries. Preserve useful technical metadata such as asset/Stack/member/primary IDs, operation/request/correlation/generation/save IDs, revision, counts, sizes/bytes, timing, method, logical endpoint, HTTP status, phase/state/result, errorCode, exceptionType, versions, cursors, retries, and safe expected/actual validation data.
- Never record API keys, authorization/session credentials, cookies, passwords, access/refresh tokens, raw headers/bodies, full URLs, photo binaries/pixel buffers, Recipe/History bodies, Clipboard content, casually collected absolute filesystem paths, or unlimited user text. Safe derived metadata such as recipeVersion, historyCursor/historyLength, payloadBytes, and pixelCount remains allowed.
- Logging failure must not fail the underlying operation or change its semantics. Restrict expensive diagnostic verification or extra network requests to explicit levels such as debug. Do not automatically capture stdlib/Uvicorn/httpx/browser-console output. Check both frontend and backend impacts when changing logging rules.
- Choose severity by the effect on the GenzoRoom operation, not upstream HTTP status alone: error means required work cannot complete normally; warn means a recoverable abnormal condition (validation/verification mismatch, fallback, partial failure, stale state, unexpected shape, or exhausted retry while higher-level work continues); info means significant operation lifecycle/outcome or a material state transition; debug means detailed reproduction evidence, requests/responses, per-operation metadata, generations, chunks, timing, and internal transitions.
- Levels are cumulative (error; error+warn; error+warn+info; all at debug; none at off). Choose the lowest severity that preserves the event where it is useful. Do not inflate routine success to warn/error or hide important abnormal conditions at debug.
- When lower-level warnings ultimately cause a required GenzoRoom operation to fail, emit an operation-level error for the terminal failure rather than only retaining lower-level warnings. For batch work, distinguish recoverable partial failure from failure of the required overall operation.

### Keyboard shortcuts

- Define GenzoRoom application command bindings in the central registry in `frontend/src/editShortcuts.ts`. Keep command IDs separate from declarative bindings; components must not hard-code new command matching with `event.key` or `event.code`.
- Use logical modifiers for ordinary application commands: Primary means Ctrl on Windows/Linux and Command on macOS; Alternate means Alt on Windows/Linux and Option on macOS. Shift matching uses the same `shiftKey` semantics on every platform. Display labels are Ctrl / Alt / Shift on Windows/Linux and ⌘ / ⌥ / ⇧ on macOS. Matching and displayed labels must resolve modifiers consistently; do not independently translate modifier labels or treat every Ctrl as Command on macOS.
- Use the shared modifier helpers for modified pointer actions as well as keyboard commands. Keep physical Ctrl, Meta, or Alt bindings only when a feature genuinely requires that physical key; otherwise use Primary or Alternate.
- Use `matchesShortcut()` or, when matching a key release independent of modifiers, `matchesShortcutKey()`. Keep action execution and state ownership in the component or hook that owns the feature; do not move all keyboard handling into a global dispatcher.
- The registry is for application commands, not every keyboard interaction. Native or local UI behavior such as Tab / Shift+Tab, Escape, Enter / Space, slider arrows, component focus navigation, and native form editing can remain with their controls. Check for conflicts with registered commands.
- Keep command bindings as the source for future shortcut display. Generate Tooltip, Menu, or shortcut-list labels through a display formatter from registry data, including OS-specific presentation, instead of maintaining separate binding and label definitions.
- Callers remain responsible for applicable event and availability guards, including `defaultPrevented`, IME composition, repeats, native editing targets, dialogs/menus, and feature states such as disabled, switching, or saving. If compatibility requires direct key matching, establish the existing-behavior or platform/browser reason and record it in a concise code comment or the architecture document when needed.

## Compatibility and data integrity

- The supported Backend Python baseline is 3.14 for development, tests, and production Docker. Check Backend compatibility against Python 3.14. The Windows development/test environment uses the repository `.venv` on Python 3.14; do not pin a patch version here.
- Treat Recipe, History, Undo/Redo, persistent edit state, and frontend/backend validation as interconnected systems. When modifying any of them, check the impact on the others.
- Preserve compatibility with supported saved-data versions unless a breaking change is explicitly authorized.
- Do not change persistent-data versions or database schemas unnecessarily.
- Maintain existing save-failure, retry, and conflict-handling guarantees.
- For backend tests on Windows, use the repository virtual environment:
  `I:\code\genzoroom\.venv\Scripts\python.exe`
- Run backend pytest with `I:\code\genzoroom\backend` as the working directory.
  Example:
  `I:\code\genzoroom\.venv\Scripts\python.exe -m pytest`
- If running this executable in the normal sandbox fails with `Permission denied` (including a `uv` trampoline error), rerun the same executable and arguments with privileged execution. Do not switch to `Activate.ps1`, `activate.bat`, or another Python environment.

## Testing

- Add or update regression tests for new behavior and bug fixes. Test interactions between related features, not only isolated functions.
- During incremental implementation and small fixes, run focused tests covering changed code, affected dependencies, and relevant integration points. Do not run the full test suite by default.
- Expand regression testing according to the scope and risk of changes. Run the full suite during implementation when cross-cutting or high-risk changes justify it.
- At feature completion and final code audit, run the full Frontend and Backend test suites, along with applicable TypeScript checks, production builds, and `git diff --check`.
- For long-running development, perform broader regression testing at appropriate phase boundaries rather than postponing it until the entire feature is complete.
- Keep test output concise. Report test counts, failures, skips, and relevant warnings without unnecessarily displaying verbose output from successful tests.
- Never skip relevant tests solely to reduce execution time or token consumption. Never claim that a test or manual verification passed unless it was actually performed. Report any tests that could not be run.

## Development workflow

- Do not commit or push changes unless explicitly requested. The user performs Git operations, deployment, and NAS/Firefox verification.
- Do not deploy to the NAS or claim to have performed manual browser testing.
- Do not update README, CHANGELOG, or other project documentation unless the task requests it or the implementation makes an update necessary.
- Treat `README.md` as the canonical English README and keep `README.ja.md` as its complete Japanese translation; update both when README features or behavior change, without adding Japanese-only specifications.
- At the end of each task, report changed files, key design decisions, test results, and any remaining risks or manual verification requirements.
