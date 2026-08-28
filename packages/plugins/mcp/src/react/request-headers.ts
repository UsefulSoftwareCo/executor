// ---------------------------------------------------------------------------
// Static request headers for a remote MCP server.
//
// Some MCP endpoints sit behind an edge authenticator rather than the MCP
// authorization spec — Cloudflare Access, for example, wants a
// `CF-Access-Client-Id` / `CF-Access-Client-Secret` pair on every request and
// answers 403 without them. Those are properties of the ENDPOINT, not of an
// account: every caller sends the same pair, and the server behind them still
// does its own MCP-level auth. They therefore belong in the integration's
// static `headers` config, which the probe and the live transport already
// read, and NOT in an auth method (an auth method carries one per-account
// credential value, so it cannot express a two-part token at all).
//
// The editor keeps rows rather than a map so a half-typed row survives a
// re-render. This module owns the row -> wire conversion.
// ---------------------------------------------------------------------------

export type McpHeaderRow = {
  readonly name: string;
  readonly value: string;
};

export const emptyHeaderRow = (): McpHeaderRow => ({ name: "", value: "" });

/** RFC 7230 `token`: the only characters a header field name may contain.
 *  A name outside this set makes the whole request unsendable, so it is
 *  rejected in the editor instead of being discovered at connect time. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Whether a row's name can be put on the wire. A blank name is not
 *  "invalid" — it is an unfinished row, which the editor leaves alone. */
export const isValidHeaderName = (name: string): boolean => {
  const trimmed = name.trim();
  return trimmed.length === 0 || HEADER_NAME_PATTERN.test(trimmed);
};

/**
 * Collapse editor rows into the wire `headers` map.
 *
 * Blank and malformed names are dropped: the first is a row the user has not
 * finished, the second cannot be sent at all. Names and values are trimmed —
 * RFC 7230 treats surrounding whitespace as no part of a field value, so a
 * token pasted with a trailing newline still works.
 *
 * Returns `undefined` when nothing is configured, so callers omit the field
 * rather than sending an empty object.
 */
export const mcpHeadersFromRows = (
  rows: readonly McpHeaderRow[],
): Record<string, string> | undefined => {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name || !HEADER_NAME_PATTERN.test(name)) continue;
    headers[name] = row.value.trim();
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
};
