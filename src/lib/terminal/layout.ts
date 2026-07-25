/**
 * Split-layout tree for the terminal view.
 *
 * A tab (a "group" of agents that share a `groupId`) arranges its agents as a
 * binary-ish tree: every leaf hosts exactly one agent's terminal, and every split
 * lays its children out along one axis with per-child size fractions.
 *
 *   dir "row" → children sit SIDE BY SIDE, separated by VERTICAL gutters (⌘D)
 *   dir "col" → children STACK top-to-bottom, separated by HORIZONTAL gutters (⌘⇧D)
 *
 * The tree is the single source of truth for what's on screen and how big each
 * pane is; {@link computeLayout} flattens it into absolute rects (as fractions of
 * the container) so every pane can be an absolutely-positioned sibling — that's
 * what lets all terminals stay mounted (and keep their PTYs) while only the active
 * tab's leaves are shown.
 */

export type Dir = "row" | "col";

export type LayoutNode =
  | { type: "leaf"; agentId: string }
  | { type: "split"; dir: Dir; sizes: number[]; children: LayoutNode[] };

/** Smallest fraction a pane may shrink to along a split's axis (keeps it usable). */
export const MIN_PANE = 0.1;

export function leaf(agentId: string): LayoutNode {
  return { type: "leaf", agentId };
}

/** Every agent id referenced anywhere in the tree, left-to-right / top-to-bottom. */
export function collectLeafIds(node: LayoutNode): string[] {
  if (node.type === "leaf") return [node.agentId];
  return node.children.flatMap(collectLeafIds);
}

/**
 * Path of child indices from the root down to the leaf hosting `agentId`, or null
 * if it isn't in the tree. `[]` means the root itself is that leaf.
 */
export function findLeafPath(node: LayoutNode, agentId: string, acc: number[] = []): number[] | null {
  if (node.type === "leaf") return node.agentId === agentId ? acc : null;
  for (let i = 0; i < node.children.length; i++) {
    const hit = findLeafPath(node.children[i], agentId, [...acc, i]);
    if (hit) return hit;
  }
  return null;
}

/** Walk `path` from the root and return the node there (or null if the path is stale). */
export function nodeAt(root: LayoutNode, path: number[]): LayoutNode | null {
  let n: LayoutNode = root;
  for (const i of path) {
    if (n.type !== "split" || !n.children[i]) return null;
    n = n.children[i];
  }
  return n;
}

/**
 * Deep-copy a node into PLAIN objects. Used instead of structuredClone because the
 * trees handed in from the store are Svelte 5 `$state` Proxies, and structuredClone
 * throws DataCloneError on a Proxy. Reading through the proxy and rebuilding plain
 * objects is proxy-safe and keeps this module framework-agnostic.
 */
export function cloneNode(node: LayoutNode): LayoutNode {
  if (node.type === "leaf") return { type: "leaf", agentId: node.agentId };
  return {
    type: "split",
    dir: node.dir,
    sizes: node.sizes.slice(),
    children: node.children.map(cloneNode),
  };
}

/** Renormalize a size array so it sums to 1 (guards against drift / removals). */
function normalize(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (sum <= 0) return sizes.map(() => 1 / sizes.length);
  return sizes.map((s) => s / sum);
}

/**
 * Split the pane hosting `targetId`, placing `newId` next to it along `dir`.
 * Returns a NEW root (the input tree is not mutated).
 *
 *  - Splitting the root leaf wraps it in a fresh split.
 *  - Splitting a leaf whose parent already runs along `dir` inserts a sibling and
 *    halves the target's slot between the two (keeps the other siblings' sizes).
 *  - Otherwise the leaf is replaced by a new split perpendicular to its parent.
 */
export function splitLeaf(root: LayoutNode, targetId: string, newId: string, dir: Dir): LayoutNode {
  const clone = cloneNode(root);
  const path = findLeafPath(clone, targetId);
  if (!path) return clone; // target not on screen — nothing to split

  // Root leaf: wrap it.
  if (path.length === 0) {
    return { type: "split", dir, sizes: [0.5, 0.5], children: [clone, leaf(newId)] };
  }

  const parentPath = path.slice(0, -1);
  const idx = path[path.length - 1];
  const parent = nodeAt(clone, parentPath) as Extract<LayoutNode, { type: "split" }>;

  if (parent.dir === dir) {
    // Same axis → insert a sibling, halving the target's slot.
    const share = parent.sizes[idx] / 2;
    parent.sizes.splice(idx, 1, share, share);
    parent.children.splice(idx + 1, 0, leaf(newId));
    parent.sizes = normalize(parent.sizes);
  } else {
    // Perpendicular → replace the leaf with a nested split.
    parent.children[idx] = { type: "split", dir, sizes: [0.5, 0.5], children: [parent.children[idx], leaf(newId)] };
  }
  return clone;
}

/**
 * Remove the leaf hosting `agentId`. Splits left with a single child collapse into
 * that child; the surviving siblings' sizes are renormalized. Returns the new root,
 * or null when the whole tab is now empty.
 */
