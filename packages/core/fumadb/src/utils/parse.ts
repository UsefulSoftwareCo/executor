const RegexVarchar = /^varchar\((\d+)\)$/;

export function parseVarchar(template: string): number {
  const match = RegexVarchar.exec(template);
  if (!match) throw new Error("Failed to match varchar(n)");
  return Number(match[1]);
}

export function ident(s: string, identation = 2): string {
  const tab = " ".repeat(identation);

  return s
    .split("\n")
    .map((v) => tab + v)
    .join("\n");
}
