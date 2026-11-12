/**
 * An MCP failure's summary line ends with the phase it stopped and the trace of the request that
 * met it, which differs on every request. `mcp-failure-reference.spec.ts` checks both.
 */
const site = / Phase: (?:evaluate|discover|call)\. Reference: [0-9a-f]{32}\.$/u;

/** The summary line without its phase and reference; a line without them fails the check. */
export const siteless = (message: string): string => {
  if (!site.test(message)) throw new Error(`The failure names no phase and reference: ${message}`);
  return message.replace(site, "");
};
