import type { SchemaIssue } from "effect";

const segment = (key: PropertyKey) =>
  typeof key === "number" ? `[${key}]` : `.${String(key).slice(0, 64)}`;

export const issueSummary = (issue: SchemaIssue.Issue, path = "$"): ReadonlyArray<string> => {
  switch (issue._tag) {
    case "Pointer":
      return issueSummary(issue.issue, path + issue.path.map(segment).join(""));
    case "Encoding":
      return issueSummary(issue.issue, path);
    case "Composite":
      return issue.issues.flatMap((inner) => issueSummary(inner, path));
    case "AnyOf":
      return issue.issues.length === 0
        ? [`${path}: AnyOf`]
        : issue.issues.flatMap((inner) => issueSummary(inner, path));
    default:
      return [`${path}: ${issue._tag}`];
  }
};
