import { Schema, Tuple } from "effect";

export const ViewRect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export const ViewLandmark = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  role: Schema.String,
  rect: ViewRect,
});
export const ObservedView = Schema.Struct({
  route: Schema.String,
  viewport: Schema.Struct({
    width: Schema.Number,
    height: Schema.Number,
    scrollX: Schema.Number,
    scrollY: Schema.Number,
  }),
  headings: Schema.Array(Schema.String),
  statuses: Schema.Array(Schema.String),
  alerts: Schema.Array(Schema.String),
  navigation: Schema.Array(Schema.String),
  controls: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      name: Schema.String,
      disabled: Schema.Boolean,
      filled: Schema.Boolean,
      edited: Schema.Boolean,
    }),
  ),
  landmarks: Schema.Array(ViewLandmark),
});
export const LayoutShift = Schema.Struct({
  value: Schema.Number,
  hadRecentInput: Schema.Boolean,
  sources: Schema.Array(
    Schema.Struct({ label: Schema.String, previous: ViewRect, current: ViewRect }),
  ),
});
export const UIObservation = Schema.Struct({
  kind: Schema.Literals(["atom", "commit", "input", "audit", "view", "layout-shift"]),
  at: Schema.Number,
  label: Schema.String,
  view: Schema.optional(ObservedView),
  shift: Schema.optional(LayoutShift),
});
export const UIObservations = Schema.Array(UIObservation);
export const UIFrameImage = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(["captured", "in-transition"]),
    screenshot: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literals(["superseded", "capture-failed"]),
    screenshot: Schema.Null,
  }),
]);
export const UIFrameCapture = UIFrameImage.mapMembers(
  Tuple.map(Schema.fieldsAssign({ at: Schema.Number, completedAt: Schema.Number })),
);
export const UICaptures = Schema.Struct({
  requestHoldMs: Schema.Number,
  holds: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      heldMs: Schema.Number,
      status: Schema.Literals(["released", "cancelled", "failed"]),
    }),
  ),
  frames: Schema.Array(UIFrameCapture),
});
export const UIStateReport = Schema.Struct({
  version: Schema.Literal(2),
  signals: UIObservations,
  capture: UICaptures,
  states: Schema.Array(
    Schema.Struct({
      at: Schema.Number,
      durationMs: Schema.Number,
      screenshot: Schema.NullOr(Schema.String),
      captureStatus: Schema.Literals(["captured", "in-transition", "superseded", "capture-failed"]),
      view: ObservedView,
      triggers: Schema.String,
      atoms: Schema.Array(Schema.String),
      commits: Schema.Number,
      shifts: Schema.Array(LayoutShift),
    }),
  ),
});
