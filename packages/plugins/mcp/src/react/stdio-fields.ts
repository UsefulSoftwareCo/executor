// ---------------------------------------------------------------------------
// Text ↔ config codecs for the stdio fields, shared by the add flow
// (`AddMcpIntegration`) and the edit sheet (`EditMcpIntegration`). Both render
// the same single-line arguments field and the same KEY=value environment
// block, so the parsing lives in one place and round-trips: a config that is
// formatted and re-parsed is unchanged.
// ---------------------------------------------------------------------------

/** Split the raw arguments field into tokens, honoring double-quoted groups so
 *  an argument with spaces stays intact. */
export function parseStdioArgs(raw: string): string[] {
  if (!raw.trim()) return [];
  const args: string[] = [];
  const regex = /[^\s"]+|"([^"]*)"/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    args.push(match[1] ?? match[0]);
  }
  return args;
}

/** Render stored arguments back into the single-line field, re-quoting any
 *  token that contains whitespace so `parseStdioArgs` recovers it. */
export function formatStdioArgs(args: readonly string[] | undefined): string {
  return (args ?? []).map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
}

/** Parse the KEY=value block into the declared static env map. Splits on the
 *  FIRST `=` only, so a value may itself contain `=`. Blank lines, `#`
 *  comments, and lines without a key are dropped; an empty value is kept
 *  (declaring a variable as empty is meaningful to a subprocess). */
export function parseStdioEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (key === "") continue;
    env[key] = trimmed.slice(separator + 1).trim();
  }
  return env;
}

/** Render the stored env map back into the KEY=value block. */
export function formatStdioEnv(env: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}
