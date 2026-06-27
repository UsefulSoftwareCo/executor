import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { writeJsonAtomicSync, writeTextAtomicSync } from "./artifact-io";
import { writeRunLaneProvenance } from "./evidence-provenance";

const E2E_ROOT = fileURLToPath(new URL("../", import.meta.url));

const registrationName = (expression: ts.LeftHandSideExpression) => {
  if (ts.isIdentifier(expression) && (expression.text === "scenario" || expression.text === "it")) {
    return expression.text;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "it" &&
    (expression.name.text === "live" || expression.name.text === "effect")
  ) {
    return `it.${expression.name.text}`;
  }
  return undefined;
};

const resolvedString = (
  expression: ts.Expression,
  bindings: ReadonlyMap<string, string>,
): string | undefined => {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isIdentifier(expression)) return bindings.get(expression.text);
  if (!ts.isTemplateExpression(expression)) return undefined;

  let value = expression.head.text;
  for (const span of expression.templateSpans) {
    const interpolation = resolvedString(span.expression, bindings);
    if (interpolation === undefined) return undefined;
    value += interpolation + span.literal.text;
  }
  return value;
};

const stringBindings = (sourceFile: ts.SourceFile) => {
  const bindings = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const value = resolvedString(declaration.initializer, bindings);
        if (value !== undefined && !bindings.has(declaration.name.text)) {
          bindings.set(declaration.name.text, value);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
};

const registrationsIn = (sourceFile: ts.SourceFile, bindings: ReadonlyMap<string, string>) => {
  const registrations: Array<NonNullable<ReturnType<typeof registeredTest>>> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node)) {
      const registered = registeredTest(node, bindings);
      if (registered) registrations.push(registered);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return registrations;
};

const registeredTest = (statement: ts.Statement, bindings: ReadonlyMap<string, string>) => {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
    return undefined;
  }
  const registration = registrationName(statement.expression.expression);
  if (!registration) return undefined;
  const nameArgument = statement.expression.arguments[0];
  const testName = nameArgument ? resolvedString(nameArgument, bindings) : undefined;
  return testName ? { statement, registration, testName } : undefined;
};

const removeRanges = (source: string, ranges: ReadonlyArray<{ start: number; end: number }>) => {
  let focused = source;
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    focused = focused.slice(0, range.start) + focused.slice(range.end);
  }
  return focused.replace(/\n{3,}/g, "\n\n").trim();
};

export const extractFocusedTestSource = (filePath: string, testName: string) => {
  const source = ts.sys.readFile(filePath);
  if (source === undefined) return undefined;
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = stringBindings(sourceFile);
  const registrations = registrationsIn(sourceFile, bindings);
  const selected = registrations.find((entry) => entry.testName === testName);
  if (!selected) return undefined;

  const ranges = [
    ...sourceFile.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement)
        ? [{ start: statement.getStart(sourceFile), end: statement.end }]
        : [],
    ),
    ...registrations
      .filter((registered) => registered !== selected)
      .map((registered) => ({
        start: registered.statement.getStart(sourceFile),
        end: registered.statement.end,
      })),
  ];
  const focused = removeRanges(source, ranges);
  return focused === ""
    ? undefined
    : { source: `${focused}\n`, registration: selected.registration };
};

export const writeFocusedTestSource = ({
  runDir,
  filePath,
  testName,
}: {
  readonly runDir: string;
  readonly filePath: string;
  readonly testName: string;
}) => {
  writeRunLaneProvenance(runDir, process.env.E2E_TARGET ?? "");
  const focused = extractFocusedTestSource(filePath, testName);
  if (!focused) return undefined;
  const candidatePath = relative(E2E_ROOT, filePath).split(sep).join("/");
  const sourcePath = candidatePath.startsWith("../") ? basename(filePath) : candidatePath;
  const metadata = {
    schemaVersion: 1,
    sourcePath,
    testName,
    registration: focused.registration,
    extractor: "typescript-named-test-v2",
    capturedAt: Date.now(),
  } as const;
  writeTextAtomicSync(join(runDir, "test.ts"), focused.source);
  writeJsonAtomicSync(join(runDir, "test-source-metadata.json"), metadata);
  return metadata;
};
