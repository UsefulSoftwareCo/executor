const maxOffset = 40 * 86_400_000;
const parse = (text) => {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0 || value > maxOffset) {
    throw new Error("The isolated test process needs a valid wall-clock offset");
  }
  return value;
};
let offset = parse(process.env.EXECUTOR_TEST_CLOCK_OFFSET_MS);

if (process.env.EXECUTOR_TEST_CLOCK_CONTROL === "stdin") {
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^clock (\d+)$/.exec(line);
      if (match === null) continue;
      offset = Math.max(offset, parse(match[1]));
      process.stdout.write(`Executor test clock: ${offset}\n`);
    }
  });
  process.stdin.unref?.();
}

const LiveDate = globalThis.Date;
const now = () => LiveDate.now() + offset;
globalThis.Date = new Proxy(LiveDate, {
  apply: () => new LiveDate(now()).toString(),
  construct: (target, args, newTarget) =>
    Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget),
  get: (target, key, receiver) => (key === "now" ? now : Reflect.get(target, key, receiver)),
});
