import { Schema, SchemaIssue } from "effect";
import { HostInputInvalid, maxInputProblems } from "../contracts/host.ts";

// Reported input only exists when a parser opts in; never render it either way.
const leafHook: SchemaIssue.LeafHook = (issue) =>
  SchemaIssue.hasInput(issue) ? "Invalid value" : SchemaIssue.defaultLeafHook(issue);
const checkHook: SchemaIssue.CheckHook = (issue) =>
  SchemaIssue.hasInput(issue) || SchemaIssue.hasInput(issue.issue)
    ? (SchemaIssue.defaultCheckHook(issue) ?? "Invalid value")
    : SchemaIssue.defaultCheckHook(issue);
const format = SchemaIssue.makeFormatterStandardSchemaV1({ leafHook, checkHook });

// Declared field names and indexes locate the problem; other keys are not echoed.
const segment = (key: PropertyKey) =>
  typeof key === "number"
    ? `[${key}]`
    : typeof key === "string" && /^[A-Za-z_$][\w$-]{0,63}$/.test(key)
      ? `.${key}`
      : "[key]";

/** Failing input paths and expected shapes from a schema decode failure, without supplied values. */
export const inputInvalid = (error: unknown): HostInputInvalid => {
  if (!Schema.isSchemaError(error)) return new HostInputInvalid();
  const problems = format(error.issue)
    .issues.slice(0, maxInputProblems)
    .map(({ path, message }) => {
      const location = (path ?? []).map((key) => segment(typeof key === "object" ? key.key : key));
      return `${location.length === 0 ? "input" : `input${location.join("")}`}: ${message}`.slice(
        0,
        512,
      );
    });
  return new HostInputInvalid({ problems });
};
