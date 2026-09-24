/** Split and rejoin SKILL.md so edits change only the body and the fields a person edited. */
import { parseDocument } from "yaml";

/** Same delimiter rule as the skill loader in `apps`. */
const frontmatterPattern = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|[ \t]*$)/;

export interface SkillDocumentParts {
  /** The exact frontmatter block including delimiters, or "" when the file has none. */
  readonly frontmatter: string;
  readonly body: string;
}

export const splitSkillDocument = (content: string): SkillDocumentParts => {
  const match = frontmatterPattern.exec(content);
  return match === null
    ? { frontmatter: "", body: content }
    : { frontmatter: match[0], body: content.slice(match[0].length) };
};

/** Read the description a person can edit; the loader already validated the rest. */
export const skillDescription = (frontmatter: string): string => {
  const yaml = frontmatterYaml(frontmatter);
  const value = yaml === undefined ? undefined : parseDocument(yaml).get("description");
  return typeof value === "string" ? value : "";
};

/** Replace only the description, keeping key order, comments and every other value's formatting. */
export const withSkillDescription = (frontmatter: string, description: string): string => {
  if (skillDescription(frontmatter) === description) return frontmatter;
  const yaml = frontmatterYaml(frontmatter);
  if (yaml === undefined) return frontmatter;
  const document = parseDocument(yaml);
  document.set("description", description);
  const newline = frontmatter.includes("\r\n") ? "\r\n" : "\n";
  const serialized = document
    .toString({ lineWidth: 0 })
    .replace(/\r?\n$/, "")
    .replace(/\r?\n/g, newline);
  return `${frontmatter.startsWith("﻿") ? "﻿" : ""}---${newline}${serialized}${newline}---${newline}`;
};

export const joinSkillDocument = ({ frontmatter, body }: SkillDocumentParts): string =>
  frontmatter + body;

const frontmatterYaml = (frontmatter: string) => frontmatterPattern.exec(frontmatter)?.[1];
