/** Generate searchable author contracts from the same TypeScript graph as declarations. */
import ts from "typescript-5";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// TypeScript reports source file names with POSIX separators on every platform.
const workspace = resolve(root, "..").split("\\").join("/") + "/";
/** Author modules and the skill document for each. Every export of these modules is described. */
const modules = {
  ".": "tools.md",
  "./client": "ui.md",
  "./react": "ui.md",
  "./operations/approval": "tools.md",
  "./mcp": "integrations.md",
  "./mcp/stdio": "integrations.md",
  "./graphql": "integrations.md",
  "./openapi": "integrations.md",
  "./skills": "tools.md",
};
/** Subpaths for hosts and Effect libraries. Apps do not import them, so the reference omits them. */
const hostModules = new Set([
  "./contracts",
  "./host",
  "./effect",
  "./mcp/effect",
  "./ui/contracts",
  "./ui/auth",
  "./ui/serving",
  "./ui/auth/contracts",
  "./storage/facet",
  "./skills/effect",
]);
const methods = [
  ["AppCache", "src/contracts/cache.ts", "AppCache", "tools.md"],
  ["OptimisticLocalStore", "src/contracts/optimistic.ts", "OptimisticLocalStore", "ui.md"],
  ["AppMutation", "src/contracts/optimistic.ts", "AppMutation", "ui.md"],
  ["Schema", "src/implementation/schema.ts", "Schema", "tools.md"],
  ["Sql", "src/contracts/sql.ts", "Sql", "storage.md"],
  ["SqlReader", "src/contracts/sql.ts", "SqlReader", "storage.md"],
  ["SqlCursor", "src/contracts/sql.ts", "SqlCursor", "storage.md"],
  ["Provider", "src/contracts/provider.ts", "Provider", "accounts.md"],
  ["WorkflowStep", "src/contracts/workflows.ts", "WorkflowStep", "workflows.md"],
  ["WorkflowControls", "src/contracts/workflows.ts", "WorkflowControls", "workflows.md"],
  ["AppContext", "src/contracts/app.ts", "BoundContext", "tools.md"],
];
const flags =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
/** The node builder flags `signatureToString` and `typeToString` print with for `flags`. */
const nodeFlags =
  ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope |
  ts.NodeBuilderFlags.IgnoreErrors;

