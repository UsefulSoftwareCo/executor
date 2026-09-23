import type { RegistryError } from "@executor-js/app-registry/contracts";
/** Safe messages for expected public registry failures. */
export const registryErrorMessage = (error: RegistryError) =>
  ({
    "not-found": "This public app is no longer listed. Existing installed copies are unchanged.",
    forbidden: "This publishing name belongs to another organization.",
    conflict:
      "Another app already uses this publishing name. Choose a different name in package.json.",
    changed: "The published app changed. Return to Add app and review the current revision.",
    "invalid-source":
      "Check the source files. Credential files and generated dependencies cannot be published.",
    "invalid-manifest": "Publishing needs a scoped name in package.json, such as @team/my-app.",
    "unsupported-dependencies":
      "Executor app dependencies are not supported yet. Include the required app source directly; normal npm dependencies are supported.",
    storage: "The published source could not be read. Try again.",
    registry: "The app registry could not be reached. Try again.",
    limit: "The published app exceeds the supported source size.",
  })[error.reason];
