"use client";

import { createCodePlugin } from "@streamdown/code";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { normalizeStreamdownHighlightResult } from "@/lib/streamdown-config";
import { vercelDark, vercelLight } from "@/lib/vercel-themes";
import "streamdown/styles.css";

const baseCodePlugin = createCodePlugin({
  themes: [vercelLight, vercelDark],
});

type HighlightOptions = Parameters<typeof baseCodePlugin.highlight>[0];
type HighlightResult = NonNullable<ReturnType<typeof baseCodePlugin.highlight>>;
type HighlightCallback = (result: HighlightResult) => void;

const codePlugin = {
  ...baseCodePlugin,
  highlight(options: HighlightOptions, callback?: HighlightCallback) {
    const normalizedCallback: HighlightCallback | undefined = callback
      ? (result) => {
          callback(normalizeStreamdownHighlightResult(result));
        }
      : undefined;

    const result = baseCodePlugin.highlight(options, normalizedCallback);
    return result ? normalizeStreamdownHighlightResult(result) : null;
  },
};

const streamdownPlugins = {
  code: codePlugin,
};

type StreamdownRendererProps = Omit<ComponentProps<typeof Streamdown>, "plugins">;

export function StreamdownRenderer(props: StreamdownRendererProps) {
  return <Streamdown {...props} plugins={streamdownPlugins} />;
}
