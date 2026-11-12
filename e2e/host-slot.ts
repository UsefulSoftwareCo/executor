/**
 * One local e2e run at a time per machine. Each worker runs its own product server, database and
 * browser, so two agents' runs on one host starve each other's servers and make their timing
 * failures meaningless. Outside CI, `e2e/run.ts` takes a host-wide slot before it starts the suite,
 * waits while another run holds it, and lowers its default workers to the cores the machine has
 * free.
 *
 * A slot is a file in the temporary directory, created exclusively, naming its holder. The holder
 * touches it every few seconds and deletes it when the run ends, including on Ctrl-C. A killed
 * holder cannot, so a waiter clears a slot whose holder's PID is gone or that has not been touched
 * for `staleAfterMs` (a reused PID). It renames the file aside first and deletes it only if it
 * still names that holder, so it never removes a successor's slot.
 *
 * `EXECUTOR_E2E_HOST_SLOTS=off` skips the slot and the sizing; `EXECUTOR_E2E_HOST_SLOTS=2` lets two
 * runs share the machine. CI (`CI` set) never takes a slot: each job owns its runner.
 */
import { randomBytes } from "node:crypto";
import { Console, Effect, FileSystem, Option, Path, type Scope } from "effect";

const refreshMs = 5_000;
const staleAfterMs = 5 * 60_000;
const pollMs = 2_000;
const reportEveryMs = 60_000;

type Owner = { holder: string; pid: number; cwd: string; args: string; startedAt: number };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`;

/**
 * Holds a host slot for the enclosing scope and returns the default worker count to use: `base`,
 * lowered to half the cores not already busy (each worker keeps about two cores busy), at least 1.
 */
export const hostSlot = (
  base: number,
): Effect.Effect<number, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const setting = process.env.EXECUTOR_E2E_HOST_SLOTS;
    if (process.env.CI || setting === "off" || setting === "0") return base;
    const slots = setting === undefined ? 1 : Number(setting);
    if (!Number.isInteger(slots) || slots < 1)
      return yield* Effect.die(
        new Error(`EXECUTOR_E2E_HOST_SLOTS must be off or a positive integer, not ${setting}`),
      );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(process.env.TMPDIR ?? "/tmp", "executor-e2e-host-slots");
    yield* fs.makeDirectory(root, { recursive: true });
    const owner: Owner = {
      holder: `${process.pid}.${randomBytes(6).toString("hex")}`,
      pid: process.pid,
      cwd: process.cwd(),
      args: process.argv.slice(2).join(" "),
      startedAt: Date.now(),
    };

    const read = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.map((text) => JSON.parse(text) as Owner),
        Effect.option,
      );

    /** Clears `file` if it still names `stale`. */
    const clear = (file: string, stale: Owner) =>
      Effect.gen(function* () {
        const aside = `${file}.${owner.holder}.clearing`;
        if (Option.isNone(yield* Effect.option(fs.rename(file, aside)))) return;
        const moved = yield* read(aside);
        if (Option.isSome(moved) && moved.value.holder !== stale.holder)
          // A successor took the slot after we looked: put its file back.
          yield* Effect.ignore(
            fs.writeFileString(file, JSON.stringify(moved.value), { flag: "wx" }),
          );
        yield* Effect.ignore(fs.remove(aside));
      });

    /** Takes `file`, or returns its holder (undefined while it is being written or cleared). */
    const take = (file: string) =>
      Effect.gen(function* () {
        const created = yield* Effect.option(
          fs.writeFileString(file, JSON.stringify(owner), { flag: "wx" }),
        );
        if (Option.isSome(created)) return "taken" as const;
        const held = yield* read(file);
        if (Option.isNone(held)) return undefined;
        const touched = Option.flatMap(yield* Effect.option(fs.stat(file)), (info) => info.mtime);
        const idle = Option.match(touched, {
          onNone: () => 0,
          onSome: (at) => Date.now() - at.getTime(),
        });
        if (!alive(held.value.pid) || idle > staleAfterMs) {
          yield* clear(file, held.value);
          return { ...held.value, args: `${held.value.args} (stale, cleared)` };
        }
        return held.value;
      });

    const waitingSince = Date.now();
    let reportedAt = 0;
    const slot = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        for (;;) {
          const holders: Array<Owner> = [];
          for (let index = 0; index < slots; index++) {
            const file = path.join(root, `slot-${index}.json`);
            const result = yield* take(file);
            if (result === "taken") return file;
            if (result !== undefined) holders.push(result);
          }
          if (Date.now() - reportedAt >= reportEveryMs) {
            reportedAt = Date.now();
            yield* Console.error(
              [
                `e2e: waiting for a host e2e slot (${slots} on this machine; waited ${minutes(Date.now() - waitingSince)}). Held by:`,
                ...holders.map(
                  (other) =>
                    `  PID ${other.pid} in ${other.cwd} for ${minutes(Date.now() - other.startedAt)}: ${other.args || "(no arguments)"}`,
                ),
                "  Set EXECUTOR_E2E_HOST_SLOTS=off to run anyway, or =2 to allow two runs at once.",
              ].join("\n"),
            );
          }
          yield* Effect.sleep(pollMs);
        }
      }),
      (file) =>
        Effect.gen(function* () {
          const held = yield* read(file);
          if (Option.isSome(held) && held.value.holder === owner.holder)
            yield* Effect.ignore(fs.remove(file));
        }),
    );
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(refreshMs).pipe(
          Effect.andThen(Effect.ignore(fs.utimes(slot, Date.now(), Date.now()))),
        ),
      ),
    );

    // The 1-minute load average, where the OS reports it (Linux); elsewhere the default stands.
    const load = yield* fs.readFileString("/proc/loadavg").pipe(
      Effect.map((text) => Number(text.split(" ")[0])),
      Effect.option,
    );
    if (Option.isNone(load) || !Number.isFinite(load.value)) return base;
    const cores = navigator.hardwareConcurrency;
    const workers = Math.max(1, Math.min(base, Math.floor(Math.max(0, cores - load.value) / 2)));
    if (workers < base)
      yield* Console.error(
        `e2e: ${workers} workers instead of ${base}: load ${load.value.toFixed(1)} on ${cores} cores. Pass --workers to choose.`,
      );
    return workers;
  }).pipe(Effect.orDie);
