import { join } from "node:path";

import { writeJsonAtomicSync } from "./artifact-io";
import {
  projectDefinition,
  visualDataClassificationForProject,
  type VisualDataClassification,
} from "./project-matrix";

export const LANE_PROVENANCE_FILE = "lane-provenance.json";

export interface LaneProvenance {
  readonly schemaVersion: 1;
  readonly source: "e2e/src/project-matrix.ts";
  readonly project: string;
  readonly target: string;
  readonly hermetic: boolean;
  readonly dataClassification: VisualDataClassification;
}

export interface VisualEvidenceDeclaration {
  readonly dataClassification: VisualDataClassification;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const laneProvenanceFor = (
  projectName: string,
  target: string,
): LaneProvenance | undefined => {
  const project = projectDefinition(projectName);
  const dataClassification = visualDataClassificationForProject(projectName);
  if (!project || !dataClassification || project.target !== target) return undefined;
  return {
    schemaVersion: 1,
    source: "e2e/src/project-matrix.ts",
    project: project.name,
    target: project.target,
    hermetic: project.hermetic,
    dataClassification,
  };
};

export const laneProvenanceForEnvironment = (
  target: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
) => laneProvenanceFor(env.E2E_PROJECT ?? env.E2E_TARGET ?? "", target);

export const parseLaneProvenance = (
  value: unknown,
  trustedProject: string,
  expectedTarget: string,
): LaneProvenance | undefined => {
  if (!record(value)) return undefined;
  if (
    value.schemaVersion !== 1 ||
    value.source !== "e2e/src/project-matrix.ts" ||
    typeof value.project !== "string" ||
    typeof value.target !== "string" ||
    typeof value.hermetic !== "boolean" ||
    (value.dataClassification !== "synthetic-only" &&
      value.dataClassification !== "potentially-sensitive")
  ) {
    return undefined;
  }
  const expected = laneProvenanceFor(trustedProject, expectedTarget);
  if (
    !expected ||
    value.project !== expected.project ||
    value.target !== expected.target ||
    expected.hermetic !== value.hermetic ||
    expected.dataClassification !== value.dataClassification
  ) {
    return undefined;
  }
  return expected;
};

export const writeRunLaneProvenance = (
  runDir: string,
  target: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const provenance = laneProvenanceForEnvironment(target, env);
  if (!provenance) return undefined;
  writeJsonAtomicSync(join(runDir, LANE_PROVENANCE_FILE), provenance);
  return provenance;
};

const visualEvidenceDeclaration = (value: unknown): VisualEvidenceDeclaration | undefined => {
  if (!record(value) || !record(value.visualEvidence)) return undefined;
  const dataClassification = value.visualEvidence.dataClassification;
  if (dataClassification !== "synthetic-only" && dataClassification !== "potentially-sensitive") {
    return undefined;
  }
  return { dataClassification };
};

export type VisualEvidencePublicationDecision =
  | { readonly publish: true; readonly provenance: LaneProvenance }
  | { readonly publish: false; readonly reason: string };

export const visualEvidencePublicationDecision = (
  result: unknown,
  laneProvenance: unknown,
  expectedTarget: string,
  trustedProject: string,
): VisualEvidencePublicationDecision => {
  if (!trustedProject) {
    return { publish: false, reason: "trusted lane project is missing" };
  }
  const provenance = parseLaneProvenance(laneProvenance, trustedProject, expectedTarget);
  if (!provenance) {
    return {
      publish: false,
      reason: `lane provenance does not match trusted project ${trustedProject} for target ${expectedTarget}`,
    };
  }
  if (provenance.target !== expectedTarget) {
    return {
      publish: false,
      reason: `lane target ${provenance.target} does not match run target ${expectedTarget}`,
    };
  }
  if (!record(result) || result.target !== provenance.target) {
    return {
      publish: false,
      reason: "result target is missing or does not match lane provenance",
    };
  }
  const declaration = visualEvidenceDeclaration(result);
  if (!declaration) {
    return { publish: false, reason: "result visual classification is missing or invalid" };
  }
  if (declaration.dataClassification !== provenance.dataClassification) {
    return {
      publish: false,
      reason: `result visual classification ${declaration.dataClassification} does not match lane classification ${provenance.dataClassification}`,
    };
  }
  if (provenance.dataClassification !== "synthetic-only") {
    return {
      publish: false,
      reason: `lane ${provenance.project} is ${provenance.dataClassification}`,
    };
  }
  return { publish: true, provenance };
};
