/**
 * Reading workerd inside a released image, for the host's stall check scenarios. These read and
 * signal workerd as root in the container, which a caller of the product cannot do.
 */
import { expect } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import type { releasedServerWith } from "./docker-release-server.ts";

type Server = Effect.Success<ReturnType<typeof releasedServerWith>>;

/** workerd's process ID: the one workerd process serving the generated configuration. */
export const workerdPid = (server: Server) =>
  server
    .execRoot(
      'for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = workerd ] || continue; case "$(cat "$p/cmdline" 2>/dev/null)" in *workerd.capnp*) echo "${p#/proc/}";; esac; done',
    )
    .pipe(
      Effect.map((output) => output.trim().split("\n").filter(Boolean)),
      Effect.tap((pids) => Effect.sync(() => expect(pids, "one workerd process").toHaveLength(1))),
      Effect.map(([pid]) => Number(pid)),
    );

/**
 * When workerd started, in clock ticks since the host booted. A restarted container numbers its
 * processes afresh, so a new workerd can have the old one's ID; its start time differs.
 */
export const workerdStart = (server: Server, pid: number) =>
  server
    .execRoot(`cat /proc/${pid}/stat`)
    .pipe(Effect.map((stat) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!));

/** The scheduler state letter of workerd's main thread, read from /proc. */
export const threadState = (server: Server, pid: number) =>
  server
    .execRoot(`cat /proc/${pid}/task/${pid}/stat`)
    .pipe(Effect.map((stat) => stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3)));

/** Wait until workerd's main thread shows `state`, read from /proc, not assumed from a signal. */
export const awaitThreadState = (server: Server, pid: number, state: string) =>
  threadState(server, pid).pipe(
    Effect.flatMap((current) => (current === state ? Effect.void : Effect.fail(current))),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 50 }),
    Effect.catch((current) =>
      Effect.sync(() => expect(current, `workerd's main thread state`).toBe(state)),
    ),
  );

/**
 * Signals sent to workerd and not yet delivered, as one mask (bit n-1 for signal n), from its
 * process and main thread. A stopped process holds SIGTERM pending, so a check that only saw the
 * process still stopped would not notice that it had been signalled.
 */
export const pendingSignals = (server: Server, pid: number) =>
  server.execRoot(`cat /proc/${pid}/status`).pipe(
    Effect.map((status) =>
      status
        .split("\n")
        .filter((line) => line.startsWith("ShdPnd:") || line.startsWith("SigPnd:"))
        .map((line) => BigInt(`0x${line.split(":")[1]!.trim()}`))
        .reduce((all, mask) => all | mask, 0n),
    ),
  );

export const signalBit = (signal: number) => 1n << BigInt(signal - 1);

/** The host's log lines that match `pattern`. */
export const logLines = (server: Server, pattern: RegExp) =>
  server.logs.pipe(Effect.map((log) => log.split("\n").filter((line) => pattern.test(line))));

/** Wait up to `seconds` for a log line matching `pattern`, and return it. */
export const awaitLogLine = (server: Server, pattern: RegExp, seconds: number) =>
  logLines(server, pattern).pipe(
    Effect.flatMap((lines) =>
      lines.length > 0 ? Effect.succeed(lines[0]!) : Effect.fail("no line" as const),
    ),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: seconds }),
    Effect.catch(() =>
      server.logs.pipe(
        Effect.flatMap((log) =>
          Effect.die(new Error(`No log line matched ${pattern} in ${seconds} s. Log:\n${log}`)),
        ),
      ),
    ),
  );

export const armedLine = /^Stall check armed: /;
export const stalledLine = /^Executor stopped responding: /;
export const answeredLine = /^Executor answered again after /;

/** The container's state as Docker reports it. */
export const containerState = (server: Server) =>
  server.docker(["inspect", "--format", "{{.State.Running}} {{.RestartCount}}", server.id]).pipe(
    Effect.map((output) => {
      const [running, restarts] = output.trim().split(" ");
      return { running: running === "true", restarts: Number(restarts) };
    }),
  );
