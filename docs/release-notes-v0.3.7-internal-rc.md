# ComfyMuse v0.3.6

ComfyMuse v0.3.6 is available for Windows portable installation and application-only update.

## Highlights

- Closed governance and resource ownership gaps across direct, Agent, service, and MCP generation paths.
- Added MCP generation preview, confirmation, status, cancellation, duplicate request, owner, digest, and coordinator-busy coverage.
- Added request ledger and task recovery consistency checks.
- Hardened archive paths, task persistence, quota reservations, deadline cancellation, and media normalization.
- Prevented Electron main-process `EPIPE` logging failures from becoming uncaught exceptions when the parent output pipe closes.
- Removed an unsupported root-level `companyName` option from the electron-builder configuration.

## Downloads

- Full portable package: `ComfyMuse-portable-v0.3.6.zip`
- Existing compatible installations: `ComfyMuse-update-v0.3.6.zip`
- Release page: https://github.com/xueLan-io/comfyui-agent/releases/tag/v0.3.6

The portable package is recommended for first installation or upgrades from an older incompatible version. The application-only package preserves the Electron runtime, ComfyUI installation, models, workflows, user data, and project assets.

## Checksums

```text
ComfyMuse-portable-v0.3.6.zip
428acf628713c523196289ed3a41a2590028987f7083972ebf39a3830aecd302

ComfyMuse-update-v0.3.6.zip
2129021a12d5f8b685329f37bd548d0f5fd09f79e5a2dbb1a7894a4de0e6c09a
```

The signed `manifest-stable.json`, `manifest-stable.json.sig`, and `SHA256SUMS.txt` are attached to the release. The application verifies the Ed25519 manifest signature and update package SHA-256 before installation.

## Verification

- `npm test -- --runInBand`: passed, 736 passed, 0 failed, 7 skipped.
- `npm run lint`: passed, 267 files checked.
- `npm run build`: passed.
- MCP lifecycle tests: passed, 10 passed, 0 failed.
- Coordinator, ledger, session, recovery, and packaging tests: passed.

## Notes

- ComfyUI is not included. Configure an existing ComfyUI portable root or running ComfyUI endpoint on first launch.
- Models, workflows, and user data are not included in the release archives.
- Close ComfyMuse before applying the application-only update.
- Windows Authenticode signing depends on the release certificate configuration; SmartScreen may show an unknown publisher warning when the certificate is unavailable.
- The current Vite build emits a large-chunk warning for the prompt library bundle; the production build still completes successfully.
