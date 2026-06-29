# Headless Linux reproduction: desktop daemon attach/spawn wedge

Reproduces, against the REAL packaged desktop app (no macOS, no host GUI), the
production incident where the app wedges on the sidecar crash screen because a
standalone `executor daemon run` (the CLI daemon) already owns `~/.executor`.

See `../../../notes/desktop-daemon-ownership-wedge.md` for the root cause. The
fix lives in `apps/desktop/src/main/index.ts` (`startWithCurrentSettings`):
when a spawn aborts because the data dir is already owned, the app attaches to
the running cli-daemon instead of failing.

## What the driver does (`repro.mjs`)

Replays the exact incident over the Chrome DevTools Protocol:

1. Cold boot with no daemon -> the app spawns its own managed sidecar.
2. SIGKILL that sidecar -> the in-window crash screen appears.
3. Start a separate `executor daemon run` that takes over `~/.executor`.
4. Click "Restart server".

Exit 0 = the app recovered by ATTACHING to the cli-daemon (fixed). Non-zero =
it re-spawned into the scope lock and stayed wedged (the bug), or a harness
failure. A watchdog (`REPRO_WATCHDOG_MS`, default 240s) bails loudly rather than
hanging.

## Requirements

- Docker / OrbStack with linux/arm64 (Apple Silicon runs arm64 Linux natively;
  on x64 build the bundle for linux-x64 and pass `--platform linux/amd64`).

## Run

Build the linux bundle on the host, then run it in the container:

```sh
# from apps/desktop — build the bundled CLI sidecar + the linux app bundle
BUN_TARGET=linux-arm64 bun ./scripts/build-sidecar.ts
bunx --bun electron-vite build
bunx --bun electron-builder --linux --arm64 --config electron-builder.e2e.config.ts

# from this dir — build the image and run the repro
cd ../../e2e/desktop-packaged/linux-vm
docker build --platform linux/arm64 -t executor-linux-repro .
docker run --rm --init --platform linux/arm64 \
  -v "$PWD/../../../apps/desktop/dist/linux-arm64-unpacked":/app:ro \
  executor-linux-repro
```

Always run with `--init` so Electron's detached children are reaped and the
container exits cleanly.

## Proving the bug (RED)

Build the bundle from a commit BEFORE the fix and run the same image against it:
the driver reports `FAIL: app stayed wedged on the crash screen after restart`
and exits non-zero. Against the fixed bundle it prints `PASS`.
