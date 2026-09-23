/** Read Bearer metadata without mistaking another scheme's parameters for Bearer. */
export const bearerResourceMetadata = (header: string | undefined): string | undefined => {
  if (header === undefined) return undefined;
  const parts: string[] = [];
  let part = "";
  let quoted = false;
  let escaped = false;
  for (const character of header) {
    if (escaped) {
      part += character;
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      part += character;
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (character === "," && !quoted) {
      parts.push(part.trim());
      part = "";
    } else part += character;
  }
  if (quoted || escaped) return undefined;
  parts.push(part.trim());
  let scheme: string | undefined;
  let metadata: string | undefined;
  for (const part of parts) {
    if (!part) continue;
    // A new scheme is separated from its first parameter by whitespace.
    const challenge = /^[!#$%&'*+.^_`|~A-Za-z0-9-]+[ \t]*=/.test(part)
      ? null
      : /^([!#$%&'*+.^_`|~A-Za-z0-9-]+)(?:[ \t]+(.*))?$/.exec(part);
    const parameter = challenge ? challenge[2] : part;
    if (challenge) scheme = challenge[1]?.toLowerCase();
    if (parameter === undefined) continue;
    const field = /^([!#$%&'*+.^_`|~A-Za-z0-9-]+)[ \t]*=[ \t]*("(?:\\.|[^"\\])*"|[^\s,"]+)$/.exec(
      parameter,
    );
    if (!field) {
      scheme = undefined;
      continue;
    }
    if (scheme !== "bearer" || field[1]?.toLowerCase() !== "resource_metadata") continue;
    const raw = field[2];
    if (raw === undefined || metadata !== undefined) return undefined;
    metadata = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
  }
  return metadata;
};
