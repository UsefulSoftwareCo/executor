export type CodeLanguage =
  | "typescript"
  | "javascript"
  | "css"
  | "markdown"
  | "html"
  | "json"
  | "shellscript"
  | "text";

export function codeLanguage(path: string): CodeLanguage {
  if (/\.[cm]?tsx?$/.test(path)) return "typescript";
  if (/\.[cm]?jsx?$/.test(path)) return "javascript";
  if (path.endsWith(".css")) return "css";
  if (/\.(md|markdown)$/.test(path)) return "markdown";
  if (/\.html?$/.test(path)) return "html";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".sh")) return "shellscript";
  return "text";
}

export function fenceLanguage(info: string): CodeLanguage {
  const name = info.toLowerCase();
  if (["ts", "tsx", "mts", "cts", "typescript"].includes(name)) return "typescript";
  if (["js", "jsx", "mjs", "cjs", "javascript"].includes(name)) return "javascript";
  if (name === "css") return "css";
  if (["md", "markdown"].includes(name)) return "markdown";
  if (["html", "htm"].includes(name)) return "html";
  if (["json", "jsonc"].includes(name)) return "json";
  if (["sh", "bash", "shell", "shellscript", "zsh", "console"].includes(name)) return "shellscript";
  return "text";
}
