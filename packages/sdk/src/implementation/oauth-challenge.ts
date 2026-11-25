export const bearerChallenge = (
  header: string | undefined,
):
  | {
      readonly resourceMetadata?: string;
      readonly scopes?: readonly string[];
    }
  | undefined => {
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
  let scope: string | undefined;
  let bearers = 0;
  for (const part of parts) {
    if (!part) continue;
    const challenge = /^[!#$%&'*+.^_`|~A-Za-z0-9-]+[ \t]*=/.test(part)
      ? null
      : /^([!#$%&'*+.^_`|~A-Za-z0-9-]+)(?:[ \t]+(.*))?$/.exec(part);
    const parameter = challenge ? challenge[2] : part;
    if (challenge) {
      scheme = challenge[1]?.toLowerCase();
      if (scheme === "bearer" && ++bearers > 1) return undefined;
    }
    if (parameter === undefined) continue;
    const field = /^([!#$%&'*+.^_`|~A-Za-z0-9-]+)[ \t]*=[ \t]*("(?:\\.|[^"\\])*"|[^\s,"]+)$/.exec(
      parameter,
    );
    if (!field) {
      scheme = undefined;
      continue;
    }
    if (scheme !== "bearer") continue;
    const name = field[1]?.toLowerCase();
    if (name !== "resource_metadata" && name !== "scope") continue;
    const raw = field[2];
    if (raw === undefined) return undefined;
    const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
    if (name === "resource_metadata") {
      if (metadata !== undefined) return undefined;
      metadata = value;
    } else {
      // RFC 6749 scope-token: printable ASCII excluding quote and backslash, joined by spaces.
      if (
        scope !== undefined ||
        !/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(value)
      )
        return undefined;
      scope = value;
    }
  }
  return bearers === 0
    ? undefined
    : {
        ...(metadata === undefined ? {} : { resourceMetadata: metadata }),
        ...(scope === undefined ? {} : { scopes: scope.split(" ") }),
      };
};

export const bearerResourceMetadata = (header: string | undefined): string | undefined =>
  bearerChallenge(header)?.resourceMetadata;
