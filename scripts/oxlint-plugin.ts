/**
 * Repository lint rules. `.oxlintrc.jsonc` chooses the files each rule covers.
 * Adapted from the rat-stack Oxlint plugins.
 */
import { definePlugin, defineRule, type ESTree } from "@oxlint/plugins";

/** True when a `var` binding is hoisted to module scope rather than into a function. */
const hoistedToModule = (node: ESTree.Node) => {
  for (let current = node.parent; current !== null; current = current.parent) {
    switch (current.type) {
      case "Program":
        return true;
      case "ArrowFunctionExpression":
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "StaticBlock":
      case "TSModuleBlock":
        return false;
    }
  }
  return false;
};

/** `let` is module state only when declared directly in the module body. */
const declaredInModuleBody = (node: ESTree.VariableDeclaration) =>
  node.parent.type === "Program" ||
  (node.parent.type === "ExportNamedDeclaration" && node.parent.parent.type === "Program");

const noModuleLevelMutableState = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep mutable state out of module-level let and var bindings." },
    messages: {
      moduleState:
        "Module-level let and var are shared by every request a Worker isolate or server process handles. Keep state in a Ref or service owned by a Layer, or in storage.",
    },
  },
  create: (context) => ({
    VariableDeclaration(node) {
      if (node.declare || (node.kind !== "let" && node.kind !== "var")) return;
      if (node.kind === "let" ? declaredInModuleBody(node) : hoistedToModule(node))
        context.report({ node, messageId: "moduleState" });
    },
  }),
});

const runners = new Set([
  "runCallback",
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseExitWith",
  "runPromiseWith",
  "runSync",
  "runSyncExit",
  "runSyncExitWith",
  "runSyncWith",
]);

/** `Effect.runPromise(...)` and friends, or `ManagedRuntime.make(...)`. */
const manualRunner = (callee: ESTree.Node) => {
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier" ||
    callee.property.type !== "Identifier"
  )
    return undefined;
  const call = `${callee.object.name}.${callee.property.name}`;
  if (callee.object.name === "Effect" && runners.has(callee.property.name)) return call;
  if (call === "ManagedRuntime.make") return call;
  return undefined;
};

const noManualEffectRuntimeInTests = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Run scenario Effects through @effect/vitest instead of starting a runtime by hand.",
    },
    messages: {
      manualRunner:
        "{{call}} runs an Effect outside the scenario's runtime. Use @effect/vitest `layer` and `it.effect`, and inject capabilities as services. Bridges to Promise callbacks need a disable comment saying which API requires one.",
    },
  },
  create: (context) => ({
    CallExpression(node) {
      const call = manualRunner(node.callee);
      if (call !== undefined)
        context.report({ node: node.callee, messageId: "manualRunner", data: { call } });
    },
  }),
});

/** Effects whose waiters resume when another fiber finishes shared, in-flight work. */
const sharedWaits = new Map([
  ["Effect", new Set(["cached", "cachedWithTTL", "cachedInvalidateWithTTL"])],
  ["Deferred", new Set(["make", "makeUnsafe"])],
  ["Semaphore", new Set(["make", "makeUnsafe"])],
  ["Latch", new Set(["make", "makeUnsafe"])],
  ["Cache", new Set(["make", "makeWith"])],
  ["RcMap", new Set(["make"])],
]);

/** `Effect.cached(...)` and the other constructors above, by their written name. */
const sharedWait = (callee: ESTree.Node) => {
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier" ||
    callee.property.type !== "Identifier"
  )
    return undefined;
  return sharedWaits.get(callee.object.name)?.has(callee.property.name)
    ? `${callee.object.name}.${callee.property.name}`
    : undefined;
};

/** `Effect.gen(...)`, possibly followed by `.pipe(...)`, unwrapped to its generator. */
const generatorOf = (node: ESTree.Node): ESTree.Node | undefined => {
  if (node.type !== "CallExpression") return undefined;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  if (callee.property.type === "Identifier" && callee.property.name === "pipe")
    return generatorOf(callee.object);
  if (
    callee.object.type === "Identifier" &&
    callee.object.name === "Effect" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "gen"
  )
    return node.arguments.find((argument) => argument.type === "FunctionExpression");
  return undefined;
};

