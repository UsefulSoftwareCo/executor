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
      process.stdin.unref();
    }
    const LiveDate = globalThis.Date;
    const now = () => LiveDate.now() + offset;
    globalThis.Date = new Proxy(LiveDate, {
      apply: () => new LiveDate(now()).toString(),
      construct: (target, args, newTarget) =>
        Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget),
      get: (target, key, receiver) => (key === "now" ? now : Reflect.get(target, key, receiver)),
    });
  }
  if (process.env.EXECUTOR_TEST_STOP_FD === "3") {
    delete process.env.EXECUTOR_TEST_STOP_FD;
    const control =
      process.versions.bun === undefined
        ? new net.Socket({ fd: 3, readable: true, writable: false })
        : net.createConnection({ fd: 3, port: 0 });
    control.on("data", () =>
      process.platform === "win32"
        ? process.emit("SIGTERM", "SIGTERM")
        : process.kill(process.pid, "SIGTERM"),
    );
    control.on("error", () => {});
    control.unref();
  }
}
