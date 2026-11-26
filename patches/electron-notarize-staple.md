# @electron/notarize 2.5.0: staple through Executor's repeat

electron-builder (app-builder-lib 26.15.6) notarizes the macOS app with `@electron/notarize` 2.5.0,
which then staples it with one `xcrun stapler staple -v` and fails on any error. Since 14 Nov 2026
the Intel macOS leg's staple has lost its connection to Apple's ticket service about half the time
(`NSURLErrorDomain` -1005 on the CloudKit ticket lookup), which fails the build and, in a
publishing run, the beta.

The patch changes only `stapleApp` (`lib/staple.js`): when `EXECUTOR_STAPLE_SCRIPT` is set, it runs
that script with the app's path and passes its output through, instead of running the stapler
itself. The release signing environment (`developerIdMac` in `scripts/releases/macos-signing.ts`)
sets it to `scripts/releases/staple.ts`, which repeats only a failure to reach Apple
(`scripts/releases/macos-staple.ts`). Notarization itself, and every other use of the package, are
unchanged. `e2e/tests/macos-staple.spec.ts` runs the patched copy against a stub `xcrun`.

Remove the patch when electron-builder can skip its own staple, or `@electron/notarize` repeats a
failed ticket lookup itself.
