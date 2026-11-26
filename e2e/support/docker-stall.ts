import { expect } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import type { releasedServerWith } from "./docker-release-server.ts";

type Server = Effect.Success<ReturnType<typeof releasedServerWith>>;

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

export const workerdStart = (server: Server, pid: number) =>
  server
    .execRoot(`cat /proc/${pid}/stat`)
    .pipe(Effect.map((stat) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!));

export const threadState = (server: Server, pid: number) =>
  server
    .execRoot(`cat /proc/${pid}/task/${pid}/stat`)
    .pipe(Effect.map((stat) => stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3)));

export const awaitThreadState = (server: Server, pid: number, state: string) =>
  threadState(server, pid).pipe(
    Effect.flatMap((current) => (current === state ? Effect.void : Effect.fail(current))),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 50 }),
    Effect.catch((current) =>
      Effect.sync(() => expect(current, `workerd's main thread state`).toBe(state)),
    ),
  );

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

export const logLines = (server: Server, pattern: RegExp) =>
  server.logs.pipe(Effect.map((log) => log.split("\n").filter((line) => pattern.test(line))));

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

export const containerState = (server: Server) =>
  server.docker(["inspect", "--format", "{{.State.Running}} {{.RestartCount}}", server.id]).pipe(
    Effect.map((output) => {
      const [running, restarts] = output.trim().split(" ");
      return { running: running === "true", restarts: Number(restarts) };
    }),
  );
