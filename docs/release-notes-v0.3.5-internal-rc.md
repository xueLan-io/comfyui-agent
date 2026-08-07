# ComfyMuse v0.3.5 Internal RC

Status: internal release candidate. Not approved for public distribution.

## Included

- Closed governance and resource ownership gaps across direct, Agent, service, and MCP generation paths.
- Added MCP generation preview, confirmation, status, cancellation, duplicate request, owner, digest, and coordinator-busy coverage.
- Added request ledger and task recovery consistency checks.
- Hardened archive paths, task persistence, quota reservations, deadline cancellation, and media normalization.
- Prevented Electron main-process `EPIPE` logging failures from becoming uncaught exceptions when the parent output pipe closes.
- Removed an unsupported root-level `companyName` option from the electron-builder configuration.

## Verification

- `npm test -- --runInBand`: passed, 736 passed, 0 failed, 7 skipped.
- `npm run lint`: passed, 267 files checked.
- `npm run build`: passed.
- MCP lifecycle tests: passed, 10 passed, 0 failed.
- Coordinator, ledger, session, recovery, and packaging tests: passed.

## Not Yet Verified

- A complete Windows installer or portable artifact was not produced because electron-builder could not download Electron 33.4.11 in the current network environment.
- Fresh-directory installation and installed-app startup remain pending.
- End-to-end ComfyUI image generation, unavailable-ComfyUI failure handling, and restart recovery require a local ComfyUI runtime and manual verification.
- Release manifest, signatures, portable/update archives, and SHA256 release checksums have not been generated.

## Release Gate

Do not publish this RC until the Windows package, installed-app startup, ComfyUI integration, MCP HTTP session isolation, restart recovery, and release signing checks pass in a clean environment.
