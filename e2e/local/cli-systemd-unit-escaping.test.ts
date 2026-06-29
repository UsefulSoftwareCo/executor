// Artifact-level e2e for the Linux service install surface: the emitted
// systemd unit must not contain raw, unescaped paths or environment values
// whose spaces/quotes change systemd tokenization at boot.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { generateSystemdUnit } from "../../apps/cli/src/service";
import { scenario } from "../src/scenario";

scenario(
  "CLI service · generated systemd units escape paths and environment values",
  {},
  Effect.sync(() => {
    const unit = generateSystemdUnit({
      execStart: [
        '/home/alice/Executor "Beta"/executor',
        "daemon",
        "run",
        "--foreground",
        "--port",
        "4789",
      ],
      environment: {
        EXECUTOR_SUPERVISED: "1",
        EXECUTOR_DATA_DIR: "/home/alice/Executor data",
        PATH: '/home/alice/bin:/opt/Bad "Dir"/bin',
      },
      workingDirectory: "/home/alice/Executor data",
      stdoutPath: "/home/alice/Executor data/logs/daemon.log",
      stderrPath: "/home/alice/Executor data/logs/daemon.error.log",
    });

    const unsafeFragments = [
      'ExecStart="/home/alice/Executor "Beta"/executor"',
      "Environment=EXECUTOR_DATA_DIR=/home/alice/Executor data",
      'Environment=PATH=/home/alice/bin:/opt/Bad "Dir"/bin',
      "WorkingDirectory=/home/alice/Executor data",
      "StandardOutput=append:/home/alice/Executor data/logs/daemon.log",
      "StandardError=append:/home/alice/Executor data/logs/daemon.error.log",
    ].filter((fragment) => unit.includes(fragment));

    expect(unsafeFragments, `unsafe raw fragments in unit:\n${unit}`).toEqual([]);
  }),
);
