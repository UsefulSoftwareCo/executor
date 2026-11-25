import ts from "typescript-5";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  appSpanAttributeKeys,
  appSpanNames,
  droppedAppAttributeKeys,
} from "../packages/telemetry/src/app-records.ts";

const root = new URL("../", import.meta.url).pathname;
const manifest: { exports: Record<string, string> } = JSON.parse(
  readFileSync(new URL("../packages/apps/package.json", import.meta.url), "utf8"),
);
const browserEntries = new Set([
  "./client",
  "./react",
  "./ui/contracts",
  "./ui/auth",
  "./ui/auth/contracts",
]);
const entries = Object.entries(manifest.exports)
  .filter(([key, source]) => source.endsWith(".ts") && !browserEntries.has(key))
  .map(([, source]) => new URL(source, new URL("../packages/apps/", import.meta.url)).pathname);

const program = ts.createProgram(entries, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  strict: true,
  exactOptionalPropertyTypes: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  jsx: ts.JsxEmit.ReactJSX,
});
const checker = program.getTypeChecker();

const spanCalls = new Set(["withSpan", "withSpanScoped", "makeSpan", "makeSpanScoped", "useSpan"]);
const effectModules = new Set(["Effect", "Stream", "Layer"]);
const annotationCalls = new Set(["annotateCurrentSpan", "annotateSpans"]);

const problems: Array<string> = [];
const spans = new Set<string>();
const keys = new Set<string>();

const where = (node: ts.Node) => {
  const file = node.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(node.getStart());
  return `${relative(root, file.fileName)}:${line + 1}`;
};

const literals = (type: ts.Type): Array<string> | undefined => {
  const parts = type.isUnion() ? type.types : [type];
  const values = parts.map((part) => (part.isStringLiteral() ? part.value : undefined));
  return values.every((value) => value !== undefined) ? values : undefined;
};

const strings = (node: ts.Expression): Array<string> | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    let results = [node.head.text];
    for (const span of node.templateSpans) {
      const values = strings(span.expression);
      if (values === undefined) return undefined;
      results = results.flatMap((prefix) =>
        values.map((value) => `${prefix}${value}${span.literal.text}`),
      );
    }
    return results;
  }
  return literals(checker.getTypeAtLocation(node));
};

const calls: Array<ts.CallExpression> = [];
const collect = (node: ts.Node) => {
  if (ts.isCallExpression(node)) calls.push(node);
  ts.forEachChild(node, collect);
};
for (const file of program.getSourceFiles())
  if (!file.isDeclarationFile && !file.fileName.includes("/node_modules/")) collect(file);

const target = (call: ts.CallExpression) => {
  const callee = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name
    : call.expression;
  let symbol = checker.getSymbolAtLocation(callee);
  if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias)
    symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  if (declaration === undefined) return undefined;
  if (ts.isVariableDeclaration(declaration))
    return declaration.initializer !== undefined && ts.isFunctionLike(declaration.initializer)
      ? declaration.initializer
      : undefined;
  return ts.isFunctionLike(declaration) ? declaration : undefined;
};

type Role = "name" | "options" | "attributes";
const helpers = new Set<string>();
const forward = (parameter: ts.ParameterDeclaration, role: Role) => {
  const helper = parameter.parent;
  const index = helper.parameters.indexOf(parameter);
  const id = `${where(helper)}#${index}:${role}`;
  if (helpers.has(id)) return;
  helpers.add(id);
  for (const call of calls) if (target(call) === helper) read(call.arguments[index], role);
};
const parameter = (node: ts.Expression) => {
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  return declaration !== undefined && ts.isParameter(declaration) ? declaration : undefined;
};

const key = (node: ts.Node, value: string | undefined) => {
  if (value === undefined) problems.push(`${where(node)}: attribute key the check cannot resolve`);
  else keys.add(value);
};

const attributes = (node: ts.Expression): void => {
  if (ts.isParenthesizedExpression(node)) return attributes(node.expression);
  if (ts.isConditionalExpression(node)) {
    attributes(node.whenTrue);
    return attributes(node.whenFalse);
  }
  if (!ts.isObjectLiteralExpression(node)) {
    problems.push(`${where(node)}: attributes the check cannot resolve`);
    return;
  }
  for (const property of node.properties) {
    if (
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    )
      key(property, property.name.text);
    else if (ts.isSpreadAssignment(property)) attributes(property.expression);
    else if (ts.isPropertyAssignment(property) && ts.isComputedPropertyName(property.name))
      for (const value of strings(property.name.expression) ?? [undefined]) key(property, value);
    else key(property, undefined);
  }
};

const spreads = (helper: ts.SignatureDeclaration, parameter: ts.ParameterDeclaration) => {
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isSpreadAssignment(node) &&
      ts.isIdentifier(node.expression) &&
      checker.getSymbolAtLocation(node.expression)?.valueDeclaration === parameter
    )
      found = true;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(helper, visit);
  return found;
};

const options = (node: ts.Expression) => {
  if (ts.isCallExpression(node)) {
    const helper = target(node);
    helper?.parameters.forEach((parameter, index) => {
      if (spreads(helper, parameter)) read(node.arguments[index], "options");
    });
    return;
  }
  if (!ts.isObjectLiteralExpression(node)) return;
  for (const property of node.properties)
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "attributes"
    )
      read(property.initializer, "attributes");
};

function read(node: ts.Expression | undefined, role: Role): void {
  if (node === undefined) return;
  const forwarded = parameter(node);
  if (forwarded !== undefined) return forward(forwarded, role);
  if (role === "options") return options(node);
  if (role === "attributes") return attributes(node);
  const values = strings(node);
  if (values === undefined) problems.push(`${where(node)}: span name the check cannot resolve`);
  else for (const value of values) spans.add(value);
}

for (const call of calls) {
  if (!ts.isPropertyAccessExpression(call.expression)) continue;
  const receiver = call.expression.expression;
  const method = call.expression.name.text;
  const [first, second] = call.arguments;
  const effect = ts.isIdentifier(receiver) && effectModules.has(receiver.text);
  if (effect && spanCalls.has(method)) {
    read(first, "name");
    read(second, "options");
  } else if (
    first !== undefined &&
    ((effect && annotationCalls.has(method)) || (method === "attribute" && second !== undefined))
  ) {
    if (second === undefined) read(first, "attributes");
    else {
      const forwarded = parameter(first);
      if (forwarded === undefined)
        for (const value of strings(first) ?? [undefined]) key(first, value);
    }
  }
}

for (const span of [...spans].sort())
  if (!appSpanNames.has(span))
    problems.push(`The framework names span "${span}", which the relay records as unrecognized.`);
for (const attribute of [...keys].sort())
  if (!appSpanAttributeKeys.has(attribute) && !droppedAppAttributeKeys.has(attribute))
    problems.push(`The framework sets attribute "${attribute}", which the relay does not know.`);

if (problems.length > 0) {
  console.error(
    [
      "App telemetry vocabulary drifted from the framework (packages/telemetry/src/app-records.ts):",
      ...problems.map((problem) => `  ${problem}`),
      "Add each name to the vocabulary, or each attribute that can carry app text to the dropped keys.",
    ].join("\n"),
  );
  process.exit(1);
}
console.log(
  `App telemetry vocabulary covers ${spans.size} span names and ${keys.size} attributes.`,
);
