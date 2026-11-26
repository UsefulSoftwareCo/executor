/** Failures of `desktop` from `apps/client`, which authors check with `instanceof`. */
import { Schema } from "effect";
import type { DesktopBridgeFailure } from "./desktop.ts";

const DesktopPermissionName = Schema.Literals([
  "menuBar",
  "shortcuts",
  "floating",
  "startAtLogin",
  "microphone",
  "camera",
  "systemAudio",
  "clipboardRead",
  "notifications",
]);
const permissionDeniedFields = { permission: DesktopPermissionName };
const shortcutTakenFields = { accelerator: Schema.String };
const invalidInputFields = { message: Schema.String };

/** The page is not in an installed Executor desktop window, or the desktop closed the bridge. */
export class DesktopUnavailable extends Schema.TaggedError<DesktopUnavailable>()(
  "DesktopUnavailable",
  {},
) {}
/** The person did not allow this capability for the app. */
export class DesktopPermissionDenied extends Schema.TaggedError<DesktopPermissionDenied>()(
  "DesktopPermissionDenied",
  permissionDeniedFields,
) {}
/** Another app or program already holds this global shortcut. */
export class ShortcutTaken extends Schema.TaggedError<ShortcutTaken>()(
  "ShortcutTaken",
  shortcutTakenFields,
) {}
/** The call's input is not one the desktop accepts, such as a title that is too long. */
export class DesktopInvalidInput extends Schema.TaggedError<DesktopInvalidInput>()(
  "DesktopInvalidInput",
  invalidInputFields,
) {}
/**
 * The app may hear system audio, but macOS has not allowed Executor to record the screen and
 * system audio. The desktop has already offered to open System Settings; try again afterwards.
 */
export class SystemAudioBlocked extends Schema.TaggedError<SystemAudioBlocked>()(
  "SystemAudioBlocked",
  {},
) {}
/** Any failure a `desktop` call rejects with. */
export type DesktopError =
  | DesktopUnavailable
  | DesktopPermissionDenied
  | ShortcutTaken
  | DesktopInvalidInput
  | SystemAudioBlocked;

/** The plain tagged objects a bridge rejects with, as they cross the desktop's preload. */
export const DesktopBridgeRejection = Schema.Union([
  Schema.TaggedStruct("DesktopUnavailable", {}),
  Schema.TaggedStruct("DesktopPermissionDenied", permissionDeniedFields),
  Schema.TaggedStruct("ShortcutTaken", shortcutTakenFields),
  Schema.TaggedStruct("DesktopInvalidInput", invalidInputFields),
  Schema.TaggedStruct("SystemAudioBlocked", {}),
]);

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Fails to compile when the decoder and the bridge contract's `DesktopBridgeFailure` differ. */
export const desktopBridgeRejectionMatchesContract: Same<
  typeof DesktopBridgeRejection.Type,
  DesktopBridgeFailure
> = true;
