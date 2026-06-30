import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useContext,
  Fragment,
  createContext,
} from "react";
import { transform } from "sucrase";

import {
  mutationOptions,
  queryOptions,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "./hooks";
import * as Components from "./components";
import * as QueryHooks from "./hooks";

export type EvaluatedComponent =
  | { component: React.ComponentType; config: Record<string, unknown> }
  | { error: string };

const createGeneratedCodeRequire =
  () =>
  (specifier: string): unknown => {
    if (specifier === "react") return React;
    if (specifier === "@tanstack/react-query") return QueryHooks;
    if (specifier === "recharts" || specifier === "lucide-react" || specifier === "./components") {
      return Components;
    }
    throw new Error(
      `Generated UI cannot import "${specifier}". Everything needed is already in scope; remove the import.`,
    );
  };

const blockedNetworkPrimitive = (name: string) =>
  function blockedNetworkPrimitive() {
    throw new Error(`${name} is disabled in generated UI. Use tools.* via useQuery/useMutation.`);
  };

/** Compile JSX source to plain JS using Sucrase. */
export function compileJsx(code: string): string {
  const result = transform(code, {
    transforms: ["jsx", "typescript", "imports"],
    jsxRuntime: "classic",
    production: true,
  });
  return result.code;
}

/**
 * Evaluate compiled JS in a scoped context providing React, hooks,
 * components, tools proxy, useQuery/useMutation, and Lucide icons.
 */
export function evaluateComponent(
  compiled: string,
  tools: Record<string, unknown>,
  run: (code: string) => Promise<unknown>,
): EvaluatedComponent {
  const module = { exports: {} as Record<string, unknown> | React.ComponentType };
  const exports = module.exports;

  const scope: Record<string, unknown> = {
    // React core
    React,
    useState,
    useEffect,
    useRef,
    useCallback,
    useMemo,
    useContext,
    Fragment,
    createContext,

    // Common module globals for resilient generated code evaluation.
    module,
    exports,
    require: createGeneratedCodeRequire(),

    // Defense in depth for direct network attempts. The inner iframe CSP is
    // the browser boundary; these shadows produce clearer runtime errors.
    fetch: blockedNetworkPrimitive("fetch"),
    XMLHttpRequest: blockedNetworkPrimitive("XMLHttpRequest"),
    WebSocket: blockedNetworkPrimitive("WebSocket"),
    EventSource: blockedNetworkPrimitive("EventSource"),
    Worker: blockedNetworkPrimitive("Worker"),
    SharedWorker: blockedNetworkPrimitive("SharedWorker"),

    // Data fetching
    useQuery,
    useMutation,
    useQueryClient,
    queryOptions,
    mutationOptions,
    skipToken,

    // Tools proxy + escape hatch
    tools,
    run,

    // All UI components, icons, chart primitives
    ...Components,
  };

  const scopeKeys = Object.keys(scope);
  const scopeValues = scopeKeys.map((k) => scope[k]);

  // Execute the compiled code and look for a component + optional config.
  // We check well-known names and common module export shapes so generated
  // code stays resilient to `export default function App()` and friends.
  const wrappedCode = `
    "use strict";
    ${compiled}
    var __moduleExports = module && module.exports;
    var __defaultExport =
      __moduleExports && typeof __moduleExports === "object" && "default" in __moduleExports
        ? __moduleExports.default
        : exports && exports.default;
    var __comp = null;
    if (typeof App === "function") __comp = App;
    else if (typeof Component === "function") __comp = Component;
    else if (typeof Main === "function") __comp = Main;
    else if (typeof __defaultExport === "function") __comp = __defaultExport;
    else if (typeof __moduleExports === "function") __comp = __moduleExports;
    else if (exports && typeof exports.App === "function") __comp = exports.App;
    else if (exports && typeof exports.Component === "function") __comp = exports.Component;
    else if (exports && typeof exports.Main === "function") __comp = exports.Main;
    var __cfg = typeof config === "object" && config !== null ? config : {};
    return { component: __comp, config: __cfg };
  `;

  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function(...scopeKeys, wrappedCode);
    const result = factory(...scopeValues) as {
      component: React.ComponentType | null;
      config: Record<string, unknown>;
    };
    if (!result.component) {
      return { error: "No component found. Export a function named App." };
    }
    return { component: result.component, config: result.config };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[executor-shell] Failed to evaluate component:", err);
    return { error: `Evaluation error: ${msg}` };
  }
}
