/** Check every test/helper import using Effect's filesystem and scoped Node runtime. */
import ts from "typescript-5";
import { scenarios, type TestPlan } from "./test-plan.ts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path, Schema, type PlatformError } from "effect";

const allowed = new Set([
  "playwright",
  "autumn-js",
  "fflate",
  "@effect/vitest",
  "@kitlangton/terminal-control",
  "@modelcontextprotocol/sdk/client/index.js",
  "@modelcontextprotocol/sdk/types.js",
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
  "vitest",
  "vitest/config",
  "effect/http",
  "effect/cli",
  "effect",
  "effect/encoding",
  "effect/process",
  "typescript-5",
  "@effect/platform-node/NodeRuntime",
  "@effect/platform-node/NodeServices",
  "@effect/platform-node/NodeHttpServer",
  "react",
  "react-dom/client",
]);
class BoundaryViolation extends Schema.TaggedError<BoundaryViolation>()("BoundaryViolation", {
  problems: Schema.Array(Schema.String),
}) {}

const check = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve("e2e");
  const problems: string[] = [];
  const plan = new Map<string, typeof TestPlan.Type>(Object.entries(scenarios));
  const legacyStorage = path.join("support", "legacy-storage.ts");
  for (const [name, scenario] of plan)
    if (scenario.legacyStorage === true && scenario.targets.cloud.status === "scheduled")
      problems.push(
        `test-plan.ts: scenarios.${name} writes legacy storage, which Cloud does not expose`,
      );
  const walk = (directory: string): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      for (const name of yield* fs.readDirectory(directory)) {
        if (["node_modules", "dist", ".local"].includes(name)) continue;
        const file = path.join(directory, name);
        const stat = yield* fs.stat(file);
        if (stat.type === "Directory") {
          yield* walk(file);
          continue;
        }
        if (!/\.[cm]?[jt]sx?$/.test(name)) continue;
        const label = path.relative(root, file);
        const source = ts.createSourceFile(
          file,
          yield* fs.readFileString(file),
          ts.ScriptTarget.Latest,
          true,
        );
        const module = (node: ts.Node | undefined) => {
          if (!node || !ts.isStringLiteral(node)) {
            problems.push(`${label}: computed module loading is forbidden`);
            return;
          }
          const specifier = node.text;
          if (
            ["node:crypto", "node:net", "node:http"].includes(specifier) ||
            allowed.has(specifier)
          )
            return;
          // This adapter observes the real OS store, never an application implementation.
          if (label === `support${path.sep}os-credential.ts` && specifier === "@napi-rs/keyring")
            return;
          // This external upstream fixture generates its contract with Effect, not product code.
          if (
            label === `support${path.sep}openapi-error-upstream.ts` &&
            specifier === "effect/http-api"
          )
            return;
          // This upstream fixture serves real MCP protocols without product implementations.
          if (label === `support${path.sep}mcp-protocol-upstream.ts` && specifier === "effect/ai")
            return;
          if (label.startsWith(`viewer${path.sep}`) && specifier === "media-chrome/react") return;
          // The only database driver: runner-applied legacy rows for declared scenarios.
          if (label === legacyStorage && specifier === "@electric-sql/pglite") return;
          if (
            specifier.startsWith(".") &&
            path.resolve(path.dirname(file), specifier) === path.join(root, legacyStorage) &&
            !label.startsWith(`tests${path.sep}`) &&
            label !== `support${path.sep}managed-server.ts`
          ) {
            // A wrapper would hide direct database writes from the scenario declaration check.
            problems.push(`${label}: only scenarios and the runner may use legacy storage`);
            return;
          }
          if (
            specifier.startsWith(".") &&
            path.resolve(path.dirname(file), specifier).startsWith(root + path.sep)
          )
            return;
          problems.push(`${label}: forbidden E2E import ${specifier}`);
        };
        // The host's apps release is data in the apps package manifest, imported as JSON: the
        // fixtures declare the version the hosts ship. No implementation is imported.
        const appsManifest = (node: ts.ImportDeclaration) =>
          label === `support${path.sep}apps-release.ts` &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          path.resolve(path.dirname(file), node.moduleSpecifier.text) ===
            path.resolve("packages/apps/package.json") &&
          node.attributes?.elements.some(
            (attribute) =>
              attribute.name.text === "type" &&
              ts.isStringLiteral(attribute.value) &&
              attribute.value.text === "json",
          ) === true;
        // Names bound to legacy storage in this scenario file; each use needs a declaration.
        const legacyNames = new Set<string>();
        if (label.startsWith(`tests${path.sep}`))
          for (const statement of source.statements) {
            if (
              !ts.isImportDeclaration(statement) ||
              !ts.isStringLiteral(statement.moduleSpecifier) ||
              path.resolve(path.dirname(file), statement.moduleSpecifier.text) !==
                path.join(root, legacyStorage)
            )
              continue;
            const clause = statement.importClause;
            if (clause?.name) legacyNames.add(clause.name.text);
            const bindings = clause?.namedBindings;
            if (bindings && ts.isNamespaceImport(bindings)) legacyNames.add(bindings.name.text);
            if (bindings && ts.isNamedImports(bindings))
              for (const element of bindings.elements) legacyNames.add(element.name.text);
          }
        const scenarioOf = (node: ts.Node) => {
          for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
            if (!ts.isCallExpression(parent)) continue;
            const title = parent.arguments[0];
            if (!title || !ts.isPropertyAccessExpression(title) || title.name.text !== "title")
              continue;
            const entry = title.expression;
            if (
              ts.isPropertyAccessExpression(entry) &&
              ts.isIdentifier(entry.expression) &&
              entry.expression.text === "scenarios"
            )
              return entry.name.text;
          }
          return undefined;
        };
        const visit = (node: ts.Node) => {
          if (
            ts.isIdentifier(node) &&
            legacyNames.has(node.text) &&
            !ts.isImportSpecifier(node.parent) &&
            !ts.isImportClause(node.parent) &&
            !ts.isNamespaceImport(node.parent) &&
            !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
            !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
          ) {
            const name = scenarioOf(node);
            if (name === undefined)
              problems.push(`${label}: legacy storage must be used inside a planned scenario`);
            else if (plan.get(name)?.legacyStorage !== true)
              problems.push(`${label}: scenarios.${name} must declare legacyStorage`);
          }
          if (
            label.startsWith(`tests${path.sep}`) &&
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "withHostedCase"
          ) {
            // The case and native setup hook must agree before we start a server.
            const name = scenarioOf(node);
            if (name !== undefined && plan.get(name)?.fixtures !== "actors")
              problems.push(`${label}: scenarios.${name} must declare actor fixtures`);
          }
          if (
            !label.startsWith(`viewer${path.sep}`) &&
            ts.canHaveModifiers(node) &&
            ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
          )
            problems.push(
              `${label}: async orchestration is forbidden; use an Effect program and SDK adapter`,
            );
          if (
            label.startsWith(`tests${path.sep}`) &&
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "Effect" &&
            ["promise", "tryPromise", "runPromise", "runSync"].includes(node.expression.name.text)
          )
            problems.push(
              `${label}: scenarios must yield injected services instead of executing a Promise/runtime boundary`,
            );
          if (ts.isImportTypeNode(node))
            module(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
          if (ts.isImportDeclaration(node) && !appsManifest(node)) module(node.moduleSpecifier);
          if (ts.isExportDeclaration(node) && node.moduleSpecifier) module(node.moduleSpecifier);
          if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference)
          )
            module(node.moduleReference.expression);
          if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === "require"))
          )
            module(node.arguments[0]);
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    });
  yield* walk(root);
  if (problems.length) return yield* new BoundaryViolation({ problems });
  yield* Console.log("E2E boundary: no application imports");
});
NodeRuntime.runMain(
  check.pipe(
    Effect.tapError((error) =>
      error instanceof BoundaryViolation ? Console.error(error.problems.join("\n")) : Effect.void,
    ),
    Effect.provide(NodeServices.layer),
  ),
);
