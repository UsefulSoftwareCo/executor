import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript-5";
import { code, table, type Page } from "./markdown.ts";
import { meanings, settingDetails } from "./self-host-meanings.ts";

export interface Setting {
  readonly key: string;
  readonly imageDefault?: string;
  readonly type: string;
  readonly fallback: string;
}

const host = "apps/hosted/self-host";
const shared = [
  "apps/hosted/server/src/implementation/auth.ts",
  "apps/hosted/server/src/implementation/oauth-client-metadata.ts",
  "apps/hosted/server/src/implementation/desktop-sessions.ts",
  "packages/sdk/src/implementation/declaration-config.ts",
  "packages/catalog/src/contracts/catalog.ts",
  "packages/telemetry/src/config.ts",
  "packages/telemetry/src/product-analytics.ts",
  "packages/utils/src/url-policy.ts",
];
const constants = [
  "apps/hosted/server/src/contracts/desktop-sessions.ts",
  "packages/mcp/src/contracts/execute.ts",
  "packages/sdk/src/contracts/declarations.ts",
  "packages/sdk/src/contracts/registry.ts",
  "packages/sdk/src/contracts/schedule-worker.ts",
  "packages/utils/src/release-version.ts",
];

const configTypes: Readonly<Record<string, string>> = {
  Boolean: "boolean",
  Int: "integer",
  NonEmptyString: "nonempty string",
  Number: "number",
  Redacted: "secret string",
  String: "string",
  URL: "URL",
  Record: "comma-separated key=value pairs",
};

const configCall = (
  node: ts.Node,
): node is ts.CallExpression & { expression: ts.PropertyAccessExpression } =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.expression.getText() === "Config";

export const imageSettings = [
  "EXECUTOR_BUILD_VERSION",
  "EXECUTOR_DATA_DIR",
  "EXECUTOR_ENVIRONMENT",
  "EXECUTOR_MOTEL_DATA_DIR",
  "HOST",
  "NODE_ENV",
  "PORT",
  "SSL_CERT_FILE",
] as const;
export const analyticsImageSettings = [
  "EXECUTOR_POSTHOG_HOST",
  "EXECUTOR_POSTHOG_PUBLIC_KEY",
] as const;

