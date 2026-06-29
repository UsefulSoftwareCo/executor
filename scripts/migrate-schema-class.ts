#!/usr/bin/env bun
/**
 * Codemod: replace `Schema.Class` and `Schema.TaggedClass` declarations with
 * `Schema.Struct` / `Schema.TaggedStruct` + type alias, and rewrite
 * `new ClassName(...)` call sites to `ClassName.make(...)`.
 *
 * Why: Effect 4.x `Schema.Class` does an `instanceof` check on encode, but
 * TypeScript's structural typing accepts plain objects that match the field
 * shape. The mismatch is the source of "Expected <Class>, got {...}" runtime
 * crashes when wire-decoded payloads reach storage encoders. gcanti's
 * recommendation: default to Struct.
 *
 * Usage:
 *   bun run scripts/migrate-schema-class.ts            # apply changes
 *   bun run scripts/migrate-schema-class.ts --dry-run  # preview only
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const DRY_RUN = process.argv.includes("--dry-run");

const repoRoot = resolve(import.meta.dir, "..");
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".reference",
  ".turbo",
  "dist",
  "build",
  ".local",
  ".changeset",
]);

// Files we intentionally leave alone — they contain `Schema.Class` strings as
// lint-rule test fixtures, not real declarations.
const SKIP_FILES = new Set([
  resolve(repoRoot, "packages/core/sdk/src/oxlint-plugin-executor.test.ts"),
  resolve(repoRoot, "scripts/oxlint-plugin-executor/rules/no-schema-class.js"),
]);

interface ClassDeclInfo {
  readonly name: string;
  readonly kind: "Class" | "TaggedClass";
  readonly identifier?: string;
  readonly fieldsText: string;
  readonly isExported: boolean;
  readonly fullStart: number;
  readonly end: number;
  readonly leadingDecorators?: string;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

const collectTsFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectTsFiles(full, out);
      continue;
    }
    if (!stat.isFile()) continue;
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    if (entry.endsWith(".d.ts")) continue;
    if (SKIP_FILES.has(full)) continue;
    out.push(full);
  }
  return out;
};

/** Match an extends clause shape:
 *    Schema.Class<X>("ID")(FIELDS_EXPR)
 *  or
 *    Schema.TaggedClass<X>()("ID", FIELDS_EXPR)
 *  Returns null if the clause doesn't match. */
const parseSchemaClassExtends = (
  expression: ts.LeftHandSideExpression,
): {
  kind: "Class" | "TaggedClass";
  identifier: string;
  fieldsText: string;
} | null => {
  // outermost call: schemaCall(fieldsExpr) for Class, or schemaCall("Tag", fieldsExpr) for TaggedClass
  if (!ts.isCallExpression(expression)) return null;
  const fieldsCall = expression;
  const fieldsArgs = fieldsCall.arguments;

  // The callee is either:
  //   Schema.Class<X>("ID")           (a CallExpression)
  //   Schema.TaggedClass<X>()         (a CallExpression)
  const innerCall = fieldsCall.expression;
  if (!ts.isCallExpression(innerCall)) return null;

  // innerCall.expression should be `Schema.Class` or `Schema.TaggedClass`
  // (possibly with type arguments via PropertyAccessExpression).
  const innerCallee = innerCall.expression;
  if (!ts.isPropertyAccessExpression(innerCallee)) return null;
  if (!ts.isIdentifier(innerCallee.expression) || innerCallee.expression.text !== "Schema") {
    return null;
  }

  const methodName = innerCallee.name.text;
  if (methodName === "Class") {
    // Schema.Class<X>("ID")(FIELDS)
    if (innerCall.arguments.length !== 1) return null;
    const idArg = innerCall.arguments[0];
    if (!ts.isStringLiteral(idArg) && !ts.isNoSubstitutionTemplateLiteral(idArg)) return null;
    if (fieldsArgs.length !== 1) return null;
    return {
      kind: "Class",
      identifier: idArg.text,
      fieldsText: fieldsArgs[0].getText(),
    };
  }

  if (methodName === "TaggedClass") {
    // Schema.TaggedClass<X>()("Tag", FIELDS)
    if (innerCall.arguments.length !== 0) return null;
    if (fieldsArgs.length !== 2) return null;
    const tagArg = fieldsArgs[0];
    if (!ts.isStringLiteral(tagArg) && !ts.isNoSubstitutionTemplateLiteral(tagArg)) return null;
    return {
      kind: "TaggedClass",
      identifier: tagArg.text,
      fieldsText: fieldsArgs[1].getText(),
    };
  }

  return null;
};

/** Build the replacement text for a migrated declaration. */
const buildReplacement = (info: ClassDeclInfo): string => {
  const exportPrefix = info.isExported ? "export " : "";
  const identifierAnnotation =
    info.kind === "Class" && info.identifier && info.identifier !== info.name
      ? `.annotate({ identifier: ${JSON.stringify(info.identifier)} })`
      : "";

  if (info.kind === "Class") {
    return (
      `${exportPrefix}const ${info.name} = Schema.Struct(${info.fieldsText})${identifierAnnotation};\n` +
      `${exportPrefix}type ${info.name} = typeof ${info.name}.Type;`
    );
  }
  // TaggedClass
  return (
    `${exportPrefix}const ${info.name} = Schema.TaggedStruct(${JSON.stringify(info.identifier)}, ${info.fieldsText});\n` +
    `${exportPrefix}type ${info.name} = typeof ${info.name}.Type;`
  );
};

