# Remaining branch review — 2026-09-06

Reviewed Electron `main` at `0de3d11` against all eight unmerged origin branches. `pr/window-fixes` at `81aa79c` contains the other seven: 101 commits outside main, including 74 non-merge commits. The review covered the complete net changes in all 21 affected paths, the feature/revert history, dependency and release changes, and a three-way merge rehearsal. Tauri main remains `746c8b2` with no unmerged origin branches.

## Merge decisions

| Branch | Decision and resolution |
| --- | --- |
| `chore/profile-startup-log` | Merge via develop. Restore its useful startup diagnostic, using the final isolated userData path. |
| `develop` | Merge with the resolutions below; incorporates its six ancestor branches. |
| `feature/blocked-available-notifications` | Reconcile history with the current multi-provider reset watcher and existing notification/webhook behavior. Do not bring back the old Claude-only combined flag or duplicate that watcher. |
| `fix/center-app-recovery` | Merge. Port the missing native focus/restore event wiring to the current recovery helper. Keep the current app identity, close policy, and provider/restore tray support. |
| `fix/elapsed-ring-color` | Reconcile with the existing continuous slate-to-green elapsed indicator, already independent of usage warning thresholds. Preserve the current design. |
| `fix/offscreen-window-recovery` | Reconcile with the newer, tested three-case recovery policy already on main. |
| `fix/quit-flag` | Retain main's existing before-quit flag and shared close gate; regression tests cover quitting with and without a live provider tray. |
| `pr/window-fixes` | **Hold.** Four reproduced defects below and additional platform/integration work prevent acceptance as a whole. |

The accepted merge adds a position-only recovery function used by native focus/restore events and by the existing show-window path. Native recovery does not call show/focus again, avoiding event re-entry. It preserves window size, intentional single-display overhang, current presets/Settings behavior, and the existing close-to-tray policy.

Conflict resolutions preserve main's non-destructive configuration quarantine, profile-specific history, encrypted-session handling, multi-provider renderer, current branding/dependencies, and current release documentation. The old 1.7.x version changes and staging documents are superseded. Package manifests, lockfile, shared renderer, assets, and Tauri code do not change in this merge. The earlier review's deferred R24 account/freshness notification work remains outstanding; reconciling branch history does not claim to fix it.

## Defects in the held branch

These are reproduced with synthetic inputs against the original `81aa79c` source, not against a user's credentials or live service.

### B01 — A temporary decryption failure permanently deletes the login (P1)

[`getStoredSessionKey`](https://github.com/dev-newb/imburning-electron/blob/81aa79c/main.js#L1382) deletes `sessionKey_encrypted` whenever `decryptString` throws. A denied/unavailable Keychain operation does not establish that ciphertext is corrupt. A simulated temporary failure deletes the entry; a subsequent successful decryption environment can no longer recover the login. Current main retains the encrypted entry and already migrates legacy plaintext safely.

**Required resolution:** preserve ciphertext on decryption failures, report/retry temporary unavailability, and clear credentials only for confirmed invalidation or an explicit logout/replacement. Keep main's credential-presence-only renderer API.

### B02 — Rate-limit detection misclassifies JSON bodies (P2)

[`parseResponseBody`](https://github.com/dev-newb/imburning-electron/blob/81aa79c/src/fetch-via-window.js#L38) scans arbitrary body text for phrases such as `rate limit`. Valid usage JSON containing that phrase throws `RateLimited`, while an error with type `rate_limit_error` and message `Please retry later` is accepted as data. The new retry policy relies on this unreliable classification.

**Required resolution:** build retries on main's HTTP-status-aware classifier, validate structured errors, and retain the R07 challenge/auth distinction. Test real 429 status, valid JSON with those words, structured error bodies, and exhaustion without logout. Optional endpoint failures must not invalidate a successful required response.

### B03 — Spend inference manufactures limit and recovery transitions (P2)

[`detectActiveCreditSpend`](https://github.com/dev-newb/imburning-electron/blob/81aa79c/src/detect-active-credit-spend.js#L38) changes reported utilization to 100% when cumulative spend rises and utilization is at least 95%. Three polls with identical API utilization of 96% display **96 → 100 → 96** when cumulative spend is 100 → 101 → 101 cents. The branch's blocked/available notification logic can treat those manufactured transitions as reaching and clearing a limit. Organization-wide spend also does not identify which person's session incurred it.

**Required resolution:** retain reported percentages and represent inferred spend as a separate, explicitly uncertain signal. Scope comparisons by identity and fresh observations, and test stable utilization, teammate spend, disabled/re-enabled extra usage, and account changes.

### B04 — Saved login allowlist entries bypass validation (P2)

[`loadWhitelist`](https://github.com/dev-newb/imburning-electron/blob/81aa79c/src/domain-whitelist.js#L40) only checks that entries are strings. The CLI rejects `*.com`, but placing it in the documented editable JSON file makes the login window trust any `.com` host. The file reader and CLI therefore enforce different trust boundaries. This requires a malformed local whitelist; it is not a demonstrated remote exploit.

**Required resolution:** normalize and validate every loaded entry with the same rules as CLI input; ignore invalid entries with a diagnostic. Test exact hosts, supported wildcards, malformed files, and invalid broad entries.

## Other held changes and integration constraints

- The `pr/window-fixes` recovery helper and its existing test file are byte-identical to current main. Its delayed move-save destruction guard is also already present.
- Fable/scoped pools, additional rows, history/chart behavior, credit display, and compact mode overlap with newer multi-provider implementations. Old fixed 290px compact sizing and the 530px Settings measurement cannot replace the current R16 implementation.
- Windows taskbar statistics, profile AUMIDs and reset CLI, and Linux/AppImage Xwayland relaunch need separate platform verification and current app identity handling. The incoming branch's own troubleshooting notes report unresolved results on Electron 43; this app uses Electron 43, whereas that branch pins 41.
- Day-Month date options, pre-release update selection, and retry/scheduling changes should be ported separately after the above blockers are resolved. Shared renderer changes must be mirrored into Tauri.
- Temporary credit, decryption, retry, and scheduler mock commits are reverted in the incoming tip. They are historical testing changes, not proposed production hooks.
- Upstream release templates and 1.7.x release metadata describe the original project. Keep this fork's current version, signing, package identity and release process.

## Verification

- Electron: **123 tests passed**, including **14 new native-lifecycle regression tests**. Four focus/restore scenarios failed against pre-merge main and pass with the accepted wiring.
- Tauri: **20 unit + 16 integration tests passed**; its source is unchanged.
- Tests exercise disconnected-monitor recovery, two-display straddling, intentional overhang, late events after destruction, tray hide/show, quit behavior, isolated profiles, and the prior R16 Settings cases.
- Live smoke test: launched the candidate in a new Electron profile using the existing Electron runtime; exercised minimize/native Window-menu restoration and compact → Settings → normal. The dashboard and full Settings remained visible. No login was adopted; the test application was quit afterward.
- Shared JS/CSS remain byte-identical across Electron and Tauri. Manifests, dependencies, and assets remain unchanged. `git diff --check` passes.
- Four held-branch defects reproduced by `characterize-incoming.cjs`. Evidence and the complete incoming patch/commit inventory are retained in the separate review artifacts directory.

Native Windows/Linux and physical monitor-disconnection tests were not performed. The live test used an isolated development instance; this merge does not replace either installed application bundle.