export function removeLeaf(root: LayoutNode, agentId: string): LayoutNode | null {
  if (root.type === "leaf") return root.agentId === agentId ? null : root;

  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((child, i) => {
    const pruned = removeLeaf(child, agentId);
    if (pruned) {
      children.push(pruned);
      sizes.push(root.sizes[i]);
    }
  });

  if (children.length === 0) return null;
  if (children.length === 1) return children[0]; // collapse single-child split
  return { type: "split", dir: root.dir, sizes: normalize(sizes), children };
}

/** Flip the direction of the split that directly contains `agentId` (row⇄col). */
export function flipParent(root: LayoutNode, agentId: string): LayoutNode {
  const clone = cloneNode(root);
  const path = findLeafPath(clone, agentId);
  if (!path || path.length === 0) return clone; // root leaf has no split to flip
  const parent = nodeAt(clone, path.slice(0, -1)) as Extract<LayoutNode, { type: "split" }>;
  parent.dir = parent.dir === "row" ? "col" : "row";
  return clone;
}

/**
 * Transfer `deltaFrac` (fraction of the split's own axis extent) from the child
 * after gutter `index` to the child before it, clamped so neither drops below
 * {@link MIN_PANE}. Returns a new root. Used by divider drags.
 *
 * A pane can legitimately already BE under {@link MIN_PANE} — {@link splitLeaf} halves
 * the target's slot, so four same-axis splits leave a child at 0.0625 — and the clamp
 * must stay a clamp there rather than become a shove. Both bounds are therefore taken
 * against 0, which keeps `0` (leave it alone) inside the allowed range no matter how
 * small the panes are. Bounding naively (`max(d, MIN_PANE - a)` then `min(d, b - MIN)`)
 * inverts the drag instead: with `a = b = 0.05` a `+0.01` pull resolves to `-0.05`,
 * driving the divider the wrong way and collapsing `a` to an invisible zero.
 */
export function resizeAt(root: LayoutNode, path: number[], index: number, deltaFrac: number): LayoutNode {
  const clone = cloneNode(root);
  const node = nodeAt(clone, path);
  if (!node || node.type !== "split") return clone;
  const a = node.sizes[index];
  const b = node.sizes[index + 1];
  if (a == null || b == null) return clone;
  const lo = Math.min(0, MIN_PANE - a); // shrink a, but never past min (0 if already under)
  const hi = Math.max(0, b - MIN_PANE); // shrink b, but never past min (0 if already under)
  const d = Math.max(lo, Math.min(deltaFrac, hi));
  node.sizes[index] = a + d;
  node.sizes[index + 1] = b - d;
  return clone;
}

export interface Rect {
  /** All in fractions of the container, 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Gutter {
  /** Rect of the draggable handle (fractions of the container). */
  x: number;
  y: number;
  w: number;
  h: number;
  dir: Dir;
  /** Path to the split node this gutter belongs to. */
  path: number[];
  /** Boundary index: sits between child `index` and `index + 1`. */
  index: number;
  /** The split's extent along its own axis, as a fraction of the container —
   *  needed to convert a pixel drag delta into a size fraction. */
  spanFrac: number;
}

/** Half the gutter's on-screen thickness, in px (handles are drawn over the seam). */
export const GUTTER_PX = 5;

/**
 * Flatten the tree into per-agent rects plus the list of draggable gutters.
 * Rects/gutters are all in container fractions; the caller converts to px/%.
 */
export function computeLayout(
  root: LayoutNode,
  rect: Rect = { x: 0, y: 0, w: 1, h: 1 },
  path: number[] = [],
): { rects: Record<string, Rect>; gutters: Gutter[] } {
  const rects: Record<string, Rect> = {};
  const gutters: Gutter[] = [];

  if (root.type === "leaf") {
    rects[root.agentId] = rect;
    return { rects, gutters };
  }

  const sizes = normalize(root.sizes);
  let offset = 0;
  root.children.forEach((child, i) => {
    const frac = sizes[i];
    const childRect: Rect =
      root.dir === "row"
        ? { x: rect.x + rect.w * offset, y: rect.y, w: rect.w * frac, h: rect.h }
        : { x: rect.x, y: rect.y + rect.h * offset, w: rect.w, h: rect.h * frac };

    const sub = computeLayout(child, childRect, [...path, i]);
    Object.assign(rects, sub.rects);
    gutters.push(...sub.gutters);

    // A gutter sits on the leading edge of every child after the first.
    if (i > 0) {
      gutters.push(
        root.dir === "row"
          ? { x: childRect.x, y: rect.y, w: 0, h: rect.h, dir: "row", path, index: i - 1, spanFrac: rect.w }
          : { x: rect.x, y: childRect.y, w: rect.w, h: 0, dir: "col", path, index: i - 1, spanFrac: rect.h },
      );
    }
    offset += frac;
  });

  return { rects, gutters };
}