/**
 * The generator that initializes a Worker's handlers: the second argument of
 * `export default Entrypoint.make(props, Effect.gen(...))`. It runs once per isolate, and every
 * request the isolate serves uses what it returns.
 */
const isWorkerInitialization = (fn: ESTree.Node) => {
  const gen = fn.parent;
  if (gen?.type !== "CallExpression") return false;
  let handlers: ESTree.Node = gen;
  while (
    handlers.parent?.type === "MemberExpression" &&
    handlers.parent.parent?.type === "CallExpression"
  )
    handlers = handlers.parent.parent;
  const make = handlers.parent;
  return (
    make?.type === "CallExpression" &&
    make.arguments.length === 2 &&
    make.arguments[1] === handlers &&
    generatorOf(handlers) === fn &&
    make.callee.type === "MemberExpression" &&
    make.callee.property.type === "Identifier" &&
    make.callee.property.name === "make" &&
    make.parent?.type === "ExportDefaultDeclaration"
  );
};

/** The nearest function around a node. */
const enclosingFunction = (node: ESTree.Node) => {
  for (let current = node.parent; current !== null; current = current.parent)
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression"
    )
      return current;
  return undefined;
};

const noSharedWaitInWorkerInitialization = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep in-flight work that several requests can wait on out of a Worker's initialization.",
    },
    messages: {
      sharedWait:
        "{{call}} in a Worker's initialization is shared by every request the isolate serves. A request that waits on it resumes in the I/O context of the request that finished it: its timers can be dropped when that request ends, and its Dynamic Workers count against that request's limit. Create it per call, or keep only settled values.",
    },
  },
  create: (context) => ({
    CallExpression(node) {
      const call = sharedWait(node.callee);
      if (call === undefined) return;
      const fn = enclosingFunction(node);
      if (fn !== undefined && isWorkerInitialization(fn))
        context.report({ node: node.callee, messageId: "sharedWait", data: { call } });
    },
  }),
});

/** The named type of `x as T`, `<T>x` or `x satisfies T`, including `ns.T`. */
const assertedTypeName = (type: ESTree.TSType) => {
  if (type.type !== "TSTypeReference") return undefined;
  const name = type.typeName;
  if (name.type === "Identifier") return name.name;
  if (name.type === "TSQualifiedName") return name.right.name;
  return undefined;
};

const noProofForgery = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Mint authorization proofs only in their proofs module." },
    messages: {
      forged:
        "{{name}} is evidence that a policy check passed. Obtain it from the proofs module that runs the check instead of asserting the type.",
    },
  },
  create: (context) => {
    const check = (node: ESTree.TSAsExpression | ESTree.TSTypeAssertion) => {
      const name = assertedTypeName(node.typeAnnotation);
      if (name !== undefined && name.endsWith("Proof"))
        context.report({ node, messageId: "forged", data: { name } });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
});

/** Effect functions that wait on a Promise or an async iterable, by the module that exports them. */
const promiseBridges = new Map([
  ["Effect", new Set(["tryPromise", "promise"])],
  ["Stream", new Set(["fromAsyncIterable", "fromReadableStream"])],
  ["Channel", new Set(["fromAsyncIterable", "fromAsyncIterableArray", "fromReadableStream"])],
]);

const fromEffect = (source: string) =>
  source === "effect" || source.startsWith("effect/") || source.startsWith("@effect/");

/** A member's name when it is written statically: `a.b`, `a["b"]` or `` a[`b`] ``. */
const staticKey = (node: ESTree.MemberExpression) => {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : undefined;
  const key = node.property;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  if (key.type === "TemplateLiteral" && key.expressions.length === 0)
    return key.quasis[0]?.value.cooked ?? undefined;
  return undefined;
};

/** A destructured property's name when it is written statically: `{ a }`, `{ a: b }`, `{ "a": b }`. */
const propertyKey = (node: { readonly computed: boolean; readonly key: ESTree.PropertyKey }) => {
  if (node.computed)
    return node.key.type === "Literal" && typeof node.key.value === "string"
      ? node.key.value
      : undefined;
  if (node.key.type === "Identifier") return node.key.name;
  return node.key.type === "Literal" && typeof node.key.value === "string"
    ? node.key.value
    : undefined;
};

