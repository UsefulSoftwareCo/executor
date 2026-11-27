import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogPages } from "./changelog.ts";
import { cliPages } from "./cli.ts";
import { wordCount, type Page } from "./markdown.ts";
import { mcpPages } from "./mcp.ts";
import { selfHostPage } from "./self-host.ts";
import { skillPages } from "./skills.ts";
import { referenceRelease, type ReferenceRelease } from "./release.ts";

const content = fileURLToPath(new URL("../content", import.meta.url));
const manifest = new URL("pages.json", import.meta.url);

function renderReference({
  version,
  framework,
  cli,
  mcp,
  selfHost,
  skills,
  notes,
}: ReferenceRelease) {
  const rendered: Page[] = [
    ...cliPages(version, (path) => {
      const help = cli[path.join(" ")];
      if (help === undefined)
        throw new Error(`Missing released help for executor ${path.join(" ")}`);
      return help;
    }),
    selfHostPage(version, selfHost),
    ...mcpPages(version, mcp),
    ...skillPages(version, framework, skills),
    ...changelogPages(version, notes),
  ];
  const pages = new Map<string, string>();
  for (const { route, title, description, body } of rendered) {
    if (wordCount(body) > 1800)
      throw new Error(`${route} has ${wordCount(body)} words. Split it into shorter pages.`);
    if (body.includes("<!--")) throw new Error(`${route} contains an HTML comment`);
    if (pages.has(route)) throw new Error(`Duplicate reference page ${route}`);
    pages.set(
      route,
      `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`,
    );
  }
  return pages;
}

export function generateReference(release: ReferenceRelease, mode: "build" | "check" | "update") {
  const pages = renderReference(release);
  const hashes = Object.fromEntries(
    [...pages]
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([route, text]) => [route, createHash("sha256").update(text).digest("hex")]),
  );
  const { version, source, exportCommit } = release;
  const lock = JSON.stringify({ version, source, exportCommit, pages: hashes }, null, 2) + "\n";
  if (mode !== "update" && (!existsSync(manifest) || readFileSync(manifest, "utf8") !== lock))
    throw new Error(
      "Reference pages are stale. For renderer changes, run bun apps/docs/reference/generate.ts --update. " +
        "To move the release pin, run bun apps/docs/reference/capture.ts <published-version>. " +
        "Review the changes in apps/docs/reference/.",
    );

  const check = mode === "check";
  const generated = [
    "reference/cli",
    "reference/self-host-env",
    "reference/mcp",
    "reference/skills",
    "changelog",
  ].flatMap((name) => {
    const directory = join(content, name);
    const nested = existsSync(directory)
      ? readdirSync(directory, { recursive: true, encoding: "utf8" })
          .filter((file) => file.endsWith(".md"))
          .map((file) => `${name}/${file}`)
      : [];
    const index = `${name}.md`;
    return existsSync(join(content, index)) ? [index, ...nested] : nested;
  });
  for (const file of generated) {
    const path = join(content, file);
    if (pages.has("/" + file.slice(0, -3))) continue;
    if (check) throw new Error(`Stale generated file ${file}`);
    rmSync(path, { force: true });
  }
  for (const [route, text] of pages) {
    const path = join(content, `${route.slice(1)}.md`);
    if (check) {
      if (!existsSync(path) || readFileSync(path, "utf8") !== text)
        throw new Error(`Stale generated file ${route}.md. Run bun run docs:build.`);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }
  if (mode === "update") writeFileSync(manifest, lock);
  console.log(`${check ? "Checked" : "Generated"} ${pages.size} Executor reference pages.`);
}

if (import.meta.main) {
  const mode = process.argv.includes("--update")
    ? "update"
    : process.argv.includes("--check")
      ? "check"
      : "build";
  generateReference(referenceRelease, mode);
}
