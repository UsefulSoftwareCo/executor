export const desktopServersInputs: ReadonlyArray<string | RegExp> = [
  "apps/local/desktop/",
  /^apps\/hosted\/server\/src\/.*desktop-sessions[^/]*$/u,
  "packages/mcp-auth/",
  /^apps\/hosted\/web\/.*mcp-authorize[^/]*$/u,
  "e2e/tests/desktop-servers.spec.ts",
  "e2e/desktop-servers.config.ts",
  "e2e/desktop-servers-inputs.ts",
  "e2e/support/desktop.ts",
];

export const desktopServersChanged = (files: ReadonlyArray<string>) =>
  files.some((file) =>
    desktopServersInputs.some((input) =>
      typeof input !== "string"
        ? input.test(file)
        : input.endsWith("/")
          ? file.startsWith(input)
          : file === input,
    ),
  );
