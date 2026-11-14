/** Schema decoding failures described without the values that failed. */
import type { SchemaIssue } from "effect";

const segment = (key: PropertyKey) =>
  typeof key === "number" ? `[${key}]` : `.${String(key).slice(0, 64)}`;

/** Issue locations and categories only. Values, messages and annotations can echo the input. */
export const issueSummary = (issue: SchemaIssue.Issue, path = "$"): ReadonlyArray<string> => {
  switch (issue._tag) {
    case "Pointer":
      return issueSummary(issue.issue, path + issue.path.map(segment).join(""));
    case "Encoding":
      return issueSummary(issue.issue, path);
    case "Composite":
      return issue.issues.flatMap((inner) => issueSummary(inner, path));
    // A union lists why each member rejected the value.
    case "AnyOf":
      return issue.issues.length === 0
        ? [`${path}: AnyOf`]
        : issue.issues.flatMap((inner) => issueSummary(inner, path));
    default:
      return [`${path}: ${issue._tag}`];
  }
};
