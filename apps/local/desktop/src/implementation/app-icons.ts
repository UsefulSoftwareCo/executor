import { BrowserWindow, nativeImage, session } from "electron";
import { Effect, Schema } from "effect";

export class IconFailed extends Schema.TaggedError<IconFailed>()("IconFailed", {}) {}

export const iconSizes = [16, 32, 48, 64, 128, 256, 512, 1024] as const;
export type IconSize = (typeof iconSizes)[number];
export type IconImages = { readonly [Size in IconSize]: Buffer };

const RasterizedUrls = Schema.Tuple([
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
]);

const png = (url: string) => {
  const image = nativeImage.createFromDataURL(url);
  return image.isEmpty() ? Effect.fail(new IconFailed()) : Effect.succeed(image.toPNG());
};

const monogramColors = [
  "#5b5bd6",
  "#0d74ce",
  "#12a594",
  "#30a46c",
  "#e5484d",
  "#d6409f",
  "#8e4ec6",
];

const drawScript = (source: { readonly svg: string } | { readonly name: string }) => {
  const sizes = JSON.stringify(iconSizes);
  if ("svg" in source) {
    const url = JSON.stringify(
      `data:image/svg+xml;base64,${Buffer.from(source.svg).toString("base64")}`,
    );
    return `(async () => {
      const image = new Image();
      image.src = ${url};
      await image.decode();
      return ${sizes}.map((size) => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        canvas.getContext("2d").drawImage(image, 0, 0, size, size);
        return canvas.toDataURL("image/png");
      });
    })()`;
  }
  const letter = JSON.stringify(Array.from(source.name.trim())[0]?.toLocaleUpperCase() ?? "A");
  const hash = Array.from(source.name).reduce(
    (total, character) => (total * 31 + (character.codePointAt(0) ?? 0)) >>> 0,
    7,
  );
  const color = JSON.stringify(monogramColors[hash % monogramColors.length]);
  return `(async () => ${sizes}.map((size) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    const inset = size * 0.1;
    context.fillStyle = ${color};
    context.beginPath();
    context.roundRect(inset, inset, size - inset * 2, size - inset * 2, size * 0.18);
    context.fill();
    context.fillStyle = "#ffffff";
    context.font = "600 " + Math.round(size * 0.46) + "px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(${letter}, size / 2, size / 2 + size * 0.03);
    return canvas.toDataURL("image/png");
  }))()`;
};

const drawInHiddenWindow = (script: string) =>
  Effect.acquireUseRelease(
    Effect.sync(
      () =>
        new BrowserWindow({
          show: false,
          width: 64,
          height: 64,
          webPreferences: {
            session: session.fromPartition("executor-desktop-icons"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        }),
    ),
    (window) =>
      Effect.gen(function* () {
        window.webContents.on("will-navigate", (event) => event.preventDefault());
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        yield* Effect.tryPromise({
          try: () =>
            window.loadURL(
              "data:text/html,<!doctype html><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; img-src data:\">",
            ),
          catch: () => new IconFailed(),
        });
        return yield* Effect.tryPromise({
          try: (): Promise<unknown> => window.webContents.executeJavaScript(script),
          catch: () => new IconFailed(),
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(() => new IconFailed()),
        );
      }),
    (window) => Effect.sync(() => window.destroy()),
  );

export const rasterizeIcon = (source: { readonly svg: string } | { readonly name: string }) =>
  Effect.gen(function* () {
    const urls = yield* drawInHiddenWindow(drawScript(source)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RasterizedUrls)),
      Effect.mapError(() => new IconFailed()),
    );
    const [x16, x32, x48, x64, x128, x256, x512, x1024] = urls;
    const images: IconImages = {
      16: yield* png(x16),
      32: yield* png(x32),
      48: yield* png(x48),
      64: yield* png(x64),
      128: yield* png(x128),
      256: yield* png(x256),
      512: yield* png(x512),
      1024: yield* png(x1024),
    };
    return images;
  });

const badgeScript = (text: string) => `(async () => [16, 32].map((size) => {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  context.fillStyle = "#e5484d";
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  const label = ${JSON.stringify(text)};
  context.font = "700 " + Math.round(size * (label.length > 2 ? 0.42 : 0.62)) + "px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, size / 2, size / 2 + size * 0.04);
  return canvas.toDataURL("image/png");
}))()`;

export const badgeImage = (text: string) =>
  Effect.gen(function* () {
    const [x16, x32] = yield* drawInHiddenWindow(badgeScript(text)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.String, Schema.String]))),
      Effect.mapError(() => new IconFailed()),
    );
    const image = nativeImage.createEmpty();
    image.addRepresentation({ scaleFactor: 1, buffer: yield* png(x16) });
    image.addRepresentation({ scaleFactor: 2, buffer: yield* png(x32) });
    return image;
  });

export const appIconImages = (name: string, svg: string | undefined) =>
  (svg === undefined ? rasterizeIcon({ name }) : rasterizeIcon({ svg })).pipe(
    Effect.catch(() =>
      svg === undefined
        ? Effect.fail(new IconFailed())
        : Effect.logWarning("Could not draw an app's icon; using its monogram").pipe(
            Effect.andThen(rasterizeIcon({ name })),
          ),
    ),
  );

const icnsEntries: ReadonlyArray<readonly [string, IconSize]> = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic11", 32],
  ["icp6", 64],
  ["ic12", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic13", 256],
  ["ic09", 512],
  ["ic14", 512],
  ["ic10", 1024],
];

export const icns = (images: IconImages) => {
  const chunks = icnsEntries.map(([type, size]) => {
    const data = images[size];
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
};

const icoSizes: ReadonlyArray<IconSize> = [16, 32, 48, 64, 128, 256];

export const ico = (images: IconImages) => {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(icoSizes.length, 4);
  let offset = 6 + icoSizes.length * 16;
  const entries = icoSizes.map((size) => {
    const data = images[size];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...icoSizes.map((size) => images[size])]);
};

export const trayImage = (images: IconImages) => {
  const image = nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, buffer: images[16] });
  image.addRepresentation({ scaleFactor: 2, buffer: images[32] });
  return image;
};

export const dialogImage = (images: IconImages) => nativeImage.createFromBuffer(images[128]);
