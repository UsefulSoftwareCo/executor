import { defineConfig } from "vitest/config";

import { capabilityRequirementMode, E2E_PROJECTS } from "./src/project-matrix";

// Project names select execution policy. E2E_TARGET selects the deployed app.
// Hermetic and live-drift projects can therefore share the exact same target
// factory and global setup without duplicating boot logic.
const projects = E2E_PROJECTS.map((project) => ({
  test: {
    name: project.name,
    include: [...project.include],
    ...("exclude" in project ? { exclude: [...project.exclude] } : {}),
    env: {
      E2E_TARGET: project.target,
      E2E_PROJECT: project.name,
      E2E_PROJECT_TIER: project.tier,
      E2E_PROJECT_HERMETIC: String(project.hermetic),
      E2E_REQUIRED_CAPABILITY_MODE: capabilityRequirementMode(),
      E2E_REQUIRED_CAPABILITIES: project.requiredCapabilities.join(","),
      ...("env" in project ? project.env : {}),
    },
    globalSetup: [...project.globalSetup],
    fileParallelism: project.fileParallelism,
    testTimeout: project.testTimeout,
    hookTimeout: project.hookTimeout,
  },
}));

export default defineConfig({ test: { projects } });
