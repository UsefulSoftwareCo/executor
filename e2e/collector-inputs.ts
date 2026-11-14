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

/** Whether any of `files`, paths from the repository root, is a collector input. */
export const collectorChanged = (files: ReadonlyArray<string>) =>
  files.some((file) =>
    collectorInputs.some((input) =>
      input.endsWith("/") ? file.startsWith(input) : file === input,
    ),
  );
