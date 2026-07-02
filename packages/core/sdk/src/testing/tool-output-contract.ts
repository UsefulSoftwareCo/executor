import * as ts from "typescript";

export type OutputTypeScriptContract = {
  readonly outputTypeScript?: string;
  readonly typeScriptDefinitions?: Record<string, string>;
};

export type TypeCheckOutputTypeScriptOptions = {
  readonly consumerSource?: string;
  readonly fileName?: string;
  readonly typeName?: string;
  readonly valueName?: string;
};

export const typeCheckOutputTypeScript = (
  contract: OutputTypeScriptContract | null | undefined,
  runtimeOutput: unknown,
  options: TypeCheckOutputTypeScriptOptions = {},
): readonly string[] => {
  if (!contract?.outputTypeScript) {
    return ["missing outputTypeScript"];
  }

  const fileName = options.fileName ?? "tool-output-contract.ts";
  const typeName = options.typeName ?? "ToolOutput";
  const valueName = options.valueName ?? "invokedOutput";
  const source = [
    ...Object.entries(contract.typeScriptDefinitions ?? {}).map(
      ([name, definition]) => `type ${name} = ${definition};`,
    ),
    `type ${typeName} = ${contract.outputTypeScript};`,
    `const ${valueName}: ${typeName} = ${JSON.stringify(runtimeOutput)};`,
    options.consumerSource ?? `${valueName};`,
  ].join("\n");

  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);

  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (candidate === fileName) {
      return ts.createSourceFile(candidate, source, languageVersion, true);
    }
    return originalGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.readFile = (candidate) => (candidate === fileName ? source : originalReadFile(candidate));
  host.fileExists = (candidate) => candidate === fileName || originalFileExists(candidate);

  const program = ts.createProgram([fileName], compilerOptions, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (!diagnostic.file || diagnostic.start === undefined) {
      return message;
    }
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`;
  });
};
