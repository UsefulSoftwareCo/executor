import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript-5";

type Warn = (message: string, offset: number) => void;
type Edit = { readonly start: number; readonly end: number; readonly text: string };

type AppFacts = {
  hasUser: boolean | undefined;
  hasApp: boolean;
  readonly constructors: Set<string>;
  readonly typed: boolean;
  readonly contextNames: Set<string>;
};

const newFacts = (typed: boolean): AppFacts => ({
  typed,
  hasUser: undefined,
  hasApp: false,
  constructors: new Set(),
  contextNames: new Set(typed ? [] : ["ctx", "context", "step"]),
});

const scriptExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const markdownExtensions = new Set([".md", ".mdx"]);
const skippedDirectories = new Set(["node_modules", "dist", ".git", ".turbo", ".output"]);
const keepMarker = "app-user-accounts: keep";

const applyEdits = (text: string, edits: readonly Edit[]) => {
  const ordered = [...edits].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let result = "";
  let position = 0;
  for (const edit of ordered) {
    if (edit.start < position) continue;
    result += text.slice(position, edit.start) + edit.text;
    position = edit.end;
  }
  return result + text.slice(position);
};

type Piece = {
  readonly text: string;
  readonly offsets: readonly number[];
  readonly escape: (text: string) => string;
  readonly scriptKind: ts.ScriptKind;
  readonly typescript: boolean;
};

const escapeFor =
  (quote: string) =>
  (text: string): string =>
    quote === "`"
      ? text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")
      : text
          .replace(/\\/g, "\\\\")
          .replace(new RegExp(quote, "g"), `\\${quote}`)
          .replace(/\n/g, "\\n");

const cook = (file: string, start: number, end: number, text: string[], offsets: number[]) => {
  for (let index = start; index < end;) {
    const char = file[index]!;
    if (char !== "\\") {
      text.push(char);
      offsets.push(index);
      index++;
      continue;
    }
    const next = file[index + 1]!;
    const simple: Record<string, string> = {
      n: "\n",
      t: "\t",
      r: "\r",
      b: "\b",
      f: "\f",
      v: "\v",
      "0": "\0",
    };
    let length = 2;
    let value: string;
    if (next in simple) value = simple[next]!;
    else if (next === "x") {
      value = String.fromCharCode(parseInt(file.slice(index + 2, index + 4), 16));
      length = 4;
    } else if (next === "u" && file[index + 2] === "{") {
      const close = file.indexOf("}", index);
      value = String.fromCodePoint(parseInt(file.slice(index + 3, close), 16));
      length = close + 1 - index;
    } else if (next === "u") {
      value = String.fromCharCode(parseInt(file.slice(index + 2, index + 6), 16));
      length = 6;
    } else if (next === "\r" && file[index + 2] === "\n") {
      value = "";
      length = 3;
    } else if (next === "\n" || next === " " || next === " ") value = "";
    else value = next;
    for (const unit of value) {
      text.push(unit);
      offsets.push(index);
    }
    index += length;
  }
};

const unmigrated = /(?<!\buser\s*)(?<!\.\.)\.accounts\b|(?<!\buser\s*:\s*)\{\s*accounts\b/;

const placeholder = (index: number) => `$__app_user_accounts_${index}__$`;

const literalPiece = (
  source: ts.SourceFile,
  node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression,
): { readonly piece: Piece; readonly substitutions: readonly ts.Expression[] } => {
  const file = source.text;
  const start = node.getStart(source);
  const quote = file[start]!;
  const text: string[] = [];
  const offsets: number[] = [];
  const substitutions: ts.Expression[] = [];
  if (!ts.isTemplateExpression(node)) cook(file, start + 1, node.end - 1, text, offsets);
  else {
    cook(file, start + 1, node.head.end - 2, text, offsets);
    for (const span of node.templateSpans) {
      const open = span.expression.pos - 2;
      const close = span.literal.getStart(source) + 1;
      const name = placeholder(substitutions.length);
      substitutions.push(span.expression);
      for (let index = 0; index < name.length; index++) {
        text.push(name[index]!);
        offsets.push(index === 0 ? open : close - 1);
      }
      const literalEnd = ts.isTemplateTail(span.literal)
        ? span.literal.end - 1
        : span.literal.end - 2;
      cook(file, close, literalEnd, text, offsets);
    }
  }
  offsets.push(node.end - 1);
  return {
    piece: {
      text: text.join(""),
      offsets,
      escape: escapeFor(quote),
      scriptKind: ts.ScriptKind.TS,
      typescript: false,
    },
    substitutions,
  };
};

const plainPiece = (
  text: string,
  offset: number,
  scriptKind: ts.ScriptKind,
  typescript: boolean,
): Piece => ({
  text,
  offsets: Array.from({ length: text.length + 1 }, (_, index) => offset + index),
  escape: (inserted) => inserted,
  scriptKind,
  typescript,
});

const kept = (source: ts.SourceFile, node: ts.Node) =>
  (ts.getLeadingCommentRanges(source.text, node.pos) ?? []).some(({ pos, end }) =>
    source.text.slice(pos, end).includes(keepMarker),
  );

const walk = (source: ts.SourceFile, node: ts.Node, visit: (node: ts.Node) => void) => {
  const step = (child: ts.Node) => {
    if (kept(source, child)) return;
    visit(child);
    ts.forEachChild(child, step);
  };
  step(node);
};

const nameOf = (node: ts.Node | undefined): string | undefined =>
  node === undefined
    ? undefined
    : ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
      ? node.text
      : ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : undefined;

const appsEntry =
  /^apps(\/(mcp(\/stdio)?|graphql|openapi|operations\/approval|skills|react|client))?$/;
const isAppsModule = (specifier: ts.Expression | undefined) =>
  specifier !== undefined && ts.isStringLiteral(specifier) && appsEntry.test(specifier.text);

const unwrap = <Node extends ts.Node>(node: Node): Node | ts.Expression =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isTypeAssertionExpression(node)
    ? unwrap(node.expression)
    : node;

type FunctionNode =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration
  | ts.MethodDeclaration;
const isFunction = (node: ts.Node): node is FunctionNode =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node);

