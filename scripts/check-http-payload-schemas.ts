import fs from "node:fs";
import path from "node:path";

import * as ts from "typescript";

const HTTP_API_ENDPOINT_METHODS = new Set(["delete", "patch", "post", "put"]);
const SCHEMA_CLASS_FACTORIES = new Set(["Class", "TaggedClass", "ErrorClass", "TaggedErrorClass"]);
const DEFAULT_ROOTS = ["apps", "packages", "scripts"];
const IGNORED_DIRS = new Set([
  ".git",
  ".local",
  ".reference",
  ".turbo",
  ".worktrees",
  "dist",
  "node_modules",
]);
const EXTENSIONS = new Set([".ts", ".tsx"]);

type Finding = {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly endpoint: string;
  readonly className: string;
};

type Analyzer = {
  readonly checker: ts.TypeChecker;
  readonly program: ts.Program;
  readonly findings: Array<Finding>;
  readonly schemaClassCache: Map<ts.Symbol, string | undefined>;
  readonly expressionCache: Map<ts.Node, string | undefined>;
};

const main = () => {
  const repoRoot = process.cwd();
  const files = collectInputFiles(repoRoot, process.argv.slice(2));
  if (files.length === 0) return;

  const program = ts.createProgram(files, {
    allowImportingTsExtensions: true,
    exactOptionalPropertyTypes: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
  });
  const analyzer: Analyzer = {
    checker: program.getTypeChecker(),
    program,
    findings: [],
    schemaClassCache: new Map(),
    expressionCache: new Map(),
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !files.includes(sourceFile.fileName)) continue;
    visitSourceFile(analyzer, sourceFile);
  }

  if (analyzer.findings.length === 0) return;

  for (const finding of analyzer.findings) {
    const relative = path.relative(repoRoot, finding.fileName);
    console.error(
      `${relative}:${finding.line}:${finding.column} Use a structural schema for HttpApiEndpoint payload "${finding.endpoint}"; ${finding.className} is Schema.Class-backed.`,
    );
  }
  process.exitCode = 1;
};

const collectInputFiles = (repoRoot: string, inputPaths: ReadonlyArray<string>) => {
  const roots = inputPaths.length === 0 ? DEFAULT_ROOTS : inputPaths;
  const files = new Set<string>();
  for (const input of roots) {
    const resolved = path.resolve(repoRoot, input);
    collectFiles(resolved, files);
  }
  return Array.from(files).sort();
};

const collectFiles = (target: string, files: Set<string>) => {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    if (IGNORED_DIRS.has(path.basename(target))) return;
    for (const entry of fs.readdirSync(target)) {
      collectFiles(path.join(target, entry), files);
    }
    return;
  }
  if (!stat.isFile()) return;
  if (!EXTENSIONS.has(path.extname(target))) return;
  if (target.endsWith("routeTree.gen.ts")) return;
  files.add(target);
};

const visitSourceFile = (analyzer: Analyzer, sourceFile: ts.SourceFile) => {
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      inspectEndpointCall(analyzer, node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
};

const inspectEndpointCall = (analyzer: Analyzer, node: ts.CallExpression) => {
  const endpointName = getHttpEndpointName(analyzer, node.expression);
  if (!endpointName) return;

  for (const argument of node.arguments) {
    const payload = getObjectPropertyExpression(analyzer, argument, "payload");
    if (!payload) continue;

    const className = findSchemaClassSchema(analyzer, payload, new Set(), new Set());
    if (!className) continue;

    const sourceFile = payload.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(payload.getStart(sourceFile));
    analyzer.findings.push({
      className,
      column: position.character + 1,
      endpoint: endpointName,
      fileName: sourceFile.fileName,
      line: position.line + 1,
    });
  }
};

const getHttpEndpointName = (analyzer: Analyzer, expression: ts.Expression) => {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isPropertyAccessExpression(unwrapped)) return undefined;
  if (!HTTP_API_ENDPOINT_METHODS.has(unwrapped.name.text)) return undefined;
  if (!isHttpApiEndpointExpression(analyzer, unwrapped.expression)) return undefined;
  return unwrapped.name.text;
};

