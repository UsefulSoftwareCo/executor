# Testing on macOS

Packaged desktop e2e tests need a real GUI session. Check `launchctl managername`;
it should report `Aqua`. SSH-only sessions usually land in the Background
launchd domain, where `open` can fail with `OSLaunchdErrorDomain Code=125` even
after the VM is reachable over SSH.

For VM runs, log in through VNC before launching the app. SSH is still useful
for staging files, reading logs, and running probes, but GUI app launch and
window assertions are more reliable after a console user is active.

[trycua/cua](https://github.com/trycua/cua)'s Lume CLI is a useful way to clone,
boot, SSH into, VNC into, stop, and delete local macOS VMs programmatically.

The packaged desktop app has a single-instance lock on macOS. If
`/Applications/Executor.app` is already running on the host, prefer an isolated
VM or close that app before running `vitest run --project desktop-packaged`.

Useful evidence locations:

- Main process log: `~/Library/Logs/Executor/main.log`
- Supervised daemon manifest: `~/.executor/server-control/server.json`
- Electron CDP port: `~/Library/Application Support/Executor/DevToolsActivePort`

When debugging black-window reports, verify both pixels and renderer state. VNC
can occasionally show a black framebuffer while CDP proves the renderer DOM is
healthy, so capture a CDP screenshot or inspect `document.body.innerText` before
calling a UI blank.
