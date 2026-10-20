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

## Stack / Album invariants

- Stack-related Immich Album membership is normalized onto the final COVER. Final non-COVER members leave those Albums except for explicit cases such as reserved Trash assets.
- Dissolving a Stack expands its Album memberships to every released Asset. Export that creates or changes a Stack COVER follows the same normalization.
- Do not persist Album membership history in GenzoRoom; use Immich's current state when each operation runs.
- Do not validate Album behavior from GenzoRoom Gallery alone. Gallery hides Stack non-COVER assets, so tests for Album membership writes must inspect raw Immich Album membership too.

## Testing

- Add or update regression tests for new behavior and bug fixes. Test interactions between related features, not only isolated functions.
- Use risk-based, change-scoped testing throughout implementation, completion audits, and follow-up fixes. Select tests based on the changed code, affected dependencies, integration boundaries, and potential regressions. Do not treat a completion audit as an automatic requirement to run the entire test suite.
- For small, isolated Frontend changes, run relevant Frontend unit and integration tests only. Do not run Backend tests unless the change affects Backend behavior, API contracts, shared data structures, persistence, or another relevant cross-layer dependency.
- For Backend-only changes, run relevant Backend unit and integration tests. Do not run Frontend tests unless the change affects Frontend-facing contracts or behavior.
- For changes spanning Frontend and Backend, test the affected components on both sides and their integration boundaries.
- Expand test coverage for broad changes, shared infrastructure, persistent data, migrations, Queue processing, Undo/Redo, concurrency, failure recovery, security-sensitive behavior, or other high-risk changes. Run the complete Frontend and/or Backend test suite when the impact or regression risk justifies it, not simply because a feature or bug fix is complete.
- At the first completion audit, review the implementation diff, relevant dependencies, test coverage, failure boundaries, and regression risks. Run any additional focused or broader tests needed to close identified verification gaps. A completion audit does not require full Frontend and Backend test suites by default.
- Before running a complete Frontend or Backend test suite, identify and report why focused testing is insufficient. Do not automatically run both full suites when only one subsystem is affected. Respect explicit user instructions limiting test scope.
- Reuse successful test results from the same unchanged code state when applicable. After an audit finding is fixed, rerun tests affected by the fix and its dependent integration points rather than repeating unrelated test suites. Expand verification if the correction changes the original risk assessment.
- If a test fails or times out during a broad run, reproduce it with a focused run before attributing the failure to the current change. Investigate genuine failures, but do not automatically repeat the entire suite for an isolated timeout. Report unresolved failures and verification gaps.
- Run applicable TypeScript checks, production builds, and `git diff --check`. For Frontend-only changes, do not run unrelated Backend checks or builds. For Backend-only changes, do not run unrelated Frontend checks or builds. Broaden these checks when dependencies or generated artifacts cross subsystem boundaries.
- When preparing a release, review existing test and audit results alongside the scope of changes made since. Run additional checks only when needed; do not repeat all tests solely because a release is being prepared.
- Keep test output concise. Report test counts, failures, skips, relevant warnings, and the scope of executed tests without unnecessarily displaying verbose output from successful tests.
- Do not omit necessary tests merely to save time or tokens. Report any verification gap and never claim an unrun test or manual check passed.
- When changing database schemas, migrations, container startup behavior, runtime dependencies, ports, storage paths, or other properties verified by the release Smoke Test, review `release/smoke-test.sh` and update its expectations when necessary.
- Validate modified Smoke Test assertions with focused executable checks where practical. Shell syntax checks alone are insufficient for embedded Python or SQL.
- Do not run the full Docker release Smoke Test for routine development changes. GitHub Actions performs it during distribution-image builds. Report any remaining verification gap.

## Development workflow

- Do not commit or push changes unless explicitly requested. The user performs Git operations, deployment, and NAS/Firefox verification.
- Do not deploy to the NAS or claim to have performed manual browser testing.
- Do not update README, CHANGELOG, or other project documentation unless the task requests it or the implementation makes an update necessary.
- Keep README content for general users: describe features, operation, and limitations, not internal implementation or development history. Normally leave README unchanged during implementation, audit, and fix work. Once a feature is confirmed complete, update README for changes that affect users. Before completion, update it only when explicitly requested or when correcting a serious error or misleading instruction.
- Keep `README.md` and `README.ja.md` aligned and update both in the same change, using natural wording in each language rather than a literal translation. Keep feature descriptions concise; put technical specifications in `docs/architecture.md` and deployment information in the English and Japanese deployment guides.
- Maintain CHANGELOG as a user-facing change history. Finalize entries for a release only when explicitly instructed to prepare or publish that release.
- If it is unclear whether a completed feature warrants a README update, do not add content speculatively; report whether an update appears necessary in the task summary.
- At the end of each task, report changed files, key design decisions, test results, and any remaining risks or manual verification requirements.
