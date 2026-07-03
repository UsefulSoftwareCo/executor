import { URLPattern } from "urlpattern-polyfill";

type UrlPatternPolyfillGlobal = Omit<typeof globalThis, "URLPattern"> & {
  URLPattern?: typeof URLPattern;
};

const globals = globalThis as UrlPatternPolyfillGlobal;

globals.URLPattern ??= URLPattern;
