/** The one `bun:test` export `coverage-main.ts` uses; the repository installs no Bun types. */
declare module "bun:test" {
  export function test(name: string, run: () => Promise<void>): void;
}
