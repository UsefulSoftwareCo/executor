/// <reference types="vite/client" />

// monaco-editor's package exports don't expose the esm subpaths to TypeScript
// (vite resolves them fine); the main entry's types ARE editor.api's.
declare module "monaco-editor/esm/vs/editor/editor.api" {
  export * from "monaco-editor";
}
declare module "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution" {}

// No published types; the player is created imperatively and disposed.
declare module "asciinema-player" {
  export interface Player {
    play(): unknown;
    pause(): unknown;
    seek(seconds: number): Promise<unknown>;
    getCurrentTime(): number | Promise<number>;
    getDuration(): number | Promise<number>;
    dispose(): void;
  }
  export function create(
    src: string,
    element: HTMLElement,
    options?: Record<string, unknown>,
  ): Player;
}
