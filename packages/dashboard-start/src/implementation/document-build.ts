/// <reference types="vite/client" />
import type {} from "../contracts/build.ts";

export const documentBuild = (): string | undefined =>
  import.meta.env.SSR
    ? import.meta.env.VITE_EXECUTOR_BUILD
    : document.querySelector<HTMLMetaElement>('meta[name="executor-build"]')?.content;
