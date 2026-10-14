import type { RegistryError } from "@executor-js/sdk";
/** Safe messages for expected public registry failures. */
export const registryErrorMessage = (error: RegistryError) =>
  ({
    "not-found": "This public app is no longer listed. Existing installed copies are unchanged.",
    forbidden: "This package name is not in this organization’s current publishing scope.",
    conflict:
      "Another app already uses this publishing name. Choose a different name in package.json.",
    changed: "The published app changed. Return to Add app and review the current revision.",
    "invalid-source":
      "Check the source files. Credential files and generated dependencies cannot be published.",
    "invalid-manifest":
      "Publishing needs a scoped name in package.json, such as @team.executor.community/my-app.",
    storage: "The published source could not be read. Try again.",
    network: "The app registry could not be reached. Check the network connection and try again.",
    status: "The app registry returned an unexpected response. Try again later.",
    "invalid-response": "The app registry returned an invalid response. Try again later.",
    limit: "The published app exceeds the supported source size.",
    unsupported: "This Executor reads a remote registry and cannot publish.",
  })[error.reason];
