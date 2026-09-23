/** Shared browser-build planning. Hosts supply their own compiler and retained storage. */
export type { UiBuildEntry, UiBuildFile, UiBuildPlan } from "./contracts/ui-build.ts";
export {
  prepareUiBuild,
  uiContentType,
  isBrowserAppImport,
  isServerUiImport,
} from "./implementation/ui-build.ts";
