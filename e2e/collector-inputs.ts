/**
 * What the Rust telemetry collector's build reads, so the select job can tell whether a run needs
 * `collector-native` (e2e/ci-selection.ts). The list belongs to the collector's build: when it
 * starts reading another file or directory, add it here, one line, with a case beside the others
 * in e2e/tests/ci-selection.spec.ts ("collector-native runs ..."). An entry ending in `/` is a
 * directory and everything under it; any other entry is one file.
 */
export const collectorInputs: ReadonlyArray<string> = [
  "packages/telemetry/collector/",
  // The release build, check and smoke test collector-native runs, and the actions it runs them
  // through.
  "packages/telemetry/scripts/build-collector.ts",
  ".github/actions/collector/",
  ".github/actions/rustup/",
];

/**
 * The spec files that exercise the collector through the product and the harness: a pull request
 * that changes a collector input runs them, whatever its `e2e` block names (e2e/ci-selection.ts).
 * The local server, the self-host image and the e2e harness all start the collector these inputs
 * build, so a crate change reaches every scenario that reads telemetry; these are the ones whose
 * subject is the collector itself.
 */
export const collectorScenarios: ReadonlyArray<string> = [
  // The product's own spans reaching the image's collector, through the host.
  "hosted.spec.ts",
  // Retention at the store's bound, with the collector's own figures.
  "telemetry-store-bound.spec.ts",
  // Exports refused and resent through a scenario's own collector.
  "telemetry-backpressure.spec.ts",
  // What an idle server exports, read back from a scenario's own collector.
  "idle-poll-traces.spec.ts",
  // The viewer the local collector serves.
  "telemetry-viewer.spec.ts",
  // A trace answered in part, read through the suite's own span reader.
  "telemetry-partial-trace.spec.ts",
];

/** Whether any of `files`, paths from the repository root, is a collector input. */
export const collectorChanged = (files: ReadonlyArray<string>) =>
  files.some((file) =>
    collectorInputs.some((input) =>
      input.endsWith("/") ? file.startsWith(input) : file === input,
    ),
  );
