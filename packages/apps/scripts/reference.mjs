/** Generate searchable author contracts from the same TypeScript graph as declarations. */
import ts from "typescript";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const modules = {
  apps: ["src/index.ts", "tools.md"],
  "apps/client": ["src/client.ts", "ui.md"],
  "apps/react": ["src/react.ts", "ui.md"],
  "apps/operations/approval": ["src/approval.ts", "tools.md"],
  "apps/mcp": ["src/mcp.ts", "integrations.md"],
  "apps/mcp/stdio": ["src/mcp-stdio.ts", "integrations.md"],
  "apps/graphql": ["src/graphql.ts", "integrations.md"],
  "apps/openapi": ["src/openapi.ts", "integrations.md"],
  "apps/skills": ["src/skills.ts", "tools.md"],
};
const methods = [
  ["AppCache", "src/contracts/cache.ts", "AppCache", "tools.md"],
  ["OptimisticLocalStore", "src/contracts/optimistic.ts", "OptimisticLocalStore", "ui.md"],
  ["AppMutation", "src/contracts/optimistic.ts", "AppMutation", "ui.md"],
  ["Schema", "src/implementation/schema.ts", "Schema", "tools.md"],
  ["Table", "src/contracts/storage.ts", "Table", "storage.md"],
  ["DatabaseTable", "../app-data/src/implementation/promise.ts", "WriteTable", "storage.md"],
  ["IndexQuery", "../app-data/src/implementation/promise.ts", "Query", "storage.md"],
  ["IndexRange", "../app-data/src/implementation/promise.ts", "IndexRange", "storage.md"],
  ["Provider", "src/contracts/provider.ts", "Provider", "accounts.md"],
  ["WorkflowStep", "src/contracts/workflows.ts", "WorkflowStep", "workflows.md"],
  ["WorkflowControls", "src/contracts/workflows.ts", "WorkflowControls", "workflows.md"],
  ["AppContext", "src/contracts/app.ts", "BoundContext", "tools.md"],
];
const flags =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

/** Produce a deterministic catalog. No app code is imported or executed. */
export async function generateFrameworkReference() {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const exampleDirectory = resolve(root, "../../playground/demo-apps/live-inbox");
  const examplePaths = [
    "index.ts",
    "schema.ts",
    "ui/main.tsx",
    "ui/index.html",
    "ui/style.css",
    "package.json",
  ];
  const exampleFiles = await Promise.all(
    examplePaths.map(async (path) => ({
      path,
      content: await readFile(resolve(exampleDirectory, path), "utf8"),
    })),
  );
  const program = ts.createProgram(
    [
      ...Object.values(modules).map(([file]) => resolve(root, file)),
      ...methods.map(([, file]) => resolve(root, file)),
      ...examplePaths
        .filter((file) => /\.tsx?$/.test(file))
        .map((file) => resolve(exampleDirectory, file)),
    ],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      noEmit: true,
    },
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnostics(diagnostics, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (file) => file,
        getNewLine: () => "\n",
      }),
    );
  const checker = program.getTypeChecker();
  const records = new Map();
  const text = (parts) => ts.displayPartsToString(parts);
  const sourceModule = (file) => {
    const source = program.getSourceFile(resolve(root, file));
    const symbol = source && checker.getSymbolAtLocation(source);
    if (!symbol) throw new Error(`Missing reference module: ${file}`);
    return { source, exports: checker.getExportsOfModule(symbol) };
  };
  const resolveAlias = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const add = (id, symbol, kind, docs, type) => {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) throw new Error(`Missing declaration: ${id}`);
    const signatures =
      kind === "type"
        ? []
        : checker
            .getSignaturesOfType(type, ts.SignatureKind.Call)
            .map((signature) => checker.signatureToString(signature, declaration, flags));
    const definition = kind === "type" ? declaration.getText() : undefined;
    records.set(id, {
      symbol: id,
      kind,
      summary: text(symbol.getDocumentationComment(checker)),
      signatures,
      ...(definition === undefined ? {} : { definition }),
      tags: symbol.getJsDocTags(checker).map((tag) => ({ name: tag.name, text: text(tag.text) })),
      docs,
      source: relative(resolve(root, ".."), declaration.getSourceFile().fileName)
        .split("\\")
        .join("/"),
      related: [],
      examples: ["tools.md", "ui.md", "storage.md"].includes(docs) ? ["live-inbox"] : [],
    });
  };
  const addMethods = (name, type, docs) => {
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) continue;
      const member = checker.getTypeOfSymbolAtLocation(property, declaration);
      if (checker.getSignaturesOfType(member, ts.SignatureKind.Call).length)
        add(`${name}.${property.name}`, property, "method", docs, member);
    }
  };
  for (const [module, [file, docs]] of Object.entries(modules)) {
    for (const exported of sourceModule(file).exports) {
      const symbol = resolveAlias(exported);
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!declaration) continue;
      const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
      if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length) {
        add(`${module}.${exported.name}`, symbol, "function", docs, type);
        if (exported.name === "createAppClient") {
          const [signature] = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
          addMethods("AppClient", checker.getReturnTypeOfSignature(signature), docs);
        }
      } else if (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) {
        add(
          `${module}.${exported.name}`,
          symbol,
          "type",
          docs,
          checker.getDeclaredTypeOfSymbol(symbol),
        );
      }
    }
  }
  for (const [name, file, exported, docs] of methods) {
    const symbol = sourceModule(file).exports.find((symbol) => symbol.name === exported);
    if (!symbol) throw new Error(`Missing method contract: ${name}`);
    addMethods(name, checker.getDeclaredTypeOfSymbol(symbol), docs);
    add(name, symbol, "type", docs, checker.getDeclaredTypeOfSymbol(symbol));
  }
  const entries = [...records.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  for (const entry of entries) {
    const tokens = new Set(
      (entry.signatures.join(" ") + (entry.definition ?? "")).match(/[A-Za-z_$][\w$]*/g),
    );
    entry.related = entries
      .filter(
        (candidate) =>
          candidate.kind === "type" &&
          candidate.symbol !== entry.symbol &&
          (tokens.has(candidate.symbol.split(".").at(-1)) ||
            candidate.symbol === entry.symbol.split(".").slice(0, -1).join(".")),
      )
      .map((entry) => entry.symbol);
  }
  const sourceHash = createHash("sha256");
  for (const source of program
    .getSourceFiles()
    .filter(
      (source) =>
        !source.isDeclarationFile &&
        source.fileName.startsWith(resolve(root, "..") + "/") &&
        !source.fileName.includes("node_modules"),
    )
    .sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    sourceHash
      .update(relative(resolve(root, ".."), source.fileName))
      .update("\0")
      .update(source.text)
      .update("\0");
  }
  sourceHash.update(JSON.stringify(exampleFiles));
  return {
    version: manifest.version,
    digest: sourceHash.digest("hex"),
    entries,
    examples: [{ id: "live-inbox", title: "React UI with live app storage", files: exampleFiles }],
  };
}
