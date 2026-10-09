/// <reference types="vite/client" />
import type {} from "../contracts/build.ts";

/**
 * The build that rendered this document. The server names it in the document's `executor-build`
 * meta tag; the browser bundle carries no build id, so browser code reads the tag back.
 */
export const documentBuild = (): string | undefined =>
  import.meta.env.SSR
    ? import.meta.env.VITE_EXECUTOR_BUILD
    : document.querySelector<HTMLMetaElement>('meta[name="executor-build"]')?.content;
