// The remote add form probes the endpoint as the user types, so the gate below
// decides which intermediate strings are worth dialling. Every keystroke is a
// prefix of the next one: "h", "ht", "http://a" all parse or fail in ways that
// tell us nothing, and probing them puts the field into a loading state and
// then an error state for a URL the user never meant to submit.

/** Whether `value` looks like a finished MCP endpoint, and so is worth dialling
 *  while the user is still typing. Format-only: it says nothing about whether a
 *  server answers there. */
export const isProbableMcpEndpoint = (value: string): boolean => {
  const trimmed = value.trim();
  if (!URL.canParse(trimmed)) return false;

  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const hostname = url.hostname.toLowerCase();
  // Local development servers have no dot to wait for.
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  // An IPv6 literal arrives bracketed and is complete once it parses.
  if (hostname.startsWith("[")) return true;
  // Otherwise wait for a dot with a label on each side. A bare "example" is
  // still being typed; "example.com" is something we can dial.
  return hostname.includes(".") && !hostname.startsWith(".") && !hostname.endsWith(".");
};