/** Browser APIs that exist only in secure contexts, by the global that holds them. */
const secureContextOnly = new Map([
  ["crypto", new Set(["randomUUID", "subtle"])],
  ["navigator", new Set(["clipboard"])],
]);
/** Globals whose properties are the browser globals: `window.crypto`, `globalThis.navigator`. */
const globalObjects = new Set(["window", "globalThis", "self"]);
/** What an expression denotes: a global object, or the browser global that holds the APIs. */
type Holder = "global" | "crypto" | "navigator";

/** The holder reached by reading `key` from `holder`: `window.crypto` is `crypto`. */
const member = (holder: Holder | undefined, key: string | undefined): Holder | undefined => {
  if (holder !== "global" || key === undefined) return undefined;
  if (globalObjects.has(key)) return "global";
  return key === "crypto" || key === "navigator" ? key : undefined;
};
/** Whether reading `key` from `holder` is one of the secure-context-only APIs. */
const isSecureOnly = (holder: Holder | undefined, key: string | undefined) =>
  holder !== undefined && key !== undefined && secureContextOnly.get(holder)?.has(key) === true;

/** How far a chain of `const` aliases is followed before the rule gives up on it. */
const aliasDepth = 4;

/** The property keys from a binding pattern down to the identifier `name`; undefined if not static. */
const pathTo = (pattern: ESTree.Node, name: string): readonly string[] | undefined => {
  if (pattern.type === "Identifier") return pattern.name === name ? [] : undefined;
  if (pattern.type === "AssignmentPattern") return pathTo(pattern.left, name);
  if (pattern.type !== "ObjectPattern") return undefined;
  for (const property of pattern.properties) {
    if (property.type !== "Property") continue;
    const inner = pathTo(property.value, name);
    if (inner === undefined) continue;
    const key = propertyKey(property);
    return key === undefined ? undefined : [key, ...inner];
  }
  return undefined;
};

/**
 * Every read of `crypto.randomUUID`, `crypto.subtle` or `navigator.clipboard`, feature detection
 * included. Only the helpers that wrap them may read them; `.oxlintrc.jsonc` exempts those files.
 * The rule resolves names, not control flow: a guard never makes a read acceptable here.
 */
