/** The languages supported by the shared code renderer. */
export function codeLanguage(
  path: string,
): "typescript" | "javascript" | "css" | "markdown" | "html" | "json" | "shellscript" | "text" {
  if (/\.[cm]?tsx?$/.test(path)) return "typescript";
  if (/\.[cm]?jsx?$/.test(path)) return "javascript";
  if (path.endsWith(".css")) return "css";
  if (/\.(md|markdown)$/.test(path)) return "markdown";
  if (/\.html?$/.test(path)) return "html";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".sh")) return "shellscript";
  return "text";
}
