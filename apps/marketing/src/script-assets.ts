export const assetsInlineLimit = (file: string): boolean | undefined =>
  file.endsWith(".js") ? false : undefined;
