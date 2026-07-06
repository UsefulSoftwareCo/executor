import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactStoreConformance } from "../seams/artifact-store.conformance";
import { makeGitArtifactStore } from "./git-artifact-store";

artifactStoreConformance("git", () =>
  makeGitArtifactStore({ root: mkdtempSync(join(tmpdir(), "apps-artifacts-")) }),
);