const noSecureContextApi = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep browser code off APIs that exist only in secure contexts." },
    messages: {
      secureOnly:
        "{{name}} is undefined on a plain HTTP origin other than localhost, where a self-hosted dashboard may be served. Call randomUuid from @executor-js/utils/random-uuid or copyText from @executor-js/ui/lib/clipboard instead. Any feature detection for it belongs inside such a helper.",
    },
  },
  create: (context) => {
    const source = context.sourceCode;

    /** The variable this file declares for a name at a node, if any; none means the global. */
    const declared = (node: ESTree.Node, name: string) => {
      for (
        let scope: ReturnType<typeof source.getScope> | null = source.getScope(node);
        scope;
        scope = scope.upper
      ) {
        const variable = scope.set.get(name);
        if (variable !== undefined && variable.defs.length > 0) return variable;
      }
      return undefined;
    };

    /** What an expression denotes, following `const` aliases and destructuring. */
    const denotes = (node: ESTree.Node, depth = 0): Holder | undefined => {
      if (depth > aliasDepth) return undefined;
      if (
        node.type === "ParenthesizedExpression" ||
        node.type === "TSNonNullExpression" ||
        node.type === "TSAsExpression" ||
        node.type === "TSSatisfiesExpression"
      )
        return denotes(node.expression, depth);
      if (node.type === "MemberExpression")
        return member(denotes(node.object, depth), staticKey(node));
      if (node.type !== "Identifier") return undefined;
      const variable = declared(node, node.name);
      // Oxlint's `isGlobalReference` needs the name in its configured globals; this needs no list.
      if (variable === undefined) {
        if (globalObjects.has(node.name)) return "global";
        return node.name === "crypto" || node.name === "navigator" ? node.name : undefined;
      }
      const [definition, ...others] = variable.defs;
      if (definition === undefined || others.length > 0 || definition.type !== "Variable")
        return undefined;
      const declarator = definition.node;
      const declaration = definition.parent;
      if (
        declarator.type !== "VariableDeclarator" ||
        declaration?.type !== "VariableDeclaration" ||
        declaration.kind !== "const" ||
        declarator.init === null
      )
        return undefined;
      // `const c = crypto` aliases it; `const { crypto: { subtle } } = window` reads a path from it.
      const path = pathTo(declarator.id, node.name);
      if (path === undefined) return undefined;
      return path.reduce<Holder | undefined>(
        (holder, key) => member(holder, key),
        denotes(declarator.init, depth + 1),
      );
    };

    const report = (node: ESTree.Node, holder: Holder, key: string) =>
      context.report({ node, messageId: "secureOnly", data: { name: `${holder}.${key}` } });

    /** Report each secure-context-only API a destructuring pattern reads from `holder`. */
    const destructured = (pattern: ESTree.Node, holder: Holder | undefined) => {
      if (holder === undefined) return;
      if (pattern.type === "AssignmentPattern") return destructured(pattern.left, holder);
      if (pattern.type !== "ObjectPattern") return;
      for (const property of pattern.properties) {
        if (property.type !== "Property") continue;
        const key = propertyKey(property);
        if (key !== undefined && isSecureOnly(holder, key)) report(property, holder, key);
        else destructured(property.value, member(holder, key));
      }
    };

    return {
      MemberExpression(node) {
        const holder = denotes(node.object);
        const key = staticKey(node);
        if (holder !== undefined && key !== undefined && isSecureOnly(holder, key))
          report(node, holder, key);
      },
      // `const { randomUUID } = crypto` reads it as surely as `crypto.randomUUID`, at any depth.
      VariableDeclarator(node) {
        if (node.init !== null) destructured(node.id, denotes(node.init));
      },
    };
  },
});

/**
 * Resolves names the way a file imports them: `import { Effect as Fx } from "effect"`,
 * `import * as Fx from "effect/Effect"`, `import * as effect from "effect"` (then `effect.Effect`),
 * `const Fx = Effect`, and bridges imported or destructured by name. Syntactic only: a module passed
 * through a function, reassigned, or reached through a helper in another file is not followed.
 */
const effectBindings = () => {
  /** Local name to the Effect module it is. */
  const modules = new Map<string, string>();
  /** `import * as effect from "effect"`. */
  const namespaces = new Set<string>();
  /** Local names bound directly to a bridge, such as `const { tryPromise } = Effect`. */
  const bridges = new Map<string, string>();
  /** Every name imported from an Effect package: a module, never a Promise. */
  const imported = new Set<string>();
  const moduleOf = (node: ESTree.Node): string | undefined => {
    // `(Effect as Record<string, unknown>)[key]` is still Effect.
    if (
      node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "TSNonNullExpression" ||
      node.type === "TSTypeAssertion"
    )
      return moduleOf(node.expression);
    if (node.type === "Identifier") return modules.get(node.name);
    if (
      node.type === "MemberExpression" &&
      node.object.type === "Identifier" &&
      namespaces.has(node.object.name)
    ) {
      const key = staticKey(node);
      return key !== undefined && promiseBridges.has(key) ? key : undefined;
    }
    return undefined;
  };
  /** The bridge a callee names, such as `Fx.tryPromise` or a destructured `tryPromise`. */
  const bridgeOf = (callee: ESTree.Node) => {
    if (callee.type === "Identifier") return bridges.get(callee.name);
    if (callee.type !== "MemberExpression") return undefined;
    const module = moduleOf(callee.object);
    const key = staticKey(callee);
    return module !== undefined && key !== undefined && promiseBridges.get(module)?.has(key)
      ? `${module}.${key}`
      : undefined;
  };
  const isEffectValue = (node: ESTree.Node) =>
    (node.type === "Identifier" && (imported.has(node.name) || modules.has(node.name))) ||
    moduleOf(node) !== undefined;
  return { modules, namespaces, bridges, imported, moduleOf, bridgeOf, isEffectValue };
};