export function readSelfHostSettings(
  directory: string,
  imageDefaults: Readonly<Record<string, string>>,
): Setting[] {
  const read = (file: string) => readFileSync(join(directory, file), "utf8");
  const parse = (file: string) =>
    ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const sources = [
    ...readdirSync(join(directory, host, "src"), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .map((file) => `${host}/src/${file}`),
    ...shared,
  ]
    .sort()
    .map(parse);
  const definitions = new Map<string, ts.Expression>();
  for (const source of [...sources, ...constants.map(parse)]) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const { name, initializer } of statement.declarationList.declarations)
        if (ts.isIdentifier(name) && initializer !== undefined)
          definitions.set(name.text, initializer);
    }
  }
  const literal = (node: ts.Expression): unknown => {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
    if (ts.isAsExpression(node)) return literal(node.expression);
    if (ts.isIdentifier(node)) {
      const value = definitions.get(node.text);
      if (value !== undefined) return literal(value);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const declaration = definitions.get(node.expression.getText());
      const object =
        declaration && ts.isAsExpression(declaration) ? declaration.expression : declaration;
      if (object && ts.isObjectLiteralExpression(object)) {
        const property = object.properties.find(
          (property) => property.name?.getText() === node.name.text,
        );
        if (property && ts.isPropertyAssignment(property)) return literal(property.initializer);
      }
    }
    if (ts.isBinaryExpression(node)) {
      const left = literal(node.left);
      const right = literal(node.right);
      if (typeof left === "number" && typeof right === "number") {
        switch (node.operatorToken.kind) {
          case ts.SyntaxKind.AsteriskToken:
            return left * right;
          case ts.SyntaxKind.AsteriskAsteriskToken:
            return left ** right;
          case ts.SyntaxKind.SlashToken:
            return left / right;
        }
      }
    }
    throw new Error(`Cannot read configuration default ${node.getText()}`);
  };

  const settings = new Map<string, Omit<Setting, "key">>();
  const add = (name: string, type: string, fallback: string) => {
    const previous = settings.get(name);
    if (
      previous === undefined ||
      previous.fallback === "Required" ||
      (previous.fallback === "Unset" && !["Unset", "Required"].includes(fallback))
    ) {
      settings.set(name, { type, fallback });
    }
  };
  const defaults = (node: ts.CallExpression) => {
    const pipe = node.parent.parent;
    if (
      !ts.isCallExpression(pipe) ||
      !ts.isPropertyAccessExpression(pipe.expression) ||
      pipe.expression.expression !== node ||
      pipe.expression.name.text !== "pipe"
    )
      return "Required";
    const options = pipe.arguments.filter(configCall);
    const value = options.find(({ expression }) => expression.name.text === "withDefault")
      ?.arguments[0];
    if (value !== undefined) return code(JSON.stringify(literal(value)));
    return pipe.arguments.some((argument) => argument.getText() === "Config.option")
      ? "Unset"
      : "Required";
  };

  const visit = (node: ts.Node) => {
    if (configCall(node)) {
      const method = node.expression.name.text;
      const key = node.arguments.at(-1);
      const type =
        method === "schema" &&
        node.arguments[0]?.getText() === "Schema.fromJsonString(Schema.Array(HttpOrigin))"
          ? "JSON array of origins"
          : configTypes[method];
      if (key && ts.isStringLiteral(key) && (method === "schema" || /^[A-Z]/u.test(method))) {
        if (type === undefined) throw new Error(`Unknown configuration type for ${key.text}`);
        add(key.text, type, defaults(node));
      }
      if (type && key && ts.isTemplateExpression(key)) {
        const signal = node
          .getSourceFile()
          .text.match(/\(signal: ("TRACES" \| "LOGS" \| "METRICS")\)/u)?.[1];
        if (
          !signal ||
          key.templateSpans.length !== 1 ||
          key.templateSpans[0]?.expression.getText() !== "signal"
        )
          throw new Error(`Unsupported configuration key ${key.getText()}`);
        for (const [name] of signal.matchAll(/[A-Z]+/gu))
          add(key.head.text + name + key.templateSpans[0].literal.text, type, defaults(node));
      }
      if (
        type &&
        key &&
        ts.isIdentifier(key) &&
        key.text === "name" &&
        node.getSourceFile().fileName.endsWith("product-analytics.ts")
      ) {
        const loop = node.parent;
        let ancestor: ts.Node = loop;
        while (!ts.isForOfStatement(ancestor) && !ts.isSourceFile(ancestor))
          ancestor = ancestor.parent;
        if (!ts.isForOfStatement(ancestor) || !ts.isArrayLiteralExpression(ancestor.expression))
          throw new Error("Could not find the analytics opt-out keys");
        for (const item of ancestor.expression.elements) {
          if (!ts.isStringLiteral(item))
            throw new Error("Expected a literal analytics opt-out key");
          add(item.text, type, defaults(node));
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const type = { clientCount: "positive integer", nonNegative: "nonnegative number" }[
        node.expression.getText()
      ];
      if (type !== undefined) {
        const [key, fallback] = node.arguments;
        if (!key || !ts.isStringLiteral(key) || !fallback)
          throw new Error(`Unsupported configuration call ${node.getText()}`);
        add(key.text, type, code(JSON.stringify(literal(fallback))));
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const source of sources) visit(source);

  const oauth = read("apps/hosted/server/src/implementation/first-party-oauth.ts");
  const credentialNames = oauth.match(
    /const prefix = `([^$`]+)\$\{id\.toUpperCase\(\)\.replaceAll\("-", "_"\)\}`;\s*return \{ clientId: `\$\{prefix\}([A-Z_]+)`, clientSecret: `\$\{prefix\}([A-Z_]+)` \}/u,
  );
  const providers = [...oauth.matchAll(/^    id: "([a-z-]+)",$/gmu)];
  if (!credentialNames || providers.length === 0)
    throw new Error("Cannot read first-party OAuth setting names");
  for (const [, id] of providers) {
    const prefix = credentialNames[1]! + id!.toUpperCase().replaceAll("-", "_");
    add(prefix + credentialNames[2], "string", "Unset");
    add(prefix + credentialNames[3], "secret string", "Unset");
  }
  const testOAuth = oauth.match(/const testDefinitionsSetting = "([A-Z_]+)"/u)?.[1];
  if (testOAuth === undefined) throw new Error("Cannot read the OAuth test setting");
  add(testOAuth, "JSON array", "Unset");

  const bootstrap = read(`${host}/src/implementation/bootstrap.ts`);
  for (const [, resolver, key, file] of bootstrap.matchAll(
    /resolve(Secret|Identity)\(\s*"([A-Z_]+)",\s*"([^"]+)"/gu,
  )) {
    settings.set(key!, {
      type: resolver === "Secret" || key === "EXECUTOR_ANALYTICS_SECRET" ? "secret string" : "UUID",
      fallback: `Read ${code(file!)} from the data directory. Generate it for a new installation.`,
    });
  }
  const otlpHeaders = settings.get("OTEL_EXPORTER_OTLP_HEADERS");
  if (otlpHeaders === undefined) throw new Error("Missing shared OTLP headers setting");
  settings.set("OTEL_EXPORTER_OTLP_HEADERS", { ...otlpHeaders, fallback: "Unset" });

  const npmDefault = definitions.get("defaultNpmRegistry");
  if (npmDefault === undefined) throw new Error("Missing public npm registry setting");
  settings.set("EXECUTOR_NPM_REGISTRY", {
    type: "HTTP(S) URL",
    fallback: code(String(literal(npmDefault))),
  });

  const origin = bootstrap.match(/else origin = `([^\n]+)`;/u)?.[1];
  if (origin === undefined) throw new Error("Cannot read self-host origin default");
  settings.set("BETTER_AUTH_URL", {
    type: "HTTP(S) origin",
    fallback: `${code(origin.replace("${port}", "<PORT>"))} or HTTPS using \`RAILWAY_PUBLIC_DOMAIN\``,
  });

  const native = read(`${host}/native/main.go`);
  const nativeDefaults = new Map(
    [...native.matchAll(/setting\("([A-Z_]+)", "([^"]+)"\)/gu)].map(([, key, value]) => [
      key!,
      value!,
    ]),
  );
  for (const [key, fallback] of nativeDefaults) {
    const previous = settings.get(key);
    const nativeDefault = code(fallback);
    const fromSource = previous?.fallback;
    settings.set(key, {
      type: previous?.type ?? "path",
      fallback:
        fromSource !== undefined &&
        !["Required", "Unset", nativeDefault, code(JSON.stringify(fallback))].includes(fromSource)
          ? `${nativeDefault} in the Docker host, ${fromSource} in the server`
          : nativeDefault,
    });
  }
  const repositories = native.match(
    /values\["EXECUTOR_REPOSITORIES_DIR"\] = filepath.Join\(directory, "([^"]+)"\)/u,
  )?.[1];
  if (repositories === undefined) throw new Error("Cannot read the Docker repository directory");
  settings.set("EXECUTOR_REPOSITORIES_DIR", {
    type: "path",
    fallback: `The data directory's ${code(repositories)} subdirectory`,
  });

  const workerdEnvironment = native.match(
    /for _, name := range \[\]string\{("[A-Z_]+"(?:, "[A-Z_]+")*)\} \{/u,
  )?.[1];
  if (workerdEnvironment === undefined)
    throw new Error("Cannot read workerd environment passthrough");
  for (const [, key] of workerdEnvironment.matchAll(/"([A-Z_]+)"/gu)) add(key!, "path", "Unset");

  for (const [, key, value] of bootstrap.matchAll(
    /(EXECUTOR_HOST_(?:OS|ARCH)): process\.(platform|arch),/gu,
  )) {
    const previous = settings.get(key!);
    if (!previous) throw new Error(`Missing runtime setting ${key}`);
    settings.set(key!, {
      ...previous,
      fallback: value === "platform" ? "Host operating system" : "Host architecture",
    });
  }
  for (const [, key] of native.matchAll(/os\.Getenv\("([A-Z_]+)"\)/gu)) {
    if (key === "PATH") continue;
    add(key!, "string", "Unset");
  }

  const stall = read(`${host}/native/stall.go`);
  const nativeSettings = [
    [stall, /values\["([A-Z_]+)"\].*\n\s*number, err := strconv.Atoi\(value\)/gu],
    [native, /values\["([A-Z_]+)"\].*\n\s*number, err := strconv.Atoi\(value\)/gu],
  ] as const;
  const worker = read("packages/sdk/src/implementation/app-worker-residency.ts");
  for (const [source, pattern] of nativeSettings)
    for (const [, key] of source.matchAll(pattern)) {
      const defaultPattern =
        key === "EXECUTOR_HOST_STALL_SECONDS"
          ? /const defaultStallSeconds = (\d+)/u
          : key === "EXECUTOR_APP_WORKERS"
            ? /(?:const|let) defaultAppWorkerLimit = (\d+)/u
            : /(?:const|let) defaultAppWorkerIdleSeconds = (\d+)/u;
      const fallback = (key === "EXECUTOR_HOST_STALL_SECONDS" ? stall : worker).match(
        defaultPattern,
      )?.[1];
      if (fallback === undefined) throw new Error(`Cannot read native default for ${key}`);
      add(key!, "integer", code(fallback));
    }
  for (const [, key, fallback] of stall.matchAll(
    /switch values\["([A-Z_]+)"\] \{\s*case "", "(false|true)":/gu,
  ))
    add(key!, "boolean", code(fallback!));

  for (const [key, imageDefault] of Object.entries(imageDefaults)) {
    const setting = settings.get(key);
    if (!setting) throw new Error(`Missing configuration reader for Docker setting ${key}`);
    settings.set(key, { ...setting, imageDefault });
  }
  return [...settings]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, setting]) => ({
      key,
      ...setting,
    }));
}

