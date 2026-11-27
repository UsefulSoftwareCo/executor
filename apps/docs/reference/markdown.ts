export interface Page {
  readonly route: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
}

export const code = (value: string) => {
  const fence = "`".repeat(
    1 + Math.max(0, ...[...value.matchAll(/`+/gu)].map(([run]) => run.length)),
  );
  return fence + (value.startsWith("`") ? " " + value + " " : value) + fence;
};

export const block = (language: string, value: string) =>
  `\`\`\`${language}\n${value.trimEnd()}\n\`\`\``;

export const table = (columns: readonly string[], rows: readonly (readonly string[])[]) =>
  [columns, columns.map(() => "---"), ...rows]
    .map(
      (row) =>
        `| ${row.map((cell) => cell.replaceAll("|", "\\|").replaceAll("\n", " ")).join(" | ")} |`,
    )
    .join("\n");

export const pageLink = ({ route, title }: Pick<Page, "route" | "title">) => `[${title}](${route})`;

export function partLinks(parts: readonly Pick<Page, "route" | "title">[], index: number) {
  const previous = parts[index - 1];
  const next = parts[index + 1];
  return [previous && `Previous: ${pageLink(previous)}`, next && `Next: ${pageLink(next)}`]
    .filter(Boolean)
    .join(" · ");
}

export const wordCount = (body: string) => body.trim().split(/\s+/u).length;

export function groups<T>(entries: readonly T[], size: (entry: T) => number, limit: number): T[][] {
  const result: T[][] = [];
  let remaining = 0;
  for (const entry of entries) {
    const words = size(entry);
    if (result.length === 0 || remaining < words) {
      result.push([]);
      remaining = limit;
    }
    result.at(-1)?.push(entry);
    remaining -= words;
  }
  return result;
}
