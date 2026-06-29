# Desktop daemon attach/spawn ownership wedge

Date: 2026-06-22
Status: fix landed (attach-on-conflict), one macOS follow-up open

## Symptom

Desktop app "crashes": the window is up but every request fails / it sits on
the sidecar crash screen and "Restart server" does nothing. Logs show, on a
loop:

```
(sidecar) A local Executor cli-daemon is already running at http://localhost:4789 (pid N).
          It owns the current data directory: /Users/<user>/.executor
          Stop it before starting another local server.
Failed to start executor sidecar Error: Sidecar exited before ready (code=1 ...)
```

## Root cause

The desktop and a standalone `executor daemon run` (the CLI daemon, e.g. a
globally-installed `executor`) both default to owning the same scope dir
`~/.executor`. Only one process may own it at a time (enforced by the
`server-control/server.json` manifest + the per-scope `daemon-*.json` pointers).

`boot()` attaches to an already-running daemon before spawning, so a cold start
is fine. But the two recovery/fallback paths did NOT attach, they only spawned:

- `restartSidecarAndReload()` (non-supervised branch) -> `startWithCurrentSettings()` -> `startSidecar()`
- `boot()` fallback when `ensureSupervisedConnection()` returned null

So the incident sequence was:

1. App spawns its own managed sidecar (`kind: desktop-sidecar`).
2. That sidecar dies (in prod: SIGINT/code 130, coincident with a CLI
   `executor daemon run` starting and grabbing the port/scope).
3. The CLI daemon now owns `~/.executor` (`kind: cli-daemon`, healthy).
4. The app tries to restart -> re-spawns a second server -> dies on the scope
   lock -> treated as fatal -> wedged on the crash screen until the CLI daemon
   is killed by hand.

`replaceSupervisedDaemonForDesktop()` already encodes the right instinct ("on
failure, attach instead of dying"), it just was not applied to the spawn
fallback.

## Fix

`apps/desktop/src/main/index.ts`, `startWithCurrentSettings()`: when a spawn
aborts because the data dir is already owned (`already running` / `owns the
current data directory`), poll `attachToSupervisedDaemon()` for ~10s and adopt
the running cli-daemon instead of surfacing a fatal error. This is the single
chokepoint for both the boot-fallback and restart paths. The short poll also
rides out the health-probe vs. scope-lock race (owner alive but `/api/health`
not yet `ok`).

Also added `EXECUTOR_TEST_SKIP_BACKGROUND_SERVICE=1` (mirrors
`EXECUTOR_TEST_AUTO_CONFIRM_RESET`) so the packaged app can be driven headlessly
without the first-run background-service dialog.

## Reproductions

- `e2e/desktop/sidecar-attach-conflict.test.ts` (dev project, deterministic):
  a CLI daemon owns the temp HOME's `.executor`; the dev app must come up by
  attaching instead of dying on the scope lock. Dev boot always takes the
  managed-spawn path, so it exercises the spawn -> attach fallback directly.
  Needs a GUI session (or Linux+Xvfb) to run; it cannot run from a non-Aqua
  background shell.

- `e2e/desktop-packaged/linux-vm/` (headless real app): builds the linux-arm64
  bundle, runs it under Xvfb in a container, and replays the full incident
  (spawn own sidecar -> kill it -> CLI daemon takes over -> click Restart) over
  CDP. Exit 0 = recovered by attaching; non-zero = wedged. See its README.

## Open follow-up: macOS launchd supervision is broken on at least one machine

Independent of the wedge, the same logs show the supervised-service install
failing on every boot:

```
launchctl bootstrap failed (exit 5): Bootstrap failed: 5: Input/output error
launchctl kickstart failed (exit 113): Could not find service "sh.executor.daemon" in domain for user gui: 501
```

So `ensureSupervisedConnection()` can never promote a daemon to a launchd
service; the app permanently runs in the fragile attach/spawn-ad-hoc mode where
the wedge was reachable. This is macOS-specific (not reproducible under the
Linux+Xvfb harness) and is NOT addressed by the attach-on-conflict fix. Worth a
separate investigation: why `bootstrap` returns EIO and why the `sh.executor.daemon`
unit is absent at kickstart time (LaunchAgent plist not written? wrong domain
target? gui/501 vs system domain?).
