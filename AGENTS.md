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

### Keyboard shortcuts

- Define GenzoRoom application command bindings in the central registry in `frontend/src/editShortcuts.ts`. Keep command IDs separate from declarative bindings; components must not hard-code new command matching with `event.key` or `event.code`.
- Use `matchesShortcut()` or, when matching a key release independent of modifiers, `matchesShortcutKey()`. Keep action execution and state ownership in the component or hook that owns the feature; do not move all keyboard handling into a global dispatcher.
- The registry is for application commands, not every keyboard interaction. Native or local UI behavior such as Tab / Shift+Tab, Escape, Enter / Space, slider arrows, component focus navigation, and native form editing can remain with their controls. Check for conflicts with registered commands.
- Keep command bindings as the source for future shortcut display. Generate Tooltip, Menu, or shortcut-list labels through a display formatter from registry data, including OS-specific presentation, instead of maintaining separate binding and label definitions.
- Callers remain responsible for applicable event and availability guards, including `defaultPrevented`, IME composition, repeats, native editing targets, dialogs/menus, and feature states such as disabled, switching, or saving. If compatibility requires direct key matching, establish the existing-behavior or platform/browser reason and record it in a concise code comment or the architecture document when needed.

## Compatibility and data integrity

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
- As appropriate, run relevant tests, the full test suite for affected components, TypeScript checks, builds, and `git diff --check`.
- Never claim that a test or manual verification passed unless it was actually performed. Report any tests that could not be run.

## Development workflow

- Do not commit or push changes unless explicitly requested. The user performs Git operations, deployment, and NAS/Firefox verification.
- Do not deploy to the NAS or claim to have performed manual browser testing.
- Do not update README, CHANGELOG, or other project documentation unless the task requests it or the implementation makes an update necessary.
- At the end of each task, report changed files, key design decisions, test results, and any remaining risks or manual verification requirements.
