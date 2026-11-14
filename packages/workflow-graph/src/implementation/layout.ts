import type { WorkflowGraph, WorkflowNode } from "../contracts/graph.ts";

/**
 * Places a workflow top to bottom. The graph is a tree, so each block is measured, then drawn
 * centred on its own axis: a decision's options sit side by side and rejoin below, and loops,
 * parallel groups and try blocks are boxes around their own blocks. No graph-layout engine is
 * needed, and the same graph always lands in the same place.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type LayoutCard =
  | {
      readonly kind: "start";
      readonly id: "start";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "node";
      readonly id: string;
      readonly node: WorkflowNode;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };

export interface LayoutBox {
  readonly id: string;
  readonly node: WorkflowNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Which option of which decision an edge belongs to. */
export interface ArmRef {
  readonly decision: string;
  readonly index: number;
}

export interface LayoutEdge {
  readonly from: string;
  /** `null` where lines meet in mid-air; only edges that enter something get an arrowhead. */
  readonly to: string | null;
  readonly arm: ArmRef | undefined;
  readonly failure: boolean;
  readonly points: ReadonlyArray<Point>;
}

export interface LayoutLabel {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly arm: ArmRef | undefined;
  readonly failure: boolean;
}

export interface WorkflowLayout {
  readonly width: number;
  readonly height: number;
  readonly cards: ReadonlyArray<LayoutCard>;
  readonly boxes: ReadonlyArray<LayoutBox>;
  readonly edges: ReadonlyArray<LayoutEdge>;
  readonly labels: ReadonlyArray<LayoutLabel>;
}

const CARD_WIDTH = 252;
const STEP_HEIGHT = 58;
const DECISION_HEIGHT = 50;
const END_WIDTH = 74;
const END_HEIGHT = 26;
const GAP = 34;
const PAD = 18;
const HEAD = 34;
const COLUMN_GAP = 30;
const ARM_DROP = 30;
const EMPTY_ARM = 96;
const FAILURE_DROP = 58;
/** Room between a box's header and its first card for the line that enters it. */
const ENTRY = 26;
/** Room above a `finally` section for its label. */
const CLEANUP_LABEL = 26;
const MARGIN = 40;

interface Size {
  readonly width: number;
  readonly height: number;
}

/** An open end of a line, waiting for whatever comes next to connect to it. */
interface Open extends Point {
  readonly from: string;
  readonly arm: ArmRef | undefined;
}

export function layoutWorkflow(graph: WorkflowGraph): WorkflowLayout {
  const out = {
    cards: [] as LayoutCard[],
    boxes: [] as LayoutBox[],
    edges: [] as LayoutEdge[],
    labels: [] as LayoutLabel[],
  };
  const body = blockSize(graph.nodes);
  const width = Math.max(CARD_WIDTH, body.width) + MARGIN * 2;
  const axis = width / 2;
  out.cards.push({
    kind: "start",
    id: "start",
    x: axis - CARD_WIDTH / 2,
    y: 0,
    width: CARD_WIDTH,
    height: STEP_HEIGHT,
  });
  drawBlock(out, graph.nodes, axis, STEP_HEIGHT + GAP, [
    { x: axis, y: STEP_HEIGHT, from: "start", arm: undefined },
  ]);
  return { width, height: STEP_HEIGHT + GAP + body.height, ...out };
}

function nodeSize(node: WorkflowNode): Size {
  switch (node.type) {
    case "step":
      return { width: CARD_WIDTH, height: STEP_HEIGHT };
    case "end":
      return { width: END_WIDTH, height: END_HEIGHT };
    case "branch": {
      const arms = node.arms.map(armSize);
      const total = arms.reduce((sum, arm) => sum + arm.width, 0) + COLUMN_GAP * (arms.length - 1);
      return {
        width: Math.max(CARD_WIDTH, total),
        height: DECISION_HEIGHT + ARM_DROP + GAP + Math.max(0, ...arms.map((arm) => arm.height)),
      };
    }
    case "loop": {
      const inner = blockSize(node.body);
      return { width: inner.width + PAD * 2, height: HEAD + ENTRY + inner.height + GAP };
    }
    case "parallel": {
      const columns = node.branches.map(blockSize);
      return {
        width:
          columns.reduce((sum, column) => sum + column.width, 0) +
          COLUMN_GAP * (columns.length - 1) +
          PAD * 2,
        height: HEAD + ENTRY + Math.max(0, ...columns.map((column) => column.height)) + GAP,
      };
    }
    case "try": {
      const parts = tryParts(node);
      return {
        width: Math.max(parts.mainWidth, parts.cleanup.width) + PAD * 2,
        height:
          HEAD +
          ENTRY +
          parts.mainHeight +
          GAP +
          (node.cleanup.length > 0 ? CLEANUP_LABEL + parts.cleanup.height + GAP : 0),
      };
    }
  }
}

