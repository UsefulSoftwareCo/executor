declare module "bun:test" {
  export function test(name: string, run: () => Promise<void>): void;
}