export function selfHostPage(version: string, settings: readonly Setting[]): Page {
  const names = new Set(settings.map(({ key }) => key));
  const missing = [...names].filter((key) => !meanings[key]?.trim());
  const unused = Object.keys(meanings).filter((key) => !names.has(key));
  if (missing.length || unused.length)
    throw new Error(
      `Update self-host-meanings.ts (missing: ${missing.join(", ") || "none"}; unused: ${unused.join(", ") || "none"})`,
    );

  return {
    route: "/reference/self-host-env",
    title: "Self-host environment variables",
    description: `Environment settings, types and defaults for self-hosted Executor ${version}.`,
    body: [
      `This reference covers self-host configuration in Executor ${code(version)}. The Docker column shows values set in the published image. A dash means the image leaves the setting to the host or server. Rows marked read-only are populated by the host. See [Run Executor yourself](/run/self-host) for installation and configuration examples.`,
      "Restore the original authentication and encryption keys with an existing database. If either key is missing or invalid, the Docker host stops at startup.",
      table(
        ["Variable", "Type", "Docker image", "Source fallback", "Purpose"],
        settings.map(({ key, type, fallback, imageDefault }) => {
          const details = settingDetails[key];
          return [
            code(key),
            details?.type ?? type,
            imageDefault ?? "—",
            details?.fallback ?? fallback,
            meanings[key]!,
          ];
        }),
      ),
    ].join("\n\n"),
  };
}
