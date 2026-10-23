import type { Radix } from '../../engine/logic.ts';
import { Observable } from './observable.ts';

/** A pin, anywhere in the design hierarchy, whose value is shown in the Watch panel. */
export interface Watch {
  readonly id: number;
  /** Simulation root the path is relative to. */
  readonly rootCircuitId: string;
  /** Subcircuit instance path from the root. */
  readonly path: readonly string[];
  readonly componentId: string;
  readonly pin: string;
  readonly label: string;
  readonly radix: Radix;
}

const RADIX_ORDER: Radix[] = ['hex', 'bin', 'dec', 'sdec'];

/** The watch list of the open project. It lives for the session and is cleared when another project opens. */
export class WatchList {
  readonly items = new Observable<readonly Watch[]>([]);
  private nextId = 1;

  add(w: Omit<Watch, 'id' | 'radix'>): void {
    const list = this.items.get();
    const same = (x: Watch) => x.rootCircuitId === w.rootCircuitId && x.componentId === w.componentId && x.pin === w.pin && x.path.join('/') === w.path.join('/');
    if (list.some(same)) return;
    this.items.set([...list, { ...w, id: this.nextId++, radix: 'hex' }]);
  }

  has(rootCircuitId: string, path: readonly string[], componentId: string, pin: string): boolean {
    const key = path.join('/');
    return this.items.get().some((x) => x.rootCircuitId === rootCircuitId && x.componentId === componentId && x.pin === pin && x.path.join('/') === key);
  }

  remove(id: number): void {
    this.items.set(this.items.get().filter((x) => x.id !== id));
  }

  removeWhere(rootCircuitId: string, path: readonly string[], componentId: string, pin: string): void {
    const key = path.join('/');
    this.items.set(this.items.get().filter((x) => !(x.rootCircuitId === rootCircuitId && x.componentId === componentId && x.pin === pin && x.path.join('/') === key)));
  }

  cycleRadix(id: number): void {
    this.items.set(this.items.get().map((x) => (x.id === id ? { ...x, radix: RADIX_ORDER[(RADIX_ORDER.indexOf(x.radix) + 1) % RADIX_ORDER.length] } : x)));
  }

  clear(): void {
    this.items.set([]);
  }
}
