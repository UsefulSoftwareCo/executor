export const packagedEngineSpecs = [
  "e2e/tests/docker-release-workflow-idle-window.spec.ts",
  "e2e/tests/docker-release-workflow-memory.spec.ts",
  "e2e/tests/docker-release-workflow-restart.spec.ts",
  "e2e/tests/docker-release-workflow-sleeping.spec.ts",
  "e2e/tests/docker-release-workflow-stopped.spec.ts",
  "e2e/tests/workflow-engine.spec.ts",
] as const;

export const packagedEngineInputs = [
  "apps/hosted/self-host/scripts/package-runtime.ts",
  "apps/hosted/self-host/Dockerfile",
  "apps/hosted/self-host/workerd.json",
  "apps/hosted/self-host/src/worker.ts",
  "packages/sdk/src/implementation/binding-workerd-apps.ts",
  "apps/hosted/self-host/native/**",
  "apps/hosted/self-host/entrypoint.sh",
  "packages/telemetry/collector/**",
  "packages/telemetry/scripts/build-collector.ts",
  "e2e/packaged-engine.ts",
] as const;

export const packagedEngineDependency = "@alchemy.run/cloudflare-runtime";

export const packagedEngineVariable = "EXECUTOR_E2E_PACKAGED_ENGINE";
export const packagedEngineUnchanged = "unchanged";
