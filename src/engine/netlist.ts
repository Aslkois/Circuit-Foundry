/**
 * Flat netlist: the engine's only input format.
 *
 * A netlist is a set of nets (word-level signal bundles of a fixed width) and
 * primitive component instances whose pins reference nets by index. Optional
 * bit links join individual bits of different nets into one electrical node;
 * this is how bus splitters are represented (they have no behaviour of their
 * own, they only define connectivity).
 *
 * Netlists carry no geometry and no hierarchy. The document model flattens
 * hierarchical, geometric circuits into this form.
 */

export type PropValue = number | string | boolean;
export type PrimitiveProps = Readonly<Record<string, PropValue>>;

export interface NetlistNet {
  /** Bit width, 1..MAX_WIDTH. */
  readonly width: number;
}

export interface NetlistComponent {
  /**
   * Stable identifier, unique within the netlist. Hierarchical designs use
   * slash-separated instance paths (e.g. "c4/c12"). Simulator state snapshots
   * are keyed by it, so it must survive recompilation of an unchanged design.
   */
  readonly key: string;
  /** Primitive type, resolved through the primitive library. */
  readonly type: string;
  readonly props: PrimitiveProps;
  /** Net index for each pin, in the primitive's pin order; -1 leaves a pin unconnected. */
  readonly pins: readonly number[];
}

/** Joins bit `bitA` of net `netA` with bit `bitB` of net `netB` (bidirectionally). */
export interface BitLink {
  readonly netA: number;
  readonly bitA: number;
  readonly netB: number;
  readonly bitB: number;
}

export interface Netlist {
  readonly nets: readonly NetlistNet[];
  readonly components: readonly NetlistComponent[];
  readonly links?: readonly BitLink[];
}

export class NetlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetlistError';
  }
}

/** Incremental construction helper, mainly for tests and programmatic designs. */
export class NetlistBuilder {
  private readonly nets: NetlistNet[] = [];
  private readonly components: NetlistComponent[] = [];
  private readonly links: BitLink[] = [];
  private autoKey = 0;

  net(width = 1): number {
    this.nets.push({ width });
    return this.nets.length - 1;
  }

  add(type: string, props: PrimitiveProps, pins: readonly number[], key?: string): string {
    const k = key ?? `${type}${this.autoKey++}`;
    this.components.push({ key: k, type, props, pins: [...pins] });
    return k;
  }

  link(netA: number, bitA: number, netB: number, bitB: number): void {
    this.links.push({ netA, bitA, netB, bitB });
  }

  build(): Netlist {
    return { nets: [...this.nets], components: [...this.components], links: [...this.links] };
  }
}
