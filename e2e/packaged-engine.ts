/**
 * The released-image scenarios of the image's packaged workflow engine, and what makes that
 * engine differ from the one the source lanes run.
 *
 * The image declares its engine in `apps/hosted/self-host/scripts/package-runtime.ts`, which only
 * its Dockerfile runs: the Alchemy runtime's workflow worker as an `Engine` Durable Object, on
 * Executor's build of workerd pinned in `workerd.json`, reached through the image's own host
 * (`worker.ts`'s workflow callbacks and the SDK's binding host), under its own process supervisor
 * (`native/`, `entrypoint.sh`). The source lanes run the SDK's
 * `workerdApps` declaration on the workerd npm package instead (`src/main.ts` for self-host, the
 * local product's server for local), so only the image's suite meets the packaged engine.
 *
 * A pull request runs these scenarios when it changes one of `packagedEngineInputs`, a file only
 * they import, or the Alchemy runtime's pin or patch (`e2e/ci-selection.ts` compares that with
 * main); the release lane runs the rest of the image's suite otherwise. Main's paced check and
 * every release run the whole suite: `e2e/docker-release.config.ts` leaves these out only when the
 * lane says so. The engine's behaviour itself is proved from source by the local engine scenarios
 * and `workflow-durability.spec.ts`, which the runtime's patch guard runs.
 */
export const packagedEngineSpecs = [
  "e2e/tests/docker-release-workflow-idle-window.spec.ts",
  "e2e/tests/docker-release-workflow-memory.spec.ts",
  "e2e/tests/docker-release-workflow-restart.spec.ts",
  "e2e/tests/docker-release-workflow-sleeping.spec.ts",
  "e2e/tests/docker-release-workflow-stopped.spec.ts",
  "e2e/tests/workflow-engine.spec.ts",
] as const;

/** The files that make the image's engine differ from the source lanes' engine. */
export const packagedEngineInputs = [
  // The engine's declaration in the image's workerd configuration, and its packaging.
  "apps/hosted/self-host/scripts/package-runtime.ts",
  // Builds the image and runs that script; its base images pin the host's Node, Bun and Debian.
  "apps/hosted/self-host/Dockerfile",
  // Executor's build of workerd that runs the engine in the image.
  "apps/hosted/self-host/workerd.json",
  // The image's host side of the engine: the workflow callbacks the engine calls, and the binding
  // host that starts, reads and ends runs. The source lanes run neither.
  "apps/hosted/self-host/src/worker.ts",
  "packages/sdk/src/implementation/binding-workerd-apps.ts",
  // The image's process supervisor and entrypoint: they start workerd with its memory settings
  // and stop it on a container stop, which the restart, stopped, sleeping, idle-window and memory
  // scenarios exercise. No source lane runs them.
  "apps/hosted/self-host/native/**",
  "apps/hosted/self-host/entrypoint.sh",
  // How the lane chooses them.
  "e2e/packaged-engine.ts",
] as const;

/** The dependency whose workflow worker the image packages as its engine. */
export const packagedEngineDependency = "@alchemy.run/cloudflare-runtime";

/**
 * `e2e/docker-release.config.ts` leaves `packagedEngineSpecs` out only when this variable has
 * this value, which only CI's release-docker lane sets, when the pull request changes none of
 * their inputs.
 */
export const packagedEngineVariable = "EXECUTOR_E2E_PACKAGED_ENGINE";
export const packagedEngineUnchanged = "unchanged";
