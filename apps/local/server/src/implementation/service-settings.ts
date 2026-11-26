/**
 * `executor service …`: start, stop and inspect the background server, and change the settings it
 * starts with. Changing a setting saves it, then stops the running server, so whichever client
 * starts it next, even at once, starts it with the new one.
 * Adapted from OpenCode (MIT, Copyright (c) 2025 opencode).
 */
import { Console, Effect, Option } from "effect";
import {
  ServiceSettingInvalid,
  type ServiceSettingKey,
  type ServiceSettings,
} from "../contracts/service.ts";
import { withKeyFileNotice } from "./bootstrap.ts";
import { ensure, registered, stop } from "./service-client.ts";
import { readSettings, serviceDirectory, writeSettings } from "./service-files.ts";

const invalid = (message: string) =>
  new ServiceSettingInvalid({ message: `${message} Nothing was changed.` });

export const serviceStart = Effect.gen(function* () {
  const directory = yield* serviceDirectory;
  const service = yield* withKeyFileNotice(directory, ensure(directory, { version: "ignore" }));
  yield* Console.log(service.url);
});

export const serviceStop = Effect.gen(function* () {
  yield* stop(yield* serviceDirectory);
});

export const serviceRestart = Effect.gen(function* () {
  const directory = yield* serviceDirectory;
  yield* stop(directory);
  const service = yield* ensure(directory, { version: "replace" });
  yield* Console.log(service.url);
});

const statusPrefix = {
  ready: "",
  starting: "starting ",
  stopping: "stopping ",
  unresponsive: "not responding ",
};

export const serviceStatus = Effect.gen(function* () {
  const service = yield* registered(yield* serviceDirectory);
  yield* Console.log(
    Option.match(service, {
      onNone: () => "stopped",
      onSome: ({ url, version, pid, status }) =>
        `${statusPrefix[status]}${url} (version ${version}, process ${pid})`,
    }),
  );
});

export const serviceGet = (input: {
  readonly key: Option.Option<ServiceSettingKey>;
  readonly name: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const settings = yield* readSettings(yield* serviceDirectory);
    if (Option.isNone(input.key)) return yield* Console.log(JSON.stringify(settings, null, 2));
    const key = input.key.value;
    if (key !== "env" && Option.isSome(input.name))
      return yield* invalid(`Usage: executor service get ${key}.`);
    const value =
      key === "port"
        ? settings.port?.toString()
        : key === "disabled"
          ? String(settings.disabled ?? false)
          : Option.isSome(input.name)
            ? settings.env?.[input.name.value]
            : JSON.stringify(settings.env ?? {}, null, 2);
    if (value !== undefined) yield* Console.log(value);
  });

const changed = (
  settings: ServiceSettings,
  key: ServiceSettingKey,
  value: string,
  envValue: Option.Option<string>,
): Effect.Effect<ServiceSettings, ServiceSettingInvalid> => {
  if (key !== "env" && Option.isSome(envValue))
    return Effect.fail(invalid(`Usage: executor service set ${key} <value>.`));
  switch (key) {
    case "port": {
      const port = Number(value);
      return /^\d{1,5}$/u.test(value) && port >= 1 && port <= 65_535
        ? Effect.succeed({ ...settings, port })
        : Effect.fail(invalid(`The port must be a whole number from 1 to 65535, not ${value}.`));
    }
    case "disabled":
      return value === "true" || value === "false"
        ? Effect.succeed({ ...settings, disabled: value === "true" })
        : Effect.fail(invalid(`disabled must be true or false, not ${value}.`));
    case "env":
      if (Option.isNone(envValue))
        return Effect.fail(invalid("Usage: executor service set env <name> <value>."));
      return value === "" || value.includes("=")
        ? Effect.fail(invalid(`${value} is not an environment variable name.`))
        : Effect.succeed({ ...settings, env: { ...settings.env, [value]: envValue.value } });
  }
};

export const serviceSet = (
  platform: string,
  input: {
    readonly key: ServiceSettingKey;
    readonly value: string;
    readonly envValue: Option.Option<string>;
  },
) =>
  Effect.gen(function* () {
    const directory = yield* serviceDirectory;
    const next = yield* changed(
      yield* readSettings(directory),
      input.key,
      input.value,
      input.envValue,
    );
    yield* writeSettings(platform, directory, next);
    if (input.key !== "disabled" || next.disabled === true) yield* stop(directory);
  });

export const serviceUnset = (
  platform: string,
  input: { readonly key: ServiceSettingKey; readonly name: Option.Option<string> },
) =>
  Effect.gen(function* () {
    if (input.key !== "env" && Option.isSome(input.name))
      return yield* invalid(`Usage: executor service unset ${input.key}.`);
    const directory = yield* serviceDirectory;
    const settings = yield* readSettings(directory);
    switch (input.key) {
      case "disabled": {
        const { disabled: _disabled, ...others } = settings;
        return yield* writeSettings(platform, directory, others);
      }
      case "port": {
        const { port: _port, ...others } = settings;
        yield* writeSettings(platform, directory, others);
        return yield* stop(directory);
      }
      case "env": {
        if (Option.isNone(input.name))
          return yield* invalid("Usage: executor service unset env <name>.");
        const { [input.name.value]: _removed, ...env } = settings.env ?? {};
        const { env: _env, ...others } = settings;
        yield* writeSettings(
          platform,
          directory,
          Object.keys(env).length === 0 ? others : { ...others, env },
        );
        return yield* stop(directory);
      }
    }
  });
