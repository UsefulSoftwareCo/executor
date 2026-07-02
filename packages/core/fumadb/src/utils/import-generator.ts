export function importGenerator() {
  const names = new Set<string>();
  // specifier -> import name
  const map = new Map<string, string[]>();

  return {
    addImport(name: string, specifier: string) {
      if (names.has(name)) return;
      names.add(name);
      const list = map.get(specifier) ?? [];
      list.push(name);
      map.set(specifier, list);
    },
    format(): string {
      const v: string[] = [];
      for (const [specifier, names] of map) {
        if (names.length === 0) continue;

        v.push(`import { ${names.join(", ")} } from "${specifier}"`);
      }

      return v.join("\n");
    },
  };
}