/** `x.then(...)`, `x.catch(...)` or `x.finally(...)` on a value, not on an Effect module. */
const promiseChain = (callee: ESTree.Node, isEffectValue: (node: ESTree.Node) => boolean) => {
  if (callee.type !== "MemberExpression") return undefined;
  const key = staticKey(callee);
  if (key === undefined || !["then", "catch", "finally"].includes(key)) return undefined;
  return isEffectValue(callee.object) ? undefined : `.${key}`;
};

/** True inside a function a bridge waits on, `Effect.tryPromise(async () => ...)`: the bridge is reported. */
const insideBridge = (node: ESTree.Node, bridgeOf: (callee: ESTree.Node) => string | undefined) => {
  const fn = enclosingFunction(node);
  if (fn === undefined) return false;
  let argument: ESTree.Node = fn;
  if (fn.parent?.type === "Property" && fn.parent.parent?.type === "ObjectExpression")
    argument = fn.parent.parent;
  return (
    argument.parent?.type === "CallExpression" &&
    argument.parent.arguments.includes(argument as ESTree.Expression) &&
    bridgeOf(argument.parent.callee) !== undefined
  );
};

/**
 * A guard against the common ways framework code waits on an app's Promise without the adapter.
 * It cannot be complete: without type information it cannot tell a Promise from another value, or
 * follow a callback into a helper in another file or package. The tool-call timing scenarios in
 * `e2e/tests/tool-call-overhead.spec.ts` are the backstop.
 */
const authoredCodeThroughAdapter = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Wait on Promises only through fromPromise, so an app's own code is timed as the app's.",
    },
    messages: {
      bridge:
        "{{call}} waits on a Promise outside fromPromise. If any function in it can come from an app (a callback, or a method of a value the app passed, such as its cache), use fromPromise(callback, code) so its time is the app's. Otherwise add a disable comment naming the API that is not the app's.",
      wait: "{{call}} waits on a Promise outside fromPromise. If it can be an app's callback or a method of a value the app passed, such as its cache, use fromPromise(callback, code) so its time is the app's. Otherwise add a disable comment naming the API that is not the app's.",
      dynamic:
        "{{module}}[...] picks a member this rule cannot name, so a Promise bridge could hide behind it. Write the member statically.",
      receiver:
        'fromPromise(target.method) calls the method without its object, so a method that uses `this` fails. Pass method(target, "name") instead.',
    },
  },
  create: (context) => {
    const names = effectBindings();
    const record = (local: string, module: string, key: string | undefined, node: ESTree.Node) => {
      if (key === undefined) return;
      if (promiseBridges.get(module)?.has(key)) {
        names.bridges.set(local, `${module}.${key}`);
        context.report({ node, messageId: "bridge", data: { call: `${module}.${key}` } });
      }
    };
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (!fromEffect(source)) return;
        // `effect/Effect`, `effect/Stream`: the module itself.
        const direct = source.startsWith("effect/") ? source.slice("effect/".length) : undefined;
        for (const specifier of node.specifiers) {
          names.imported.add(specifier.local.name);
          if (specifier.type === "ImportNamespaceSpecifier") {
            if (source === "effect") names.namespaces.add(specifier.local.name);
            else if (direct !== undefined && promiseBridges.has(direct))
              names.modules.set(specifier.local.name, direct);
            continue;
          }
          if (specifier.type !== "ImportSpecifier") continue;
          const imported =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : String(specifier.imported.value);
          if (source === "effect" && promiseBridges.has(imported))
            names.modules.set(specifier.local.name, imported);
          else if (direct !== undefined) record(specifier.local.name, direct, imported, specifier);
        }
      },
      VariableDeclarator(node) {
        if (node.init === null) return;
        const module = names.moduleOf(node.init);
        if (module === undefined) return;
        // `const Fx = Effect`
        if (node.id.type === "Identifier") names.modules.set(node.id.name, module);
        // `const { tryPromise: run } = Effect`
        if (node.id.type !== "ObjectPattern") return;
        for (const property of node.id.properties) {
          if (property.type !== "Property") continue;
          const key =
            property.key.type === "Identifier" && !property.computed
              ? property.key.name
              : property.key.type === "Literal" && typeof property.key.value === "string"
                ? property.key.value
                : undefined;
          const local =
            property.value.type === "Identifier"
              ? property.value.name
              : property.value.type === "AssignmentPattern" &&
                  property.value.left.type === "Identifier"
                ? property.value.left.name
                : undefined;
          if (key === undefined)
            context.report({ node: property, messageId: "dynamic", data: { module } });
          else if (local !== undefined) record(local, module, key, property);
        }
      },
      MemberExpression(node) {
        const module = names.moduleOf(node.object);
        if (module === undefined) return;
        const key = staticKey(node);
        if (key === undefined) {
          context.report({ node, messageId: "dynamic", data: { module } });
          return;
        }
        // Reported where it is named, so `const run = Effect.tryPromise` is caught too.
        if (promiseBridges.get(module)?.has(key))
          context.report({ node, messageId: "bridge", data: { call: `${module}.${key}` } });
      },
      CallExpression(node) {
        const callee = node.callee;
        const [first] = node.arguments;
        if (
          callee.type === "Identifier" &&
          callee.name === "fromPromise" &&
          first?.type === "MemberExpression"
        )
          context.report({ node: first, messageId: "receiver" });
        const chain = promiseChain(callee, names.isEffectValue);
        if (chain !== undefined && !insideBridge(node, names.bridgeOf))
          context.report({ node: callee, messageId: "wait", data: { call: chain } });
      },
      AwaitExpression(node) {
        if (!insideBridge(node, names.bridgeOf))
          context.report({ node, messageId: "wait", data: { call: "await" } });
      },
      ForOfStatement(node) {
        if (node.await && !insideBridge(node, names.bridgeOf))
          context.report({ node, messageId: "wait", data: { call: "for await" } });
      },
    };
  },
});

