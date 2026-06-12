import { createHighlighterCoreSync, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// ---------------------------------------------------------------------------
// Eagerly loaded languages (sync — available immediately)
// ---------------------------------------------------------------------------

import langTypescript from "@shikijs/langs/typescript";
import langJavascript from "@shikijs/langs/javascript";
import langTsx from "@shikijs/langs/tsx";
import langJsx from "@shikijs/langs/jsx";
import langJson from "@shikijs/langs/json";
import langShellscript from "@shikijs/langs/shellscript";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";

// ---------------------------------------------------------------------------
// Lazily loaded languages — imported on first use
// ---------------------------------------------------------------------------

const SUPPORTED_LANGS = [
  "json",
  "xml",
  "yaml",
  "shellscript",
  "typescript",
  "javascript",
  "python",
  "html",
  "css",
  "markdown",
  "sql",
  "graphql",
  "go",
  "rust",
  "java",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "c",
  "cpp",
  "csharp",
  "tsx",
  "jsx",
  "toml",
  "dockerfile",
  "diff",
  "http",
  "jsonc",
  "log",
  "proto",
] as const;

type SupportedLang = (typeof SUPPORTED_LANGS)[number];

const LANG_ALIASES: Record<string, SupportedLang> = {
  sh: "shellscript",
  shell: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ts: "typescript",
  js: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  kt: "kotlin",
  md: "markdown",
  gql: "graphql",
  yml: "yaml",
};

const LAZY_LANG_LOADERS: Partial<Record<SupportedLang, () => Promise<unknown>>> = {
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
  python: () => import("@shikijs/langs/python"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  markdown: () => import("@shikijs/langs/markdown"),
  sql: () => import("@shikijs/langs/sql"),
  graphql: () => import("@shikijs/langs/graphql"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  java: () => import("@shikijs/langs/java"),
  ruby: () => import("@shikijs/langs/ruby"),
  php: () => import("@shikijs/langs/php"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  toml: () => import("@shikijs/langs/toml"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  diff: () => import("@shikijs/langs/diff"),
  http: () => import("@shikijs/langs/http"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  log: () => import("@shikijs/langs/log"),
  proto: () => import("@shikijs/langs/proto"),
};

const supportedSet = new Set<string>([...SUPPORTED_LANGS, ...Object.keys(LANG_ALIASES)]);

export const SUPPORTED_THEMES = ["github-dark", "github-light"] as const;
export type SupportedTheme = (typeof SUPPORTED_THEMES)[number];

export const DEFAULT_LIGHT_THEME: SupportedTheme = "github-light";
export const DEFAULT_DARK_THEME: SupportedTheme = "github-dark";

export type ShikiThemeProp = SupportedTheme | { light: SupportedTheme; dark: SupportedTheme };

/**
 * Resolve a `ShikiThemeProp` to the `{ light, dark }` pair handed to shiki's
 * dual-theme mode. A single theme means "this theme in BOTH modes".
 *
 * Dual-theme + `light-dark()` colors is what keeps highlighting correct from
 * the FIRST frame: the rendered markup carries both palettes and the
 * browser's own color-scheme picks one — no JS dark-mode probe, so an SSR'd
 * page can't paint light-theme tokens and then snap once `useIsDark` syncs.
 */
export function resolveShikiThemes(theme?: ShikiThemeProp): {
  light: SupportedTheme;
  dark: SupportedTheme;
} {
  if (typeof theme === "string") return { light: theme, dark: theme };
  return {
    light: theme?.light ?? DEFAULT_LIGHT_THEME,
    dark: theme?.dark ?? DEFAULT_DARK_THEME,
  };
}

/** The shiki options that render dual-theme `light-dark(...)` colors. */
export const dualThemeOptions = (theme?: ShikiThemeProp) => ({
  themes: resolveShikiThemes(theme),
  defaultColor: "light-dark()" as const,
});

export function resolveLang(lang: string): SupportedLang | null {
  const l = lang.trim().toLowerCase();
  if (supportedSet.has(l)) {
    if (l in LANG_ALIASES) return LANG_ALIASES[l]!;
    return l as SupportedLang;
  }
  return null;
}

export function isSupportedLang(lang: string): boolean {
  return supportedSet.has(lang.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Shared singleton highlighter — synchronous, created eagerly with core langs
// ---------------------------------------------------------------------------

const highlighter: HighlighterCore = createHighlighterCoreSync({
  themes: [githubDark, githubLight],
  langs: [langTypescript, langJavascript, langTsx, langJsx, langJson, langShellscript],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});

export function getHighlighter(): HighlighterCore {
  return highlighter;
}

/**
 * Ensure a language is loaded into the highlighter. Returns true if the
 * language is ready for synchronous use, false if it needs to be loaded
 * asynchronously (in which case `onLoaded` will be called when ready).
 */
const loadingLangs = new Set<string>();

export function ensureLang(lang: SupportedLang, onLoaded?: () => void): boolean {
  const loaded = highlighter.getLoadedLanguages();
  if (loaded.includes(lang)) return true;

  const loader = LAZY_LANG_LOADERS[lang];
  if (!loader) return true; // Not a lazy lang, must be already loaded

  if (!loadingLangs.has(lang)) {
    loadingLangs.add(lang);
    void loader().then((mod: any) => {
      const registration = mod.default ?? mod;
      highlighter.loadLanguageSync(registration);
      loadingLangs.delete(lang);
      onLoaded?.();
    });
  } else if (onLoaded) {
    const l = loader;
    void l().then((mod: any) => {
      const registration = mod.default ?? mod;
      if (!highlighter.getLoadedLanguages().includes(lang)) {
        highlighter.loadLanguageSync(registration);
      }
      onLoaded();
    });
  }
  return false;
}

// ---------------------------------------------------------------------------
// Streamdown code highlighter plugin
// ---------------------------------------------------------------------------

import type { CodeHighlighterPlugin, ThemeInput } from "streamdown";

type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;
const tokensCache = new Map<string, HighlightResult>();

export function createCodeHighlighterPlugin(): CodeHighlighterPlugin {
  return {
    name: "shiki" as const,
    type: "code-highlighter" as const,
    getSupportedLanguages: () => [...SUPPORTED_LANGS],
    getThemes: () => [DEFAULT_LIGHT_THEME as ThemeInput, DEFAULT_DARK_THEME as ThemeInput],
    supportsLanguage: (language: string) => isSupportedLang(language),
    highlight(options, callback) {
      const resolved = resolveLang(options.language);
      const lang = resolved ?? "json";
      // Dual-theme tokens (light-dark() colors): correct in both color
      // schemes, so the cache never holds the wrong palette and a mid-stream
      // scheme flip needs no re-render.
      const key = `${lang}:${options.code.length}:${options.code.slice(0, 128)}`;

      const cached = tokensCache.get(key);
      if (cached) return cached;

      const isReady = ensureLang(lang, () => {
        // Language just loaded — highlight and notify via callback
        const result = highlighter.codeToTokens(options.code, { lang, ...dualThemeOptions() });
        tokensCache.set(key, result);
        callback?.(result);
      });

      if (!isReady) return null;

      const result = highlighter.codeToTokens(options.code, { lang, ...dualThemeOptions() });
      tokensCache.set(key, result);
      return result;
    },
  };
}
