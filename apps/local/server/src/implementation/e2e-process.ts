/**
 * The E2E runner's two process hooks, active only when `EXECUTOR_ENVIRONMENT=e2e` asks for them.
 * A release executable runs no preload, so the runner cannot inject these from outside; source
 * runs use the same code, so every run exercises one entry point. Import this module first.
 *
 * - `EXECUTOR_TEST_CLOCK_OFFSET_MS` moves wall time forward by up to 40 days, past the 30-day
 *   refresh token lifetime and idle grant expiry, and `EXECUTOR_TEST_CLOCK_CONTROL=stdin` lets the
 *   runner move it further while the process runs. Timers and monotonic durations are unchanged.
 * - `EXECUTOR_TEST_STOP_FD=3` stops the process when the runner writes to its private fd3 pipe.
 *   Only this process holds the pipe's reading end, so a request reaches it or nothing: after it
 *   exits, the runner's write fails instead of signalling whatever process reuses its PID.
 *
 * Neither hook runs code from outside the process.
 */
import net from "node:net";

const maxOffset = 40 * 86_400_000;

if (process.env.EXECUTOR_ENVIRONMENT === "e2e") {
  const configured = process.env.EXECUTOR_TEST_CLOCK_OFFSET_MS;
  if (configured !== undefined) {
    const parse = (text: string | undefined) => {
      const value = Number(text);
      if (!Number.isSafeInteger(value) || value < 0 || value > maxOffset)
        throw new Error("EXECUTOR_TEST_CLOCK_OFFSET_MS must be 0 to 40 days in milliseconds");
      return value;
    };
    let offset = parse(configured);
    // While the process runs, the runner moves the clock forward with `clock <offset>` lines on
    // standard input; each is confirmed with `Executor test clock: <offset>` on standard output.
    if (process.env.EXECUTOR_TEST_CLOCK_CONTROL === "stdin") {
      let pending = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const match = /^clock (\d+)$/u.exec(line);
          if (match === null) continue;
          offset = Math.max(offset, parse(match[1]));
          process.stdout.write(`Executor test clock: ${offset}\n`);
        }
      });
      // The runner's control channel never keeps a stopping process alive.
      process.stdin.unref();
    }
    const LiveDate = globalThis.Date;
    const now = () => LiveDate.now() + offset;
    // Own the clock before any other module reads it.
    globalThis.Date = new Proxy(LiveDate, {
      apply: () => new LiveDate(now()).toString(),
      construct: (target, args, newTarget) =>
        Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget),
      get: (target, key, receiver) => (key === "now" ? now : Reflect.get(target, key, receiver)),
    });
  }
  if (process.env.EXECUTOR_TEST_STOP_FD === "3") {
    // The pipe is this process's alone. A server this CLI starts gets no fd3, and would fail here.
    delete process.env.EXECUTOR_TEST_STOP_FD;
    // Bun reads an inherited descriptor only through createConnection, which uses the descriptor
    // and ignores the port its types require; Node reads one only through a Socket.
    const control =
      process.versions.bun === undefined
        ? new net.Socket({ fd: 3, readable: true, writable: false })
        : net.createConnection({ fd: 3, port: 0 });
    // On Windows a SIGTERM sent to a process ends it at once, skipping the product's shutdown, so
    // the request is the event the product's runtime listens for instead.
    control.on("data", () =>
      process.platform === "win32"
        ? process.emit("SIGTERM", "SIGTERM")
        : process.kill(process.pid, "SIGTERM"),
    );
    // The runner's end closing is not a request; its process scope still ends whatever remains.
    control.on("error", () => {});
    // The product's own handles decide when it exits.
    control.unref();
  }
}
