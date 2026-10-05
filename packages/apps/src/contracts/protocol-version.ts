/**
 * The host protocol this framework speaks. It is written into `runtime.json` and every host
 * snapshot. Released protocols are frozen: see `protocols/8.ts` and notes/apps-publishing.md.
 * This file has no imports so the package build script can read it directly.
 */
export const frameworkProtocol = 8;
