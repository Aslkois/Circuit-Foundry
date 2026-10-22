/**
 * Document model: what a user edits and what gets saved.
 *
 * All coordinates are integer grid units. Documents are immutable values;
 * edits produce new objects and share unchanged parts, which makes undo/redo
 * snapshots cheap and lets caches key on object identity.
 */

import type { PropValue } from '../engine/netlist.ts';

export type { PropValue };

/** Clockwise rotation from the default east-facing orientation. */
export type Rotation = 0 | 90 | 180 | 270;

export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

export type Props = Readonly<Record<string, PropValue>>;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface ComponentInstance {
  /** Unique within its circuit; [A-Za-z0-9_-]+ (used in hierarchical simulation keys). */
  readonly id: string;
  /** Catalog type, e.g. "and", "input", "subcircuit". */
  readonly type: string;
  /** Anchor position. */
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
  readonly props: Props;
}

/** A straight horizontal or vertical wire segment between two grid points. */
export interface Wire {
  readonly id: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface Circuit {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly components: readonly ComponentInstance[];
  readonly wires: readonly Wire[];
}

export interface Project {
  readonly id: string;
  readonly name: string;
  /** Circuit simulated by default when the project opens. */
  readonly mainCircuitId: string;
  readonly circuits: readonly Circuit[];
  /** ISO-8601 timestamps. */
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function findCircuit(project: Project, id: string): Circuit | undefined {
  return project.circuits.find((c) => c.id === id);
}

const SMALL = 16384;

/**
 * Numeric key for an integer grid point, for maps and sets. Points within
 * ±16383 (any realistic schematic) map to small integers below 2^30, which
 * V8 stores unboxed; anything further out maps to a disjoint range above.
 */
export function pointKey(x: number, y: number): number {
  if (x > -SMALL && x < SMALL && y > -SMALL && y < SMALL) return ((x + SMALL) << 15) | (y + SMALL);
  return 2 ** 30 + (x + 2 ** 25) * 2 ** 26 + (y + 2 ** 25);
}