/** Calls along a fluent chain such as `endpoint.annotate(...).pipe(...)`, outermost first. */
function* chainCalls(node: ESTree.Node): Generator<ESTree.CallExpression> {
  let current: ESTree.Node = node;
  while (current.type === "CallExpression") {
    yield current;
    const callee: ESTree.Node = current.callee;
    if (callee.type !== "MemberExpression") return;
    current = callee.object;
  }
}

/** The outermost call of the fluent chain that `node` belongs to. */
const chainRoot = (node: ESTree.CallExpression) => {
  let current: ESTree.Node = node;
  for (;;) {
    const member: ESTree.Node | null = current.parent;
    if (member?.type !== "MemberExpression" || member.object !== current) return current;
    const call: ESTree.Node | null = member.parent;
    if (call?.type !== "CallExpression" || call.callee !== member) return current;
    current = call;
  }
};

const isMethodCall = (node: ESTree.CallExpression, method: string, argument: RegExp) =>
  node.callee.type === "MemberExpression" &&
  !node.callee.computed &&
  node.callee.property.type === "Identifier" &&
  node.callee.property.name === method &&
  node.arguments[0]?.type === "Identifier" &&
  argument.test(node.arguments[0].name);

/** `.pipe(..., requireAccount.<action>, ...)` */
const pipesRequireAccount = (node: ESTree.CallExpression) =>
  node.callee.type === "MemberExpression" &&
  node.callee.property.type === "Identifier" &&
  node.callee.property.name === "pipe" &&
  node.arguments.some(
    (argument) =>
      argument.type === "MemberExpression" &&
      argument.object.type === "Identifier" &&
      argument.object.name === "requireAccount",
  );

const accountMiddlewareThroughHelper = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Declare account endpoints only through requireAccount." },
    messages: {
      bare: "Use endpoint.pipe(requireAccount.<action>): it checks that the endpoint decodes an `account` path parameter, which {{name}} reads.",
      action:
        "requireAccount sets this endpoint's RequiredAction from its account middleware; do not annotate it separately.",
    },
  },
  create: (context) => ({
    CallExpression(node) {
      if (isMethodCall(node, "middleware", /^RequireAccount[A-Z]/)) {
        const argument = node.arguments[0];
        if (argument?.type === "Identifier")
          context.report({ node, messageId: "bare", data: { name: argument.name } });
        return;
      }
      if (!isMethodCall(node, "annotate", /^RequiredAction$/)) return;
      if ([...chainCalls(chainRoot(node))].some(pipesRequireAccount))
        context.report({ node, messageId: "action" });
    },
  }),
});