class Rewrite {
  readonly source: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly edits: Edit[] = [];
  readonly pieceEdits: Edit[] = [];
  readonly renamed = new Set<ts.Identifier>();
  readonly typed = new Set<ts.ParameterDeclaration | ts.CallExpression>();
  contextImported = false;

  readonly piece: Piece;
  readonly facts: AppFacts;
  readonly report: Warn;

  constructor(piece: Piece, facts: AppFacts, report: Warn) {
    this.piece = piece;
    this.facts = facts;
    this.report = report;
    const name = piece.scriptKind === ts.ScriptKind.TSX ? "app.tsx" : "app.ts";
    this.source = ts.createSourceFile(
      name,
      piece.text,
      ts.ScriptTarget.Latest,
      true,
      piece.scriptKind,
    );
    const host = ts.createCompilerHost({});
    const program = ts.createProgram({
      rootNames: [name],
      options: { noLib: true, noResolve: true, allowJs: true, types: [] },
      host: {
        ...host,
        getSourceFile: (file) => (file === name ? this.source : undefined),
        fileExists: (file) => file === name,
        readFile: () => undefined,
        writeFile: () => undefined,
      },
    });
    this.checker = program.getTypeChecker();
    this.parsed = program.getSyntacticDiagnostics(this.source).length === 0;
  }

  readonly parsed: boolean;

  warn(node: ts.Node, message: string) {
    this.report(message, this.piece.offsets[this.start(node)]!);
  }

  replace(start: number, end: number, text: string) {
    this.pieceEdits.push({ start, end, text });
    this.edits.push({
      start: this.piece.offsets[start]!,
      end: this.piece.offsets[end]!,
      text: this.piece.escape(text),
    });
  }
  insert(at: number, text: string) {
    this.replace(at, at, text);
  }
  start(node: ts.Node) {
    return node.getStart(this.source);
  }
  text(node: ts.Node) {
    return node.getText(this.source);
  }
  visit(visit: (node: ts.Node) => void) {
    walk(this.source, this.source, visit);
  }

  symbol(node: ts.Node) {
    return this.checker.getSymbolAtLocation(node);
  }

  referent(node: ts.Identifier) {
    return ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? this.checker.getShorthandAssignmentValueSymbol(node.parent)
      : this.symbol(node);
  }

  declaration(node: ts.Node) {
    return this.symbol(node)?.declarations?.[0];
  }

