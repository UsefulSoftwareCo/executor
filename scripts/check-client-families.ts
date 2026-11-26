import { readFileSync } from "node:fs";

const files = [
  "apps/hosted/cloud/src/implementation/auth-observability.ts",
  "apps/hosted/cloud/src/implementation/client-family.ts",
];

const families = (file: string) => {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const list = /const clientFamilies = \[([\s\S]*?)\] as const;/u.exec(source)?.[1];
  if (list === undefined) throw new Error(`${file} declares no clientFamilies list.`);
  return list
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("["))
    .join("\n");
};

const [registrations, mcpClients] = files.map(families);
if (registrations !== mcpClients) {
  console.error(
    `The client families differ between ${files[0]} and ${files[1]}. Both name an MCP client's family in analytics; make the two clientFamilies lists equal.`,
  );
  process.exit(1);
}
console.log(`Client families match in ${files.join(" and ")}.`);
