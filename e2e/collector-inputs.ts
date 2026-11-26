export const collectorInputs: ReadonlyArray<string> = [
  "packages/telemetry/collector/",
  "packages/telemetry/scripts/build-collector.ts",
  ".github/actions/collector/",
  ".github/actions/rustup/",
];

export const collectorScenarios: ReadonlyArray<string> = [
  "hosted.spec.ts",
  "telemetry-store-bound.spec.ts",
  "telemetry-backpressure.spec.ts",
  "idle-poll-traces.spec.ts",
  "telemetry-viewer.spec.ts",
  "telemetry-partial-trace.spec.ts",
];

export const collectorChanged = (files: ReadonlyArray<string>) =>
  files.some((file) =>
    collectorInputs.some((input) =>
      input.endsWith("/") ? file.startsWith(input) : file === input,
    ),
  );