const isHttpApiEndpointExpression = (analyzer: Analyzer, expression: ts.Expression): boolean => {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    if (unwrapped.text === "HttpApiEndpoint") return true;
    return isNodeSymbolNamed(analyzer, unwrapped, "HttpApiEndpoint");
  }
  if (!ts.isPropertyAccessExpression(unwrapped)) return false;
  if (unwrapped.name.text !== "HttpApiEndpoint") return false;
  return true;
};

const getObjectPropertyExpression = (
  analyzer: Analyzer,
  expression: ts.Expression,
  propertyName: string,
): ts.Expression | undefined => {
  const object = resolveObjectLiteral(analyzer, expression, new Set());
  if (!object) return undefined;

  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spreadValue = getObjectPropertyExpression(analyzer, property.expression, propertyName);
      if (spreadValue) return spreadValue;
      continue;
    }
    if (!ts.isPropertyAssignment(property)) continue;
    if (getPropertyName(property.name) === propertyName) return property.initializer;
  }
  return undefined;
};

const resolveObjectLiteral = (
  analyzer: Analyzer,
  expression: ts.Expression,
  visitedSymbols: Set<ts.Symbol>,
): ts.ObjectLiteralExpression | undefined => {
  const unwrapped = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(unwrapped)) return unwrapped;

  const symbol = resolveSymbol(analyzer, unwrapped);
  if (!symbol || visitedSymbols.has(symbol)) return undefined;
  visitedSymbols.add(symbol);

  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) continue;
    return resolveObjectLiteral(analyzer, declaration.initializer, visitedSymbols);
  }
  return undefined;
};

const findSchemaClassSchema = (
  analyzer: Analyzer,
  expression: ts.Expression,
  visitedSymbols: Set<ts.Symbol>,
  visitedNodes: Set<ts.Node>,
): string | undefined => {
  const unwrapped = unwrapExpression(expression);
  if (visitedNodes.has(unwrapped)) return undefined;
  visitedNodes.add(unwrapped);

  if (analyzer.expressionCache.has(unwrapped)) {
    return analyzer.expressionCache.get(unwrapped);
  }

  const found =
    findSchemaClassFromNode(analyzer, unwrapped, visitedSymbols, visitedNodes) ??
    findSchemaClassFromResolvedSymbol(analyzer, unwrapped, visitedSymbols, visitedNodes);

  analyzer.expressionCache.set(unwrapped, found);
  return found;
};

const findSchemaClassFromNode = (
  analyzer: Analyzer,
  node: ts.Expression,
  visitedSymbols: Set<ts.Symbol>,
  visitedNodes: Set<ts.Node>,
): string | undefined => {
  if (ts.isCallExpression(node)) {
    const classFactory = getSchemaClassFactoryName(analyzer, node.expression);
    if (classFactory) return classFactory;

    const calleeExpression = ts.isPropertyAccessExpression(node.expression)
      ? node.expression.expression
      : node.expression;
    const calleeClass = findSchemaClassSchema(
      analyzer,
      calleeExpression,
      visitedSymbols,
      visitedNodes,
    );
    if (calleeClass) return calleeClass;

    for (const argument of node.arguments) {
      const className = findSchemaClassSchema(analyzer, argument, visitedSymbols, visitedNodes);
      if (className) return className;
    }
    return undefined;
  }

  if (ts.isClassExpression(node)) {
    return getClassSchemaName(analyzer, node);
  }

  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const className = findSchemaClassSchema(
          analyzer,
          property.initializer,
          visitedSymbols,
          visitedNodes,
        );
        if (className) return className;
      }
      if (ts.isSpreadAssignment(property)) {
        const className = findSchemaClassSchema(
          analyzer,
          property.expression,
          visitedSymbols,
          visitedNodes,
        );
        if (className) return className;
      }
    }
    return undefined;
  }

  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const className = findSchemaClassSchema(
          analyzer,
          element.expression,
          visitedSymbols,
          visitedNodes,
        );
        if (className) return className;
        continue;
      }
      const className = findSchemaClassSchema(analyzer, element, visitedSymbols, visitedNodes);
      if (className) return className;
    }
  }

  return undefined;
};

