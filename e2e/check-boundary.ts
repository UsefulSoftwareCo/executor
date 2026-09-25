/** Check every test/helper import using Effect's filesystem and scoped Node runtime. */
import ts from "typescript";
import { scenarios, type TestPlan } from "./test-plan.ts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path, Schema, type PlatformError } from "effect";

const allowed = new Set([
  "playwright",
  "autumn-js",
  "@effect/vitest",
  "@kitlangton/terminal-control",
  "@modelcontextprotocol/sdk/client/index.js",
  "@modelcontextprotocol/sdk/types.js",
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
  "vitest",
  "vitest/config",
  "effect/unstable/http",
  "effect/unstable/cli",
  "effect",
  "effect/unstable/process",
  "typescript",
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
            specifier === "effect/unstable/httpapi"
          )
            return;
          if (label.startsWith(`viewer${path.sep}`) && specifier === "media-chrome/react") return;
          if (
            specifier.startsWith(".") &&
            path.resolve(path.dirname(file), specifier).startsWith(root + path.sep)
          )
            return;
          problems.push(`${label}: forbidden E2E import ${specifier}`);
        };
        const visit = (node: ts.Node) => {
          if (
            label.startsWith(`tests${path.sep}`) &&
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "withHostedCase"
          ) {
            // The case and native setup hook must agree before we start a server.
            for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
              if (!ts.isCallExpression(parent)) continue;
              const title = parent.arguments[0];
              if (!title || !ts.isPropertyAccessExpression(title) || title.name.text !== "title")
                continue;
              const entry = title.expression;
              if (
                !ts.isPropertyAccessExpression(entry) ||
                !ts.isIdentifier(entry.expression) ||
                entry.expression.text !== "scenarios"
              )
                continue;
              if (plan.get(entry.name.text)?.fixtures !== "actors")
                problems.push(`${label}: scenarios.${entry.name.text} must declare actor fixtures`);
              break;
            }
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
          if (ts.isImportDeclaration(node)) module(node.moduleSpecifier);
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
