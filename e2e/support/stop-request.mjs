import net from "node:net";

const control = process.versions.bun
  ? net.createConnection({ fd: 3 })
  : new net.Socket({ fd: 3, readable: true, writable: false });
control.on("data", () =>
  process.platform === "win32"
    ? process.emit("SIGTERM", "SIGTERM")
    : process.kill(process.pid, "SIGTERM"),
);
control.on("error", () => {});
control.unref();
