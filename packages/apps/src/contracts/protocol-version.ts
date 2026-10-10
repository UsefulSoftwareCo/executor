/**
 * The host protocol this framework speaks. It is written into `runtime.json` and every host
 * snapshot. Its schemas are `protocols/current.ts`; released protocols are frozen. See notes/apps-publishing.md.
 * This file has no imports so the package build script can read it directly.
 */
export const frameworkProtocol = 12;