/** Produce a deterministic catalog. No app code is imported or executed. */
export async function generateFrameworkReference() {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  // A new subpath must be documented for authors or named as a host surface.
  const subpaths = Object.keys(manifest.exports).filter((key) => !key.endsWith(".json"));
  const unclassified = [
    ...subpaths.filter((key) => !Object.hasOwn(modules, key) && !hostModules.has(key)),
    ...[...Object.keys(modules), ...hostModules].filter((key) => !subpaths.includes(key)),
  ];
  if (unclassified.length)
    throw new Error(`Classify apps package subpaths for the reference: ${unclassified.join(", ")}`);
  const authorModules = Object.entries(modules).map(([key, docs]) => ({
    module: key === "." ? "apps" : `apps/${key.slice(2)}`,
    file: manifest.exports[key],
    docs,
  }));
  const exampleDirectory = resolve(root, "../../playground/demo-apps/live-inbox");
  const examplePaths = [
    "index.ts",
    "schema.ts",
    "migrations/0001_messages.sql",
    "ui/main.tsx",
    "ui/index.html",
    "ui/style.css",
    "package.json",
  ];
  // The example deploys as written, so its manifest declares this release like every app.
  const deployable = (content) => {
    const { name, type, dependencies } = JSON.parse(content);
    return `${JSON.stringify(
      { name, private: true, type, dependencies: { apps: manifest.version, ...dependencies } },
      null,
      2,
    )}\n`;
  };
  const exampleFiles = await Promise.all(
    examplePaths.map(async (path) => {
      const content = await readFile(resolve(exampleDirectory, path), "utf8");
      return { path, content: path === "package.json" ? deployable(content) : content };
    }),
  );
  const program = ts.createProgram(
    [
      ...authorModules.map(({ file }) => resolve(root, file)),
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
    // Workspace declarations are recognised by this prefix; a mismatch would drop them all silently.
    if (!source.fileName.startsWith(workspace))
      throw new Error(`Reference module ${source.fileName} is outside the workspace ${workspace}`);
    return { source, exports: checker.getExportsOfModule(symbol) };
  };
  const resolveAlias = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  // Declarations read like a declaration file: class members keep their types, not their bodies.
  const bodies = (declaration) =>
    (ts.isClassDeclaration(declaration) ? declaration.members : [])
      .flatMap((member) => (member.body === undefined ? [] : [member.body]))
      .sort((a, b) => b.getStart() - a.getStart());
  const declarationText = (declaration) => {
    const start = declaration.getStart();
    let source = declaration.getText();
    for (const body of bodies(declaration))
      source =
        source.slice(0, body.getStart() - start).trimEnd() +
        ";" +
        source.slice(body.getEnd() - start);
    return source;
  };
  // The declarations a node names. Source identifiers resolve where they are written. The nodes the
  // checker prints signatures and value types from carry the symbol each name was printed for.
  // Type names only: the namespace or value before `.`, as in Schema.Struct, is not followed.
  // Printed nodes have no parent pointers, so each visit passes its parent.
  const qualifier = (node, parent) =>
    (ts.isQualifiedName(parent) && parent.left === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.expression === node);
  // `symbol` on a printed identifier is internal to TypeScript. A name that is not a declaration's own
  // name and resolves to nothing means that internal changed, and every link it carried would be lost.
  const named = (id, node, skipped = []) => {
    const found = new Set();
    const visit = (child, parent) => {
      if (skipped.includes(child)) return;
      if (ts.isIdentifier(child) && !(parent && qualifier(child, parent))) {
        const symbol = child.pos < 0 ? child.symbol : checker.getSymbolAtLocation(child);
        if (symbol !== undefined) found.add(resolveAlias(symbol));
        else if (parent?.name !== child)
          throw new Error(
            `Reference ${id}: TypeScript ${ts.version} gave no symbol for \`${ts.idText(child)}\` ` +
              `(${child.pos < 0 ? "printed" : "source"} ${ts.SyntaxKind[parent?.kind]}), so its related ` +
              `types cannot be linked. Update the symbol lookup in packages/apps/scripts/reference.mjs.`,
          );
      }
      ts.forEachChild(child, (grandchild) => visit(grandchild, child));
    };
    visit(node, undefined);
    return found;
  };
  // Each entry's symbol and the declarations its text names. Related types link by symbol, so a name
  // links to the declaration it resolves to rather than to whichever entry shares its spelling.
  const symbols = new Map();
  const references = new Map();
  const ids = new Map();
  const describe = (id, symbol, kind, type) => {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) throw new Error(`Missing declaration: ${id}`);
    const callable = kind === "function" || kind === "method";
    const callSignatures = callable ? checker.getSignaturesOfType(type, ts.SignatureKind.Call) : [];
    const signatures = callSignatures.map((signature) =>
      checker.signatureToString(signature, declaration, flags),
    );
    const definition =
      kind === "type" || kind === "class"
        ? declarationText(declaration)
        : kind === "value"
          ? `const ${symbol.name}: ${checker.typeToString(type, declaration, flags)}`
          : undefined;
    const names =
      kind === "type" || kind === "class"
        ? named(id, declaration, bodies(declaration))
        : kind === "value"
          ? named(id, checker.typeToTypeNode(type, declaration, nodeFlags))
          : new Set(
              callSignatures.flatMap((signature) => [
                ...named(
                  id,
                  checker.signatureToSignatureDeclaration(
                    signature,
                    ts.SyntaxKind.CallSignature,
                    declaration,
                    nodeFlags | ts.NodeBuilderFlags.WriteTypeParametersInQualifiedName,
                  ),
                ),
              ]),
            );
    return {
      names,
      kind,
      summary: text(symbol.getDocumentationComment(checker)),
      signatures,
      ...(definition === undefined ? {} : { definition }),
      tags: symbol.getJsDocTags(checker).map((tag) => ({ name: tag.name, text: text(tag.text) })),
      source: relative(resolve(root, ".."), declaration.getSourceFile().fileName)
        .split("\\")
        .join("/"),
    };
  };
  const record = (id, symbol, { names, ...described }, docs) => {
    symbols.set(id, symbol);
    references.set(id, names);
    ids.set(symbol, [...(ids.get(symbol) ?? []), id]);
    records.set(id, {
      symbol: id,
      ...described,
      docs,
      related: [],
      examples: ["tools.md", "ui.md", "storage.md"].includes(docs) ? ["live-inbox"] : [],
    });
  };
  const add = (id, symbol, kind, docs, type) =>
    record(id, symbol, describe(id, symbol, kind, type), docs);
  const addMethods = (name, type, docs) => {
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) continue;
      const member = checker.getTypeOfSymbolAtLocation(property, declaration);
      if (checker.getSignaturesOfType(member, ts.SignatureKind.Call).length)
        add(`${name}.${checker.symbolToString(property)}`, property, "method", docs, member);
    }
  };
  const classify = (id, symbol) => {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) throw new Error(`Missing declaration: ${id}`);
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length) return ["function", type];
    if (symbol.flags & ts.SymbolFlags.Class) return ["class", type];
    if (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))
      return ["type", checker.getDeclaredTypeOfSymbol(symbol)];
    if (symbol.flags & ts.SymbolFlags.Variable) return ["value", type];
    throw new Error(`Unclassified framework export: ${id}`);
  };
  // Every export an author can import is described; one the reference cannot classify fails the build.
  for (const { module, file, docs } of authorModules) {
    for (const exported of sourceModule(file).exports) {
      const id = `${module}.${exported.name}`;
      const symbol = resolveAlias(exported);
      const [kind, type] = classify(id, symbol);
      add(id, symbol, kind, docs, type);
      if (exported.name === "createAppClient") {
        const [signature] = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
        addMethods("AppClient", checker.getReturnTypeOfSignature(signature), docs);
      }
      if (records.get(id).summary === "") throw new Error(`Document framework export: ${id}`);
    }
  }
  for (const [name, file, exported, docs] of methods) {
    const symbol = sourceModule(file).exports.find((symbol) => symbol.name === exported);
    if (!symbol) throw new Error(`Missing method contract: ${name}`);
    addMethods(name, checker.getDeclaredTypeOfSymbol(symbol), docs);
    add(name, symbol, "type", docs, checker.getDeclaredTypeOfSymbol(symbol));
  }
  // A declaration an entry names but no module exports, such as a schema inside an options type, is
  // described too so an agent can follow every definition it reads.
  const closure = new Map();
  const pending = [...references].map(([id, names]) => [records.get(id).docs, names]);
  while (pending.length) {
    const [docs, names] = pending.pop();
    for (const symbol of names) {
      const target = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (target === undefined || ids.has(symbol) || closure.has(symbol)) continue;
      const file = target.getSourceFile().fileName;
      // Parameters, type parameters, members and locals belong to the declaration that names them.
      const statement = ts.isVariableDeclaration(target) ? target.parent.parent : target;
      if (
        !file.startsWith(workspace) ||
        file.includes("/node_modules/") ||
        !ts.isSourceFile(statement.parent)
      )
        continue;
      const [kind, type] = classify(symbol.name, symbol);
      // Private symbol keys brand framework values; their declaration says nothing more.
      if (type.flags & ts.TypeFlags.ESSymbolLike) continue;
      const described = describe(symbol.name, symbol, kind, type);
      closure.set(symbol, { described, docs });
      pending.push([docs, described.names]);
    }
  }
  // Such a declaration is described under its bare name. A name another entry already ends with, or
  // that two such declarations share, is qualified by its source so each id names one declaration.
  const spelled = new Map();
  for (const name of [
    ...[...records.keys()].map((id) => id.split(".").at(-1)),
    ...[...closure.keys()].map((symbol) => symbol.name),
  ])
    spelled.set(name, (spelled.get(name) ?? 0) + 1);
  for (const [symbol, { described, docs }] of closure)
    record(
      spelled.get(symbol.name) === 1 ? symbol.name : `${symbol.name}@${described.source}`,
      symbol,
      described,
      docs,
    );
  const entries = [...records.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  for (const entry of entries) {
    const linked = new Set(
      [...references.get(entry.symbol)]
        .filter((symbol) => symbol !== symbols.get(entry.symbol))
        .flatMap((symbol) => ids.get(symbol) ?? []),
    );
    entry.related = entries
      .filter(
        (candidate) =>
          (candidate.kind === "type" || candidate.kind === "class") &&
          candidate.symbol !== entry.symbol &&
          (linked.has(candidate.symbol) ||
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
        source.fileName.startsWith(workspace) &&
        !source.fileName.includes("node_modules"),
    )
    .sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    sourceHash
      .update(relative(resolve(root, ".."), source.fileName).split("\\").join("/"))
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