/** Find all migrate-able ClassDeclarations in a file. */
const findClassDecls = (source: ts.SourceFile): ClassDeclInfo[] => {
  const out: ClassDeclInfo[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.heritageClauses && node.name) {
      const extendsClause = node.heritageClauses.find(
        (c) => c.token === ts.SyntaxKind.ExtendsKeyword,
      );
      if (extendsClause && extendsClause.types.length === 1) {
        const parsed = parseSchemaClassExtends(extendsClause.types[0].expression);
        if (parsed) {
          // Only handle classes with empty bodies — anything with custom methods
          // needs human attention.
          if (node.members.length > 0) {
            console.warn(
              `  ⚠ ${node.name.text} has ${node.members.length} member(s); skipping (manual review)`,
            );
          } else {
            const isExported =
              node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
            out.push({
              name: node.name.text,
              kind: parsed.kind,
              identifier: parsed.identifier,
              fieldsText: parsed.fieldsText,
              isExported,
              fullStart: node.getStart(source),
              end: node.getEnd(),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
};

/** Collect a per-file map from local binding name → original imported name,
 *  so `import { X as Y }` resolves Y back to X for the migrated-name check. */
const collectImportAliases = (source: ts.SourceFile): Map<string, string> => {
  const aliases = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause || !clause.namedBindings) continue;
    if (!ts.isNamedImports(clause.namedBindings)) continue;
    for (const spec of clause.namedBindings.elements) {
      const localName = spec.name.text;
      const importedName = spec.propertyName?.text ?? localName;
      aliases.set(localName, importedName);
    }
  }
  return aliases;
};

/** Find every `new <ClassName>(...)` call where ClassName (or its import
 *  origin) is in the migrated set. Rewrites to `<LocalName>.make(...)` so
 *  the local binding stays consistent. */
const findConstructorCalls = (
  source: ts.SourceFile,
  migrated: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
): Edit[] => {
  const edits: Edit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const localName = node.expression.text;
      const importedName = aliases.get(localName) ?? localName;
      if (migrated.has(importedName)) {
        const startOfNew = node.getStart(source);
        const expressionEnd = node.expression.getEnd();
        // Replace `new ClassName` with `ClassName.make` using the local
        // binding name so the rewrite respects `import { X as Y }`.
        edits.push({
          start: startOfNew,
          end: expressionEnd,
          replacement: `${localName}.make`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edits;
};

const applyEdits = (text: string, edits: Edit[]): string => {
  // Apply in reverse order so positions stay valid.
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of sorted) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Pass 1 — discover every migrated class name (cross-file) so we can rewrite
// `new X(...)` everywhere.
// ---------------------------------------------------------------------------

const files = collectTsFiles(repoRoot);
console.log(`Scanning ${files.length} files...`);

const fileClassInfo = new Map<string, ClassDeclInfo[]>();
const migratedNames = new Set<string>();

for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (!text.includes("Schema.Class") && !text.includes("Schema.TaggedClass")) continue;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const decls = findClassDecls(source);
  if (decls.length > 0) {
    fileClassInfo.set(file, decls);
    for (const d of decls) migratedNames.add(d.name);
  }
}

console.log(
  `Found ${migratedNames.size} migrate-able class declarations across ${fileClassInfo.size} files.`,
);

// ---------------------------------------------------------------------------
// Pass 2 — apply edits per file (declarations + constructor rewrites).
// ---------------------------------------------------------------------------

let filesChanged = 0;
let declsMigrated = 0;
let ctorsRewritten = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (
    !text.includes("Schema.Class") &&
    !text.includes("Schema.TaggedClass") &&
    !text.includes("new ")
  ) {
    continue;
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const decls = fileClassInfo.get(file) ?? [];
  const aliases = collectImportAliases(source);
  const ctorEdits = findConstructorCalls(source, migratedNames, aliases);

  if (decls.length === 0 && ctorEdits.length === 0) continue;

  const declEdits: Edit[] = decls.map((d) => ({
    start: d.fullStart,
    end: d.end,
    replacement: buildReplacement(d),
  }));

  const allEdits = [...declEdits, ...ctorEdits];
  const newText = applyEdits(text, allEdits);

  if (newText === text) continue;

  filesChanged += 1;
  declsMigrated += decls.length;
  ctorsRewritten += ctorEdits.length;

  const rel = file.slice(repoRoot.length + 1);
  console.log(
    `  ${rel}: ${decls.length} decl${decls.length === 1 ? "" : "s"}, ${ctorEdits.length} ctor${ctorEdits.length === 1 ? "" : "s"}`,
  );

  if (!DRY_RUN) {
    writeFileSync(file, newText);
  }
}

console.log("");
console.log(`${DRY_RUN ? "[DRY RUN] Would change" : "Changed"} ${filesChanged} files:`);
console.log(`  ${declsMigrated} class declarations → Schema.Struct / TaggedStruct`);
console.log(`  ${ctorsRewritten} \`new X(...)\` → \`X.make(...)\``);
if (DRY_RUN) {
  console.log("\nRun without --dry-run to apply.");
}