/** The flags `Schema.isPattern` can export: Unicode, optionally with `d`, `g` or `y`. */
const exportableFlags = /^[dg]*uy?$/u;

const exportableSchemaPattern = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Give Schema.isPattern a RegExp that Effect can export to JSON Schema.",
    },
    messages: {
      notExported:
        "Effect leaves this pattern out of JSON Schema and OpenAPI documents: it exports only Unicode RegExps whose other flags are d, g or y. Add the u flag (write both letter cases instead of i) and check the RegExp still matches the same strings.",
    },
  },
  create: (context) => ({
    CallExpression(node) {
      const callee = node.callee;
      const name =
        callee.type === "Identifier"
          ? callee.name
          : callee.type === "MemberExpression" &&
              !callee.computed &&
              callee.property.type === "Identifier"
            ? callee.property.name
            : undefined;
      const pattern = node.arguments[0];
      if (
        name === "isPattern" &&
        pattern?.type === "Literal" &&
        "regex" in pattern &&
        pattern.regex !== undefined &&
        !exportableFlags.test(pattern.regex.flags)
      )
        context.report({ node: pattern, messageId: "notExported" });
    },
  }),
});

/** `process.stdout.fd` or `process.stderr.fd`. */
const isStdioFd = (node: ESTree.Node) =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.property.type === "Identifier" &&
  node.property.name === "fd" &&
  node.object.type === "MemberExpression" &&
  !node.object.computed &&
  node.object.property.type === "Identifier" &&
  (node.object.property.name === "stdout" || node.object.property.name === "stderr") &&
  node.object.object.type === "Identifier" &&
  node.object.object.name === "process";

/** A descriptor or path that names stdout or stderr: 1, 2, `process.stdout.fd`, `/dev/stderr`. */
const namesStdio = (node: ESTree.Node | undefined) =>
  node !== undefined &&
  ((node.type === "Literal" &&
    (node.value === 1 ||
      node.value === 2 ||
      node.value === "/dev/stdout" ||
      node.value === "/dev/stderr")) ||
    isStdioFd(node));

const syncWrites = new Set(["writeSync", "writeFileSync", "appendFileSync"]);

const noSyncStdioWrite = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Write stdout and stderr through a stream, never synchronously." },
    messages: {
      syncStdio:
        "{{call}} to stdout or stderr waits for its reader. A pipe nobody reads blocks it for good: on Windows always, and on Linux and macOS when the process never opened that stream. The process then cannot answer or exit, as the local server's exit line once did. Write through the process's output stream (processOutput in the local CLI), which waits without blocking.",
    },
  },
  create: (context) => ({
    CallExpression(node) {
      const callee = node.callee;
      const name =
        callee.type === "Identifier"
          ? callee.name
          : callee.type === "MemberExpression" &&
              !callee.computed &&
              callee.property.type === "Identifier"
            ? callee.property.name
            : undefined;
      if (name !== undefined && syncWrites.has(name) && namesStdio(node.arguments[0]))
        context.report({ node, messageId: "syncStdio", data: { call: name } });
    },
  }),
});

export default definePlugin({
  meta: { name: "executor" },
  rules: {
    "no-module-level-mutable-state": noModuleLevelMutableState,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-shared-wait-in-worker-initialization": noSharedWaitInWorkerInitialization,
    "no-proof-forgery": noProofForgery,
    "account-middleware-through-helper": accountMiddlewareThroughHelper,
    "exportable-schema-pattern": exportableSchemaPattern,
    "authored-code-through-adapter": authoredCodeThroughAdapter,
    "no-secure-context-api": noSecureContextApi,
    "no-sync-stdio-write": noSyncStdioWrite,
  },
});