  appsExport(node: ts.Node): string | undefined {
    const expression = unwrap(node);
    if (ts.isIdentifier(expression)) {
      const declaration = this.declaration(expression);
      if (declaration === undefined) return expression.text;
      return ts.isImportSpecifier(declaration) &&
        isAppsModule(declaration.parent.parent.parent.moduleSpecifier)
        ? nameOf(declaration.propertyName ?? declaration.name)
        : undefined;
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression))
      return this.appsNamespace(expression.expression) ? expression.name.text : undefined;
    return undefined;
  }

  appsCallee(node: ts.Expression, seen = new Set<ts.Node>()): string | undefined {
    const expression = unwrap(node);
    const declaration = ts.isIdentifier(expression) ? this.declaration(expression) : undefined;
    if (
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
    ) {
      if (seen.has(declaration)) return undefined;
      seen.add(declaration);
      return this.appsCallee(declaration.initializer, seen);
    }
    return this.appsExport(expression);
  }

  visibleAt(name: ts.Identifier, at: ts.Node) {
    const target = this.symbol(name);
    const found = this.checker
      .getSymbolsInScope(at, ts.SymbolFlags.Value)
      .find((symbol) => symbol.name === name.text);
    if (target === undefined || found === undefined) return target === found;
    return (
      this.checker.getExportSymbolOfSymbol(found) === this.checker.getExportSymbolOfSymbol(target)
    );
  }

  appsNamespace(name: ts.Identifier) {
    const declaration = this.declaration(name);
    return (
      declaration !== undefined &&
      ts.isNamespaceImport(declaration) &&
      isAppsModule(declaration.parent.parent.moduleSpecifier)
    );
  }

  appsType(node: ts.TypeReferenceNode) {
    const name = node.typeName;
    if (ts.isIdentifier(name)) return this.appsExport(name);
    return ts.isIdentifier(name.left) && this.appsNamespace(name.left)
      ? name.right.text
      : undefined;
  }

  references(name: ts.Identifier, scope: ts.Node) {
    const target = this.symbol(name);
    const found: ts.Identifier[] = [];
    if (target === undefined) return found;
    walk(this.source, scope, (node) => {
      if (ts.isIdentifier(node) && node !== name && this.referent(node) === target)
        found.push(node);
    });
    return found;
  }

  read(name: ts.Identifier, scope: ts.Node, counts: (node: ts.Identifier) => boolean = () => true) {
    const target = this.symbol(name);
    if (target === undefined) return false;
    let found = false;
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node !== name && counts(node) && this.referent(node) === target)
        found = true;
      if (!found) ts.forEachChild(node, visit);
    };
    visit(scope);
    return found;
  }

  unrenamed(name: ts.Identifier) {
    return this.read(name, this.source, (node) => !this.renamed.has(node));
  }

  removeElement(list: ts.NodeArray<ts.Node>, index: number) {
    const element = list[index]!;
    if (index < list.length - 1)
      this.replace(this.start(element), this.start(list[index + 1]!), "");
    else if (index > 0) this.replace(list[index - 1]!.end, element.end, "");
    else this.replace(this.start(element), list.hasTrailingComma ? list.end : element.end, "");
  }

  run() {
    this.requirements();
    this.contexts();
    this.webhooks();
    this.schedules();
  }

  requirementObjects() {
    const objects = new Set<ts.ObjectLiteralExpression | ts.TypeLiteralNode>();
    const resolve = (node: ts.Node | undefined) => {
      if (node === undefined) return;
      const expression = unwrap(node);
      if (ts.isObjectLiteralExpression(expression)) objects.add(expression);
      else if (ts.isIdentifier(expression)) {
        const declaration = this.declaration(expression);
        if (
          declaration !== undefined &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          !kept(this.source, declaration.parent.parent)
        )
          resolve(declaration.initializer);
      }
    };
    this.visit((node) => {
      if (ts.isCallExpression(node) && this.appsExport(node.expression) === "defineApp")
        resolve(node.arguments[0]);
      else if (
        ts.isTypeReferenceNode(node) &&
        this.text(node.typeName).endsWith("Context") &&
        node.typeArguments?.[0] !== undefined
      ) {
        const argument = node.typeArguments[0];
        if (ts.isTypeLiteralNode(argument)) objects.add(argument);
        else if (ts.isTypeQueryNode(argument) && ts.isIdentifier(argument.exprName))
          resolve(argument.exprName);
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "requirements" &&
        node.initializer !== undefined
      )
        resolve(node.initializer);
    });
    return objects;
  }

  requirements() {
    let visible = false;
    let hasUser = false;
    for (const object of this.requirementObjects()) {
      visible = true;
      const members: ts.NodeArray<ts.ObjectLiteralElementLike | ts.TypeElement> =
        ts.isTypeLiteralNode(object) ? object.members : object.properties;
      for (const [index, member] of members.entries()) {
        const name = nameOf(member.name);
        if (name === "user") hasUser = true;
        if (name === "app") this.facts.hasApp = true;
        if (name !== "accounts") continue;
        const value = ts.isPropertyAssignment(member)
          ? unwrap(member.initializer)
          : ts.isPropertySignature(member)
            ? member.type
            : undefined;
        const empty =
          value !== undefined &&
          ((ts.isObjectLiteralExpression(value) && value.properties.length === 0) ||
            (ts.isTypeLiteralNode(value) && value.members.length === 0));
        if (empty) {
          if (members.length === 1) this.replace(this.start(object), object.end, "{}");
          else this.removeElement(members, index);
          continue;
        }
        hasUser = true;
        this.insert(this.start(member), "user: { ");
        this.insert(member.end, " }");
      }
    }
    if (visible) this.facts.hasUser = (this.facts.hasUser ?? false) || hasUser;
  }

  value(node: ts.Node | undefined): ts.Node | undefined {
    if (node === undefined) return undefined;
    const expression = unwrap(node);
    if (!ts.isIdentifier(expression)) return expression;
    const declaration = this.referent(expression)?.declarations?.[0];
    if (declaration === undefined) return undefined;
    if (!ts.isVariableDeclaration(declaration)) return declaration;
    if (declaration.initializer === undefined || kept(this.source, declaration.parent.parent))
      return undefined;
    return this.value(declaration.initializer);
  }

  definitions() {
    const objects: ts.ObjectLiteralExpression[] = [];
    const add = (node: ts.Node | undefined) => {
      const value = this.value(node);
      if (value !== undefined && ts.isObjectLiteralExpression(value)) objects.push(value);
    };
    this.visit((node) => {
      if (!ts.isCallExpression(node) || this.appsExport(node.expression) !== "defineApp") return;
      const definition = this.value(node.arguments[1]);
      if (definition === undefined || !isFunction(definition) || definition.body === undefined)
        return add(definition);
      if (!ts.isBlock(definition.body)) return add(definition.body);
      const returns = (child: ts.Node) => {
        if (ts.isReturnStatement(child)) add(child.expression);
        else if (!isFunction(child)) ts.forEachChild(child, returns);
      };
      returns(definition.body);
    });
    return objects;
  }

  webhookObjects() {
    const objects = new Set<ts.ObjectLiteralExpression>();
    const add = (node: ts.Node | undefined) => {
      const value = this.value(node);
      if (value !== undefined && ts.isObjectLiteralExpression(value)) objects.add(value);
    };
    const webhookType = (type: ts.TypeNode | undefined) =>
      type !== undefined && ts.isTypeReferenceNode(type) && this.appsType(type) === "Webhook";
    for (const definition of this.definitions())
      for (const property of definition.properties) {
        if (nameOf(property.name) !== "webhooks") continue;
        const webhooks = this.value(
          ts.isPropertyAssignment(property)
            ? property.initializer
            : ts.isShorthandPropertyAssignment(property)
              ? property.name
              : undefined,
        );
        if (webhooks === undefined || !ts.isObjectLiteralExpression(webhooks)) continue;
        for (const webhook of webhooks.properties)
          if (ts.isPropertyAssignment(webhook)) add(webhook.initializer);
          else if (ts.isShorthandPropertyAssignment(webhook)) add(webhook.name);
      }
    this.visit((node) => {
      if ((ts.isSatisfiesExpression(node) || ts.isAsExpression(node)) && webhookType(node.type))
        add(node.expression);
      else if (ts.isVariableDeclaration(node) && webhookType(node.type)) add(node.initializer);
    });
    return objects;
  }

  contextParameters() {
    const parameters = new Set<ts.ParameterDeclaration>();
    const workflows = new Set<ts.ParameterDeclaration>();
    const handler = (node: ts.Node | undefined) => {
      const target = this.value(node);
      const parameter =
        target !== undefined && isFunction(target) ? target.parameters[0] : undefined;
      if (parameter !== undefined) parameters.add(parameter);
      return parameter;
    };
    this.visit((node) => {
      if (ts.isCallExpression(node)) {
        const name = this.appsExport(node.expression);
        if (name === "query" || name === "mutation" || name === "defineApp")
          handler(node.arguments[1]);
        else if (name === "workflow") {
          const parameter = handler(node.arguments[1]);
          if (parameter !== undefined) workflows.add(parameter);
        }
      }
      if (ts.isParameter(node) && node.type !== undefined && this.contextType(node.type)) {
        parameters.add(node);
        if (/\bWorkflowContext\b/.test(this.text(node.type))) workflows.add(node);
      }
    });
    for (const webhook of this.webhookObjects())
      for (const property of webhook.properties) {
        const name = nameOf(property.name);
        if (name !== "register" && name !== "handle" && name !== "unregister") continue;
        if (ts.isMethodDeclaration(property)) handler(property);
        else if (ts.isPropertyAssignment(property)) handler(property.initializer);
      }
    this.visit((node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "do" &&
        this.step(node.expression.expression, workflows)
      )
        for (const argument of node.arguments) if (isFunction(argument)) handler(argument);
    });
    if (!this.facts.typed)
      for (const statement of this.source.statements)
        if (ts.isExpressionStatement(statement)) handler(statement.expression);
    return parameters;
  }

  step(node: ts.Expression, workflows: ReadonlySet<ts.ParameterDeclaration>): boolean {
    const expression = unwrap(node);
    const context = (name: ts.Identifier) => {
      const declaration = this.declaration(name);
      return declaration === undefined
        ? this.facts.contextNames.has(name.text) || name.text === "ctx" || name.text === "context"
        : ts.isParameter(declaration) && workflows.has(declaration);
    };
    if (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "step" &&
      ts.isIdentifier(expression.expression)
    )
      return context(expression.expression);
    if (!ts.isIdentifier(expression)) return false;
    const declaration = this.declaration(expression);
    if (declaration === undefined) return expression.text === "step";
    if (
      !ts.isBindingElement(declaration) ||
      nameOf(declaration.propertyName ?? declaration.name) !== "step"
    )
      return false;
    const holder = declaration.parent.parent;
    if (ts.isParameter(holder)) return workflows.has(holder);
    const initializer =
      ts.isVariableDeclaration(holder) && holder.initializer !== undefined
        ? unwrap(holder.initializer)
        : undefined;
    return initializer !== undefined && ts.isIdentifier(initializer) && context(initializer);
  }

  contextType(type: ts.TypeNode) {
    let found = false;
    const visit = (node: ts.Node) => {
      if (ts.isTypeReferenceNode(node) && /(?:Context|Ctx)$/.test(this.text(node.typeName)))
        found = true;
      ts.forEachChild(node, visit);
    };
    visit(type);
    return found;
  }

  contexts() {
    for (const parameter of this.contextParameters()) {
      const scope = parameter.parent;
      if (parameter.type !== undefined && this.facts.hasUser !== false)
        walk(this.source, parameter.type, (node) => {
          if (
            ts.isLiteralTypeNode(node) &&
            ts.isStringLiteral(node.literal) &&
            node.literal.text === "accounts"
          )
            this.replace(this.start(node.literal) + 1, node.literal.end - 1, "user");
        });
      if (ts.isIdentifier(parameter.name)) {
        if (!this.facts.typed) this.facts.contextNames.add(parameter.name.text);
        for (const reference of this.references(parameter.name, scope)) {
          const parent = reference.parent;
          if (
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === reference &&
            parent.name.text === "accounts"
          )
            this.account(parent.name, `${reference.text}.accounts`);
          else if (
            ts.isVariableDeclaration(parent) &&
            parent.initializer === reference &&
            ts.isObjectBindingPattern(parent.name)
          )
            this.pattern(parent.name);
        }
      } else if (ts.isObjectBindingPattern(parameter.name)) this.pattern(parameter.name);
    }
    if (this.facts.typed) return;
    this.visit((node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "accounts" &&
        ts.isIdentifier(node.expression) &&
        this.facts.contextNames.has(node.expression.text) &&
        this.symbol(node.expression) === undefined &&
        this.parsed
      )
        this.account(node.name, `${node.expression.text}.accounts`);
    });
  }

  unparsed() {
    if (!this.parsed && unmigrated.test(applyEdits(this.piece.text, this.pieceEdits)))
      this.warn(
        this.source,
        "app source here does not parse on its own and still names `accounts`; check it by hand",
      );
  }

  account(name: ts.MemberName, read: string) {
    if (this.facts.hasUser === false)
      this.warn(
        name,
        `${read} is read, but the app declares no user requirements; edit it by hand, such as declaring the requirement it needs`,
      );
    else this.insert(this.start(name), "user.");
  }

  pattern(pattern: ts.ObjectBindingPattern) {
    for (const [index, element] of pattern.elements.entries()) {
      if (nameOf(element.propertyName ?? element.name) !== "accounts" || element.dotDotDotToken)
        continue;
      if (this.facts.hasUser !== false) {
        this.insert(this.start(element), "user: { ");
        this.insert(element.end, " }");
        continue;
      }
      const bound: ts.Identifier[] = [];
      const collect = (name: ts.BindingName) => {
        if (ts.isIdentifier(name)) bound.push(name);
        else
          for (const inner of name.elements)
            if (!ts.isOmittedExpression(inner)) collect(inner.name);
      };
      collect(element.name);
      const used = bound.some((name) => this.read(name, this.source));
      if (used)
        this.warn(
          element,
          `the destructured \`${this.text(element)}\` is read, but the app declares no user requirements; edit it by hand, such as declaring the requirement it needs`,
        );
      else if (pattern.elements.length > 1) this.removeElement(pattern.elements, index);
      else {
        const parameter = pattern.parent;
        if (ts.isParameter(parameter) && ts.isFunctionLike(parameter.parent)) {
          const list = parameter.parent.parameters;
          const position = list.indexOf(parameter);
          if (position === list.length - 1 && parameter.type === undefined)
            this.removeElement(list, position);
          else this.replace(this.start(pattern), pattern.end, "_");
        } else if (
          ts.isVariableDeclaration(parameter) &&
          ts.isVariableDeclarationList(parameter.parent) &&
          parameter.parent.declarations.length === 1 &&
          ts.isVariableStatement(parameter.parent.parent) &&
          (ts.getLeadingCommentRanges(this.source.text, parameter.parent.parent.pos) ?? [])
            .length === 0
        )
          this.replace(parameter.parent.parent.pos, parameter.parent.parent.end, "");
        else this.replace(this.start(pattern), pattern.end, "{}");
      }
    }
  }

  webhooks() {
    for (const webhook of this.webhookObjects())
      for (const property of webhook.properties)
        if (
          ts.isPropertyAssignment(property) &&
          nameOf(property.name) === "account" &&
          (ts.isStringLiteral(property.initializer) ||
            ts.isNoSubstitutionTemplateLiteral(property.initializer))
        ) {
          this.insert(this.start(property.initializer), "{ user: ");
          this.insert(property.initializer.end, " }");
        }
  }

  mutationOf(argument: ts.Expression): ts.CallExpression | undefined {
    const expression = unwrap(argument);
    if (ts.isCallExpression(expression)) return expression;
    if (!ts.isIdentifier(expression)) return undefined;
    const declaration = this.declaration(expression);
    const initializer =
      declaration !== undefined &&
      (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration))
        ? declaration.initializer
        : undefined;
    if (initializer === undefined) return undefined;
    const value = unwrap(initializer);
    return ts.isCallExpression(value) ? value : undefined;
  }

  schedules() {
    this.visit((node) => {
      if (!ts.isCallExpression(node) || node.arguments.length !== 3) return;
      const callee = this.appsExport(node.expression);
      if (callee !== "cron" && callee !== "interval") return;
      const written = ts.isIdentifier(node.expression)
        ? node.expression
        : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)
          ? node.expression.name
          : undefined;
      if (written === undefined || (ts.isIdentifier(node.expression) && written.text !== callee)) {
        this.warn(
          node,
          `${this.text(node.expression)}(…) is ${callee} from apps under another name; rename it to userCron, userInterval, appCron or appInterval by hand`,
        );
        return;
      }
      const kind = callee === "cron" ? "Cron" : "Interval";
      const target = this.text(node.arguments[1]!);
      const call = this.mutationOf(node.arguments[1]!);
      const options = call?.arguments[0] === undefined ? undefined : unwrap(call.arguments[0]);
      const approved =
        call !== undefined &&
        (this.appsExport(call.expression) === "withApproval" ||
          (options !== undefined &&
            ts.isObjectLiteralExpression(options) &&
            options.properties.some((property) => nameOf(property.name) === "approval")));
      let scope: "app" | "user";
      if (this.facts.hasUser === undefined) {
        scope = "user";
        this.warn(
          node,
          `${callee}(…, ${target}, …) became user${kind}: no requirements declaration is visible here; use app${kind} if the app declares no user accounts`,
        );
      } else if (this.facts.hasUser) scope = "user";
      else if (approved) {
        scope = "user";
        this.warn(
          node,
          `${callee}(…, ${target}, …) became user${kind}: the app has no user requirements, but its mutation declares an approval, which app schedules cannot ask for`,
        );
      } else {
        scope = "app";
        this.warn(
          node,
          `${callee}(…, ${target}, …) became app${kind}: one schedule an app manager enables, run without a caller. No stored schedule is converted: versions already running keep their members' schedules. Redeploying deletes the members' copies of this schedule, with their settings, run history and pending approvals, and the app schedule starts paused until an app manager enables it`,
        );
        this.appMutation(node, call, `${callee}(…, ${target}, …)`);
      }
      const name = `${scope}${kind}`;
      this.facts.constructors.add(name);
      this.renamed.add(written);
      this.replace(this.start(written), written.end, name);
    });
  }

  appMutation(node: ts.Node, call: ts.CallExpression | undefined, schedule: string) {
    if (call === undefined) {
      if (this.facts.typed)
        this.warn(
          node,
          `${schedule}: its mutation is declared elsewhere; check that it declares no approval and that its handler declares no parameters or a context of the "app" scope, such as MutationContext<typeof requirements, "app">`,
        );
      return;
    }
    if (this.appsCallee(call.expression) !== "mutation") {
      if (!this.typed.has(call)) {
        this.typed.add(call);
        this.warn(
          call,
          `${schedule}: its mutation is made by ${this.text(call.expression)}, not mutation of apps; check that it declares no approval and that its handler declares no parameters or a context of the "app" scope, such as MutationContext<typeof requirements, "app">`,
        );
      }
      return;
    }
    const explicit = call.typeArguments;
    if (explicit !== undefined && !this.typed.has(call)) {
      this.typed.add(call);
      const warning = `${schedule}: its mutation's explicit type arguments give it the caller's context; pass MutationContext<typeof requirements, "app"> as the third`;
      if (explicit.length === 3) this.appType(explicit[2]!, schedule);
      else if (explicit.length !== 2) this.warn(call, warning);
      else {
        const type = this.appContextType(node, call, schedule, warning);
        if (type !== undefined) this.insert(explicit[1]!.end, `, ${type}`);
      }
    }
    const run = this.value(call.arguments[1]);
    const parameter = run !== undefined && isFunction(run) ? run.parameters[0] : undefined;
    if (parameter === undefined || this.typed.has(parameter)) return;
    this.typed.add(parameter);
    if (parameter.type !== undefined) this.appType(parameter.type, schedule);
    else if (explicit === undefined) this.appContext(node, parameter, schedule);
  }

  appType(type: ts.TypeNode, schedule: string) {
    const context = ts.isTypeReferenceNode(type) && this.appsType(type) === "MutationContext";
    const scope = context ? type.typeArguments : undefined;
    if (scope?.length === 1) this.insert(scope[0]!.end, ', "app"');
    else if (!(scope?.length === 2 && /^["']app["']$/.test(this.text(scope[1]!))))
      this.warn(
        type,
        `${schedule}: its handler's context is ${this.text(type)}; an app schedule needs one of the "app" scope, such as MutationContext<typeof requirements, "app">`,
      );
  }

  appContext(node: ts.Node, parameter: ts.ParameterDeclaration, schedule: string) {
    if (!this.piece.typescript) return;
    const warning = `${schedule}: its handler declares a context without a type, which is the caller's; type it MutationContext<typeof requirements, "app">, or declare no parameters`;
    if (parameter.dotDotDotToken !== undefined) return this.warn(parameter, warning);
    const type = this.appContextType(node, parameter, schedule, warning);
    if (type === undefined) return;
    const annotation = `: ${type}`;
    const end = (parameter.questionToken ?? parameter.name).end;
    const parenthesized = parameter.parent
      .getChildren(this.source)
      .some((child) => child.kind === ts.SyntaxKind.OpenParenToken);
    if (parenthesized) this.insert(end, annotation);
    else {
      this.insert(this.start(parameter), "(");
      this.insert(end, `${annotation})`);
    }
    if (parameter.questionToken !== undefined || parameter.initializer !== undefined)
      this.warn(
        parameter,
        `${schedule}: its handler's context is now typed, but is optional; \`mutation\` takes a typed context only when it is required, so remove the \`?\` or default by hand`,
      );
  }

  appContextType(
    node: ts.Node,
    at: ts.Node,
    schedule: string,
    warning: string,
  ): string | undefined {
    let app: ts.Node | undefined = node.parent;
    while (
      app !== undefined &&
      !(ts.isCallExpression(app) && this.appsExport(app.expression) === "defineApp")
    )
      app = app.parent;
    const requirements =
      app !== undefined && ts.isCallExpression(app) ? unwrap(app.arguments[0]!) : undefined;
    const empty =
      requirements !== undefined &&
      ts.isObjectLiteralExpression(requirements) &&
      requirements.properties.every((property) => nameOf(property.name) === "accounts");
    const argument =
      requirements !== undefined && ts.isIdentifier(requirements)
        ? `typeof ${requirements.text}`
        : empty
          ? "{}"
          : undefined;
    const imports = this.source.statements.find(
      (statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "apps" &&
        statement.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings),
    );
    if (argument === undefined || imports === undefined) {
      this.warn(at, warning);
      return undefined;
    }
    if (
      requirements !== undefined &&
      ts.isIdentifier(requirements) &&
      !this.visibleAt(requirements, at)
    ) {
      this.warn(
        at,
        `${schedule}: the app's requirements \`${requirements.text}\` are not in scope, or name something else, at its mutation; give its handler a context of the "app" scope by hand, such as MutationContext<typeof ${requirements.text}, "app">, declaring the requirements where both can see them`,
      );
      return undefined;
    }
    const clause = imports.importClause!;
    const elements = (clause.namedBindings as ts.NamedImports).elements;
    if (
      !this.contextImported &&
      !elements.some(
        (element) => element.name.text === "MutationContext" && element.propertyName === undefined,
      )
    ) {
      this.contextImported = true;
      this.insert(
        elements.at(-1)?.end ?? clause.namedBindings!.end - 1,
        `${elements.length === 0 ? "" : ", "}${clause.isTypeOnly ? "" : "type "}MutationContext`,
      );
    }
    return `MutationContext<${argument}, "app">`;
  }

  imports() {
    this.visit((node) => {
      if (
        !ts.isImportDeclaration(node) ||
        !ts.isStringLiteral(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== "apps" ||
        node.importClause?.namedBindings === undefined ||
        !ts.isNamedImports(node.importClause.namedBindings)
      )
        return;
      const elements = node.importClause.namedBindings.elements;
      const imported = new Set(elements.map((element) => element.name.text));
      const added = new Set<string>();
      for (const [index, element] of elements.entries()) {
        const name = element.name.text;
        if (element.propertyName !== undefined || (name !== "cron" && name !== "interval"))
          continue;
        const kind = name === "cron" ? "Cron" : "Interval";
        const used = [...this.facts.constructors].filter((other) => other.endsWith(kind));
        if (this.unrenamed(element.name)) {
          const fresh = used.filter((other) => !imported.has(other) && !added.has(other));
          for (const other of fresh) added.add(other);
          if (fresh.length > 0) this.insert(element.end, `, ${fresh.join(", ")}`);
          continue;
        }
        const names =
          used.length > 0 ? used : [`${this.facts.hasUser === false ? "app" : "user"}${kind}`];
        if (used.length === 0)
          this.warn(
            element,
            `the import of ${name} became ${names[0]}, chosen by the app's requirements; its schedules are written elsewhere`,
          );
        const fresh = names.filter((other) => !imported.has(other) && !added.has(other));
        for (const other of fresh) added.add(other);
        if (fresh.length === 0) this.removeElement(elements, index);
        else this.replace(this.start(element), element.end, fresh.join(", "));
      }
    });
  }

  factory() {
    if (this.edits.length === 0) return;
    this.visit((node) => {
      if (!ts.isCallExpression(node) || this.appsExport(node.expression) !== "defineApp") return;
      const definition = node.arguments[1] === undefined ? undefined : unwrap(node.arguments[1]);
      if (definition === undefined || !isFunction(definition)) return;
      const parameter = definition.parameters[0];
      if (parameter === undefined) return;
      const reads = ts.isObjectBindingPattern(parameter.name)
        ? parameter.name.elements.some(
            (element) => nameOf(element.propertyName ?? element.name) === "user",
          )
        : ts.isIdentifier(parameter.name) &&
          this.references(parameter.name, definition).some(
            (reference) =>
              ts.isPropertyAccessExpression(reference.parent) &&
              reference.parent.name.text === "user",
          );
      const appWork =
        this.facts.hasApp || [...this.facts.constructors].some((name) => name.startsWith("app"));
      if (reads && (this.facts.typed || appWork))
        this.warn(
          parameter,
          "the app's factory reads the caller's accounts, but `user` is absent while the app runs without a caller; handle `user === undefined` there",
        );
    });
  }
}

const rewriteLiteral = (
  source: ts.SourceFile,
  node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression,
  facts: AppFacts,
  warn: Warn,
): Rewrite[] => {
  const { piece, substitutions } = literalPiece(source, node);
  const rewrite = new Rewrite(piece, facts, warn);
  rewrite.run();
  const nested: Rewrite[] = [];
  for (const expression of substitutions)
    walk(source, expression, (child) => {
      if (isLiteral(child) && !nested.some((done) => contains(done, child)))
        nested.push(...rewriteLiteral(source, child, facts, warn));
    });
  return [rewrite, ...nested];
};

const contains = (rewrite: Rewrite, node: ts.Node) =>
  rewrite.piece.offsets[0]! <= node.pos && node.end <= rewrite.piece.offsets.at(-1)!;

const isLiteral = (
  node: ts.Node,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression =>
  ts.isStringLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node) ||
  ts.isTemplateExpression(node);

const finish = (rewrites: readonly Rewrite[]) => {
  for (const rewrite of rewrites) rewrite.imports();
  for (const rewrite of rewrites) rewrite.factory();
  for (const rewrite of rewrites) rewrite.unparsed();
  return rewrites.flatMap((rewrite) => rewrite.edits);
};

const scriptKind = (file: string) =>
  file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

const marker =
  /\bdefineApp\b|\bfrom\s*["']apps(?:\/[\w/-]+)?["']|\b(?:ctx|context|step)\.accounts\b|\w*Context\s*<\s*(?:typeof|\{)/;

const importsApps = (source: ts.SourceFile) =>
  source.statements.some(
    (statement) =>
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      isAppsModule(statement.moduleSpecifier),
  );

const rewriteScript = (file: string, text: string, warn: Warn) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  if (importsApps(source)) {
    const rewrite = new Rewrite(
      plainPiece(text, 0, scriptKind(file), /\.[mc]?tsx?$/.test(file)),
      newFacts(true),
      warn,
    );
    rewrite.run();
    return applyEdits(text, finish([rewrite]));
  }
  const edits: Edit[] = [];
  const visit = (node: ts.Node) => {
    if (kept(source, node)) return;
    if (isLiteral(node) && marker.test(node.getText(source))) {
      edits.push(...finish(rewriteLiteral(source, node, newFacts(false), warn)));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return applyEdits(text, edits);
};

const rewriteMarkdown = (file: string, text: string, warn: Warn) => {
  const edits: Edit[] = [];
  const fence =
    /^([ \t]*)(```|~~~)(ts|tsx|typescript|js|jsx|javascript|mjs)\b[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm;
  for (const match of text.matchAll(fence)) {
    const before = text.slice(0, match.index).trimEnd();
    if (before.slice(before.lastIndexOf("\n") + 1).includes(keepMarker)) continue;
    const body = match[4]!;
    if (!marker.test(body) && !/\baccounts\b|\b(?:cron|interval)\s*\(/.test(body)) continue;
    const offset = match.index + match[0].indexOf("\n") + 1;
    const kind = /^(tsx|jsx)$/.test(match[3]!) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const rewrite = new Rewrite(
      plainPiece(body, offset, kind, /^(ts|tsx|typescript)$/.test(match[3]!)),
      newFacts(true),
      warn,
    );
    rewrite.run();
    edits.push(...finish([rewrite]));
  }
  return applyEdits(text, edits);
};

const rewriteFile = (file: string, warn: Warn) => {
  const text = readFileSync(file, "utf8");
  const rewritten = markdownExtensions.has(extname(file))
    ? rewriteMarkdown(file, text, warn)
    : rewriteScript(file, text, warn);
  return { text, rewritten };
};

const filesUnder = (path: string): string[] => {
  if (!statSync(path).isDirectory())
    return scriptExtensions.has(extname(path)) || markdownExtensions.has(extname(path))
      ? [path]
      : [];
  return readdirSync(path)
    .filter((entry) => !skippedDirectories.has(entry))
    .flatMap((entry) => filesUnder(join(path, entry)));
};

const args = process.argv.slice(2);
const check = args.includes("--check");
const paths = args.filter((arg) => arg !== "--check");
if (paths.length === 0) {
  console.error(
    "Usage: node scripts/codemods/app-user-accounts.ts [--check] <file or directory>...",
  );
  process.exit(2);
}

const warnings: string[] = [];
const changed: string[] = [];
for (const file of paths.flatMap(filesUnder)) {
  const found: { message: string; offset: number }[] = [];
  const { text, rewritten } = rewriteFile(file, (message, offset) =>
    found.push({ message, offset }),
  );
  for (const { message, offset } of found.sort((left, right) => left.offset - right.offset))
    warnings.push(`warning: ${file}:${text.slice(0, offset).split("\n").length}: ${message}`);
  if (rewritten === text) continue;
  changed.push(file);
  if (!check) writeFileSync(file, rewritten);
}
for (const file of changed) console.log(`${check ? "would rewrite" : "rewrote"} ${file}`);
for (const warning of warnings) console.warn(warning);
console.log(
  `${changed.length} file${changed.length === 1 ? "" : "s"} ${check ? "to rewrite" : "rewritten"}.`,
);
if (check && changed.length > 0) process.exit(1);