const findSchemaClassFromResolvedSymbol = (
  analyzer: Analyzer,
  expression: ts.Expression,
  visitedSymbols: Set<ts.Symbol>,
  visitedNodes: Set<ts.Node>,
): string | undefined => {
  const symbol = resolveSymbol(analyzer, expression);
  if (!symbol || visitedSymbols.has(symbol)) return undefined;
  visitedSymbols.add(symbol);

  const cached = analyzer.schemaClassCache.get(symbol);
  if (cached !== undefined) return cached;

  for (const declaration of symbol.declarations ?? []) {
    if (ts.isClassDeclaration(declaration)) {
      const className = getClassSchemaName(analyzer, declaration);
      if (className) {
        analyzer.schemaClassCache.set(symbol, className);
        return className;
      }
      continue;
    }

    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const className = findSchemaClassSchema(
        analyzer,
        declaration.initializer,
        new Set(visitedSymbols),
        visitedNodes,
      );
      if (className) {
        analyzer.schemaClassCache.set(symbol, className);
        return className;
      }
    }
  }

  analyzer.schemaClassCache.set(symbol, undefined);
  return undefined;
};

const getClassSchemaName = (
  analyzer: Analyzer,
  node: ts.ClassDeclaration | ts.ClassExpression,
): string | undefined => {
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const type of clause.types) {
      if (getSchemaClassFactoryName(analyzer, type.expression)) {
        return node.name?.text ?? "anonymous Schema.Class";
      }
    }
  }
  return undefined;
};

const getSchemaClassFactoryName = (
  analyzer: Analyzer,
  expression: ts.Expression,
): string | undefined => {
  const callee = getInnermostCallee(expression);
  if (ts.isPropertyAccessExpression(callee)) {
    if (!SCHEMA_CLASS_FACTORIES.has(callee.name.text)) return undefined;
    if (isSchemaNamespaceExpression(analyzer, callee.expression)) return callee.name.text;
    return undefined;
  }

  if (!ts.isIdentifier(callee)) return undefined;
  if (!SCHEMA_CLASS_FACTORIES.has(callee.text)) return undefined;
  return isNodeSymbolNamed(analyzer, callee, callee.text) ? callee.text : undefined;
};

const getInnermostCallee = (expression: ts.Expression): ts.Expression => {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isCallExpression(unwrapped)) return unwrapped;
  return getInnermostCallee(unwrapped.expression);
};

const isSchemaNamespaceExpression = (analyzer: Analyzer, expression: ts.Expression) => {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isIdentifier(unwrapped)) return false;
  if (unwrapped.text === "Schema") return true;
  return isNodeSymbolNamed(analyzer, unwrapped, "Schema");
};

const resolveSymbol = (analyzer: Analyzer, node: ts.Node): ts.Symbol | undefined => {
  const symbol = analyzer.checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  return analyzer.checker.getAliasedSymbol(symbol);
};

const isNodeSymbolNamed = (analyzer: Analyzer, node: ts.Node, name: string) => {
  const symbol = analyzer.checker.getSymbolAtLocation(node);
  return isSymbolNamed(symbol, name) || isSymbolNamed(resolveSymbol(analyzer, node), name);
};

const isSymbolNamed = (symbol: ts.Symbol | undefined, name: string) => {
  if (!symbol) return false;
  if (symbol.escapedName === name) return true;
  return (symbol.declarations ?? []).some((declaration) => {
    if (ts.isImportSpecifier(declaration)) {
      return (declaration.propertyName ?? declaration.name).text === name;
    }
    if (ts.isNamespaceImport(declaration)) {
      return declaration.name.text === name;
    }
    if (ts.isExportSpecifier(declaration)) {
      return (declaration.propertyName ?? declaration.name).text === name;
    }
    if (ts.isModuleDeclaration(declaration)) {
      return declaration.name.text === name;
    }
    return false;
  });
};

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const getPropertyName = (name: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  return undefined;
};

main();
