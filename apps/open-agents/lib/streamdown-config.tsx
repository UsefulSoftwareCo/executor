type StreamdownHighlightToken = {
  bgColor?: string;
  color?: string;
  content?: string;
  htmlStyle?: Record<string, string | undefined>;
  offset?: number;
};

type StreamdownHighlightLine = StreamdownHighlightToken[];

export type StreamdownHighlightResult = {
  bg?: string;
  fg?: string;
  rootStyle?: string;
  tokens: StreamdownHighlightLine[];
  [key: string]: unknown;
};

type CssDeclarations = Record<string, string>;

function parseCssValue(value: string): {
  baseValue: string | undefined;
  declarations: CssDeclarations;
} {
  const declarations: CssDeclarations = {};
  let baseValue: string | undefined;

  for (const rawSegment of value.split(";")) {
    const segment = rawSegment.trim();
    if (!segment) {
      continue;
    }

    const separatorIndex = segment.indexOf(":");
    if (separatorIndex === -1) {
      if (!baseValue) {
        baseValue = segment;
      }
      continue;
    }

    const property = segment.slice(0, separatorIndex).trim();
    const propertyValue = segment.slice(separatorIndex + 1).trim();
    if (!property || !propertyValue) {
      continue;
    }

    declarations[property] = propertyValue;
  }

  return { baseValue, declarations };
}

function mergeDeclarations(
  target: Record<string, string | undefined>,
  source: CssDeclarations,
): void {
  for (const [property, propertyValue] of Object.entries(source)) {
    target[property] = propertyValue;
  }
}

function consumeThemeValue(
  value: string | undefined,
  declarationTarget: CssDeclarations,
): string | undefined {
  if (!value) {
    return value;
  }

  const { baseValue, declarations } = parseCssValue(value);
  mergeDeclarations(declarationTarget, declarations);

  return baseValue;
}

function normalizeTokenStyleProperty(
  htmlStyle: NonNullable<StreamdownHighlightToken["htmlStyle"]>,
  property: "color" | "background-color",
): string | undefined {
  const value = htmlStyle[property];
  if (typeof value !== "string") {
    return undefined;
  }

  const { baseValue, declarations } = parseCssValue(value);
  mergeDeclarations(htmlStyle, declarations);
  delete htmlStyle[property];

  return baseValue;
}

function normalizeHighlightToken(
  token: StreamdownHighlightToken,
): StreamdownHighlightToken {
  const htmlStyle = token.htmlStyle ? { ...token.htmlStyle } : undefined;
  if (!htmlStyle) {
    return token;
  }

  const color = normalizeTokenStyleProperty(htmlStyle, "color") ?? token.color;
  const bgColor =
    normalizeTokenStyleProperty(htmlStyle, "background-color") ?? token.bgColor;

  return {
    ...token,
    bgColor,
    color,
    htmlStyle,
  };
}

function mergeRootStyle(
  rootStyle: string | undefined,
  declarations: CssDeclarations,
): string | undefined {
  const declarationEntries = Object.entries(declarations);
  if (declarationEntries.length === 0) {
    return rootStyle;
  }

  const rootStyleParts: string[] = [];
  if (typeof rootStyle === "string" && rootStyle.length > 0) {
    rootStyleParts.push(rootStyle);
  }

  for (const [property, propertyValue] of declarationEntries) {
    rootStyleParts.push(`${property}:${propertyValue}`);
  }

  return rootStyleParts.join(";");
}

export function normalizeStreamdownHighlightResult<
  Result extends StreamdownHighlightResult,
>(result: Result): Result {
  const rootDeclarations: CssDeclarations = {};
  const fg = consumeThemeValue(result.fg, rootDeclarations);
  const bg = consumeThemeValue(result.bg, rootDeclarations);
  const tokens = result.tokens.map((line) => line.map(normalizeHighlightToken));
  const rootStyle = mergeRootStyle(result.rootStyle, rootDeclarations);

  return {
    ...result,
    bg,
    fg,
    rootStyle,
    tokens,
  };
}
