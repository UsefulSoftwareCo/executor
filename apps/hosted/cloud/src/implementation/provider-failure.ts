/** Classify native provider failures without recording messages, object keys or payloads. */
export const providerFailureCode = (error: unknown): string => {
  if (!(error instanceof Error)) return "non_error";
  const message = error.message;
  const instance = /instance\.[a-z_]+/.exec(message)?.[0];
  if (instance !== undefined) return instance;
  const r2 = /\((\d{4,5})\)\s*$/.exec(message)?.[1];
  if (r2 !== undefined) return `r2.${r2}`;
  if (/internal error/i.test(message)) return "internal";
  if (/overloaded|too many requests|rate.?limit/i.test(message)) return "overloaded";
  if (/exceeded memory|memory limit/i.test(message)) return "memory_limit";
  if (/exceeded cpu|cpu time limit/i.test(message)) return "cpu_limit";
  if (/reset|restarted/i.test(message)) return "reset";
  if (/disconnected|network connection lost/i.test(message)) return "disconnected";
  if (/timed out|timeout/i.test(message)) return "timeout";
  return "unclassified";
};
