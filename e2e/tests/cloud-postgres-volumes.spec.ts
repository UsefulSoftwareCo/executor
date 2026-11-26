import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  processStarted,
  volumeLabels,
  volumeVerdict,
  type SweptVolume,
  type VolumeOwner,
} from "../support/cloud-postgres.ts";

const here: VolumeOwner = {
  boot: "0f8b4d1e-2c3a-4b5d-8e6f-7a8b9c0d1e2f",
  namespace: "linux/0f8b4d1e-2c3a-4b5d-8e6f-7a8b9c0d1e2f/pid:[4026531836]/time:[4026531834]",
  pid: 1000,
  started: "500",
};
const now = Date.parse("2026-11-15T12:00:00Z");
const hourAgo = now - 60 * 60_000;

const volume = (change: Partial<SweptVolume> = {}): SweptVolume => ({
  name: "executor-e2e-0123456789abcdef-data",
  labels: {
    [volumeLabels.role]: "cloud-postgres-data",
    [volumeLabels.boot]: here.boot,
    [volumeLabels.namespace]: here.namespace,
    [volumeLabels.pid]: "4242",
    [volumeLabels.started]: "777",
  },
  createdAt: hourAgo,
  mountedBy: 0,
  ...change,
});

const owner =
  (answer: Option.Option<string> | undefined) =>
  (pid: number): Effect.Effect<Option.Option<string> | undefined> =>
    Effect.succeed(pid === 4242 ? answer : Option.none());

const verdict = (subject: SweptVolume, answer: Option.Option<string> | undefined) =>
  volumeVerdict(subject, here, now, owner(answer));

const without = (label: string) => {
  const labels: Record<string, string> = { ...volume().labels };
  delete labels[label];
  return volume({ labels });
};

layer(NodeServices.layer, { excludeTestServices: true })("Cloud test database volumes", (it) => {
  it.effect("a volume whose owner runs, with the recorded start time, is kept", () =>
    Effect.gen(function* () {
      expect(yield* verdict(volume(), Option.some("777"))).toEqual({
        remove: false,
        why: "owner runs",
      });
    }),
  );

  it.effect("a volume whose owner has exited is removed", () =>
    Effect.gen(function* () {
      expect(yield* verdict(volume(), Option.none())).toEqual({
        remove: true,
        why: "owner exited",
      });
    }),
  );

  it.effect("a volume from another boot is removed, whatever its pid names now", () =>
    Effect.gen(function* () {
      const old = volume({
        labels: {
          ...volume().labels,
          [volumeLabels.boot]: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          [volumeLabels.namespace]:
            "linux/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/pid:[4026531836]/time:[4026531834]",
        },
      });
      expect(yield* verdict(old, Option.some("777"))).toEqual({
        remove: true,
        why: "another boot",
      });
    }),
  );

  it.effect("a volume whose pid now names a process with another start time is removed", () =>
    Effect.gen(function* () {
      expect(yield* verdict(volume(), Option.some("91234"))).toEqual({
        remove: true,
        why: "owner's pid reused",
      });
    }),
  );

  it.effect(
    "a volume a stopped or running container mounts is kept, even with its owner gone",
    () =>
      Effect.gen(function* () {
        expect(yield* verdict(volume({ mountedBy: 1 }), Option.none())).toEqual({
          remove: false,
          why: "mounted",
        });
        const old = volume({
          mountedBy: 1,
          labels: {
            ...volume().labels,
            [volumeLabels.boot]: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          },
        });
        expect(yield* verdict(old, Option.none())).toEqual({ remove: false, why: "mounted" });
      }),
  );

  it.effect("a volume missing any owner label, or with a malformed one, is kept", () =>
    Effect.gen(function* () {
      for (const label of [
        volumeLabels.boot,
        volumeLabels.namespace,
        volumeLabels.pid,
        volumeLabels.started,
      ])
        expect(yield* verdict(without(label), Option.none()), label).toEqual({
          remove: false,
          why: "incomplete labels",
        });
      for (const [label, value] of [
        [volumeLabels.pid, "0"],
        [volumeLabels.pid, "42x"],
        [volumeLabels.boot, "not-a-boot"],
        [volumeLabels.started, ""],
      ] as const)
        expect(
          yield* verdict(volume({ labels: { ...volume().labels, [label]: value } }), Option.none()),
          `${label}=${value}`,
        ).toEqual({ remove: false, why: "incomplete labels" });
    }),
  );

  it.effect("a volume this harness did not label is kept", () =>
    Effect.gen(function* () {
      for (const labels of [
        { "com.docker.volume.anonymous": "" },
        {},
        { "com.docker.compose.project": "executor" },
        { ...volume().labels, [volumeLabels.role]: "cloud-postgres" },
      ])
        expect(yield* verdict(volume({ labels }), Option.none())).toEqual({
          remove: false,
          why: "not ours",
        });
    }),
  );

  it.effect("a volume made in the last five minutes is kept, before its container mounts it", () =>
    Effect.gen(function* () {
      expect(yield* verdict(volume({ createdAt: now - 60_000 }), Option.none())).toEqual({
        remove: false,
        why: "young",
      });
    }),
  );

  it.effect("a volume from another process namespace of this boot is kept", () =>
    Effect.gen(function* () {
      const other = volume({
        labels: {
          ...volume().labels,
          [volumeLabels.namespace]: `linux/${here.boot}/pid:[4026532999]/time:[4026531834]`,
        },
      });
      expect(yield* verdict(other, Option.none())).toEqual({
        remove: false,
        why: "another process namespace",
      });
    }),
  );

  it.effect("a volume whose owner's start time cannot be read is kept", () =>
    Effect.gen(function* () {
      expect(yield* verdict(volume(), undefined)).toEqual({ remove: false, why: "owner unknown" });
    }),
  );

  it.effect.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "a real process's start time reads the same twice, and as none once it has exited",
    () =>
      Effect.gen(function* () {
        const own = yield* processStarted(process.pid);
        expect(own).toEqual(yield* processStarted(process.pid));
        expect(own !== undefined && Option.isSome(own)).toBe(true);
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* processes.spawn(
          ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
        const pid = Number(child.pid);
        const started = yield* processStarted(pid);
        expect(started !== undefined && Option.isSome(started)).toBe(true);
        expect(started).not.toEqual(own);
        yield* child.kill();
        yield* child.exitCode.pipe(Effect.ignore);
        expect(yield* processStarted(pid)).toEqual(Option.none());
      }).pipe(Effect.scoped),
  );
});