/** The try box's body and failure columns side by side, and its `finally` section below them. */
function tryParts(node: Extract<WorkflowNode, { type: "try" }>) {
  const body = armSize(node);
  const failure = node.failure.length > 0 ? blockSize(node.failure) : undefined;
  return {
    body,
    failure,
    cleanup: blockSize(node.cleanup),
    mainWidth: body.width + (failure ? failure.width + COLUMN_GAP + 20 : 0),
    mainHeight: Math.max(body.height, failure ? failure.height + FAILURE_DROP : 0),
  };
}

function armSize(arm: { readonly body: ReadonlyArray<WorkflowNode> }): Size {
  return arm.body.length > 0 ? blockSize(arm.body) : { width: EMPTY_ARM, height: 0 };
}

function blockSize(nodes: ReadonlyArray<WorkflowNode>): Size {
  const sizes = nodes.map(nodeSize);
  return {
    width: Math.max(0, ...sizes.map((size) => size.width)),
    height: sizes.reduce((sum, size) => sum + size.height, 0) + GAP * Math.max(0, nodes.length - 1),
  };
}

type Out = { cards: LayoutCard[]; boxes: LayoutBox[]; edges: LayoutEdge[]; labels: LayoutLabel[] };

/** Draws a block from `top` down and returns its open ends. */
function drawBlock(
  out: Out,
  nodes: ReadonlyArray<WorkflowNode>,
  axis: number,
  top: number,
  incoming: ReadonlyArray<Open>,
): Open[] {
  let open: ReadonlyArray<Open> = incoming;
  let y = top;
  for (const node of nodes) {
    for (const end of open)
      out.edges.push({
        from: end.from,
        to: node.id,
        arm: end.arm,
        failure: false,
        points: join(end, { x: axis, y }),
      });
    const size = nodeSize(node);
    open = drawNode(out, node, size, axis, y);
    y += size.height + GAP;
  }
  return [...open];
}

/** Down, across just above the target, then down into it. */
function join(from: Point, to: Point): Point[] {
  if (Math.abs(from.x - to.x) < 0.5) return [from, to];
  const middle = to.y - GAP / 2 - 2;
  return [from, { x: from.x, y: middle }, { x: to.x, y: middle }, to];
}

/** Down out of a decision, across just below it, then down to the option. */
function split(from: Point, to: Point): Point[] {
  if (Math.abs(from.x - to.x) < 0.5) return [from, to];
  const middle = from.y + ARM_DROP / 2 + 4;
  return [from, { x: from.x, y: middle }, { x: to.x, y: middle }, to];
}

/** Joins open ends to a box's bottom; returns how many paths leave the box there. */
function rejoin(out: Out, open: ReadonlyArray<Open>, bottom: Point): number {
  for (const end of open)
    out.edges.push({
      from: end.from,
      to: null,
      arm: end.arm,
      failure: false,
      points: join(end, bottom),
    });
  return open.length;
}

