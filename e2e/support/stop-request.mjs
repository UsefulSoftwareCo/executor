/** Test-process entry preload: stop when the runner asks through this process's private fd3 pipe. */
import net from "node:net";

// Only this process holds the pipe's reading end, so a request reaches it or nothing: after it
// exits, the runner's write fails instead of signalling whatever process reuses its PID. Bun reads
// an inherited descriptor only through createConnection, and Node only through a Socket.
const control = process.versions.bun
  ? net.createConnection({ fd: 3 })
  : new net.Socket({ fd: 3, readable: true, writable: false });
// On Windows a SIGTERM sent to a process ends it at once, skipping the product's shutdown, so the
// request is the event the product's runtime listens for instead.
control.on("data", () =>
  process.platform === "win32"
    ? process.emit("SIGTERM", "SIGTERM")
    : process.kill(process.pid, "SIGTERM"),
);
// The runner's end closing is not a request; its process scope still ends whatever remains.
control.on("error", () => {});
// The product's own handles decide when it exits.
control.unref();
