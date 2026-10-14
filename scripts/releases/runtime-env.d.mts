/** Types for runtime-env.mjs, which the npm package and desktop import as plain JavaScript. */
export declare function packagedRuntimeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  gitDirectory?: string,
): Record<string, string | undefined>;