function drawNode(out: Out, node: WorkflowNode, size: Size, axis: number, y: number): Open[] {
  const box = { x: axis - size.width / 2, y, width: size.width, height: size.height };
  switch (node.type) {
    case "step":
      out.cards.push({ kind: "node", id: node.id, node, ...box });
      return [{ x: axis, y: y + STEP_HEIGHT, from: node.id, arm: undefined }];
    case "end":
      out.cards.push({ kind: "node", id: node.id, node, ...box });
      return [];
    case "branch": {
      out.cards.push({
        kind: "node",
        id: node.id,
        node,
        x: axis - CARD_WIDTH / 2,
        y,
        width: CARD_WIDTH,
        height: DECISION_HEIGHT,
      });
      const arms = node.arms.map(armSize);
      const total = arms.reduce((sum, arm) => sum + arm.width, 0) + COLUMN_GAP * (arms.length - 1);
      const top = y + DECISION_HEIGHT + ARM_DROP + GAP;
      const start = { x: axis, y: y + DECISION_HEIGHT };
      let x = axis - total / 2;
      const open: Open[] = [];
      node.arms.forEach((option, index) => {
        const width = arms[index]?.width ?? EMPTY_ARM;
        const center = x + width / 2;
        const arm = { decision: node.id, index };
        out.labels.push({ x: center, y: top - 27, text: option.label, arm, failure: false });
        const first = option.body[0];
        out.edges.push({
          from: node.id,
          to: first?.id ?? null,
          arm,
          failure: false,
          points: split(start, { x: center, y: top }),
        });
        if (first) open.push(...drawBlock(out, option.body, center, top, []));
        else open.push({ x: center, y: top, from: node.id, arm });
        x += width + COLUMN_GAP;
      });
      return open;
    }
    case "loop": {
      out.boxes.push({ id: node.id, node, ...box });
      const entry = { x: axis, y: y + HEAD, from: node.id, arm: undefined };
      rejoin(out, drawBlock(out, node.body, axis, y + HEAD + ENTRY, [entry]), {
        x: axis,
        y: y + size.height,
      });
      return [{ x: axis, y: y + size.height, from: node.id, arm: undefined }];
    }
    case "parallel": {
      out.boxes.push({ id: node.id, node, ...box });
      const bottom = { x: axis, y: y + size.height };
      const entry = { x: axis, y: y + HEAD, from: node.id, arm: undefined };
      let x = box.x + PAD;
      let leaving = 0;
      for (const branch of node.branches) {
        const width = blockSize(branch).width;
        leaving += rejoin(
          out,
          drawBlock(out, branch, x + width / 2, y + HEAD + ENTRY, [entry]),
          bottom,
        );
        x += width + COLUMN_GAP;
      }
      return leaving > 0 ? [{ x: axis, y: y + size.height, from: node.id, arm: undefined }] : [];
    }
    case "try": {
      out.boxes.push({ id: node.id, node, ...box });
      const parts = tryParts(node);
      const bottom = { x: axis, y: y + size.height };
      const top = y + HEAD + ENTRY;
      const mainLeft = axis - parts.mainWidth / 2;
      const bodyAxis = mainLeft + parts.body.width / 2;
      const entry = { x: bodyAxis, y: y + HEAD, from: node.id, arm: undefined };
      // A body without steps still runs, and can still fail into the catch.
      const fromBody: Open[] =
        node.body.length === 0
          ? [{ x: bodyAxis, y: top, from: node.id, arm: undefined }]
          : drawBlock(out, node.body, bodyAxis, top, [entry]);
      const fromFailure: Open[] = [];
      const failureFirst = node.failure[0];
      if (failureFirst && parts.failure) {
        const failureAxis = mainLeft + parts.mainWidth - parts.failure.width / 2;
        const first = node.body[0];
        const from = {
          x: first ? bodyAxis + CARD_WIDTH / 2 : bodyAxis,
          y: top + STEP_HEIGHT / 2,
        };
        const failureTop = top + FAILURE_DROP;
        out.edges.push({
          from: first?.id ?? node.id,
          to: failureFirst.id,
          arm: undefined,
          failure: true,
          points: [from, { x: failureAxis, y: from.y }, { x: failureAxis, y: failureTop }],
        });
        out.labels.push({
          x: (from.x + failureAxis) / 2 + 10,
          y: from.y - 19,
          text: "If it fails",
          arm: undefined,
          failure: true,
        });
        fromFailure.push(...drawBlock(out, node.failure, failureAxis, failureTop, []));
      }
      // An empty catch swallows the failure and carries on from below the body.
      const swallowed: Open[] =
        node.catches && node.failure.length === 0
          ? [{ x: axis, y: top + parts.mainHeight, from: node.id, arm: undefined }]
          : [];
      const reaching = fromBody.length + fromFailure.length + swallowed.length;
      if (node.cleanup.length === 0) {
        rejoin(out, [...fromBody, ...fromFailure, ...swallowed], bottom);
        return reaching > 0 ? [{ x: axis, y: y + size.height, from: node.id, arm: undefined }] : [];
      }
      // `finally` runs whichever way the rest leaves; the run goes on after it only when some
      // path through the body or the catch reached its end.
      const cleanupTop = top + parts.mainHeight + GAP + CLEANUP_LABEL;
      out.labels.push({
        x: axis,
        y: cleanupTop - CLEANUP_LABEL,
        text: "Always runs",
        arm: undefined,
        failure: false,
      });
      // When every path ended inside, the cleanup still runs before that end takes effect; it is
      // entered from its label, and the run doesn't go on past it.
      const entering: Open[] =
        reaching > 0
          ? [...fromBody, ...fromFailure, ...swallowed]
          : [{ x: axis, y: cleanupTop - 8, from: node.id, arm: undefined }];
      const afterCleanup = drawBlock(out, node.cleanup, axis, cleanupTop, entering);
      if (reaching === 0) return [];
      const leaving = rejoin(out, afterCleanup, bottom);
      return leaving > 0 ? [{ x: axis, y: y + size.height, from: node.id, arm: undefined }] : [];
    }
  }
}

/** An orthogonal polyline as an SVG path, its corners rounded by up to `radius`. */
export function roundedPath(points: ReadonlyArray<Point>, radius: number): string {
  const [start, ...rest] = points;
  if (!start) return "";
  let path = `M${start.x} ${start.y}`;
  rest.forEach((corner, index) => {
    const previous = points[index] ?? start;
    const next = rest[index + 1];
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = next ? Math.hypot(next.x - corner.x, next.y - corner.y) : 0;
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (!next || r <= 0) {
      path += ` L${corner.x} ${corner.y}`;
      return;
    }
    const before = {
      x: corner.x - ((corner.x - previous.x) / inLength) * r,
      y: corner.y - ((corner.y - previous.y) / inLength) * r,
    };
    const after = {
      x: corner.x + ((next.x - corner.x) / outLength) * r,
      y: corner.y + ((next.y - corner.y) / outLength) * r,
    };
    path += ` L${before.x} ${before.y} Q${corner.x} ${corner.y} ${after.x} ${after.y}`;
  });
  return path;
}
