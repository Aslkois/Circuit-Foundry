import type { ReactElement } from 'react';
import { formatValue } from '../../engine/logic.ts';
import { findCircuit, getDef, strOf, type Project } from '../../model/index.ts';
import { useEditor, useServices, useSimStatus } from '../context.ts';
import { useObservable } from '../state/observable.ts';
import { resolvePath } from '../state/store.ts';
import { Icon } from './icons.tsx';

/** Human-readable location of a pin: "word 2 › bit 1 › Q". */
export function pinLocationLabel(project: Project, rootId: string, path: readonly string[], componentId: string, pin: string): string {
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const parent = resolvePath(project, rootId, path.slice(0, i)).circuit;
    const inst = parent.components.find((c) => c.id === path[i]);
    parts.push(inst ? strOf(inst.props, 'label') || findCircuit(project, strOf(inst.props, 'circuit'))?.name || inst.id : path[i]);
  }
  const circuit = resolvePath(project, rootId, path).circuit;
  const comp = circuit.components.find((c) => c.id === componentId);
  let pinLabel = pin;
  if (comp?.type === 'subcircuit') {
    const target = findCircuit(project, strOf(comp.props, 'circuit'));
    const port = target?.components.find((c) => c.id === pin);
    pinLabel = (port && strOf(port.props, 'label')) || pin;
  }
  const compLabel = comp ? strOf(comp.props, 'label') || (comp.type === 'subcircuit' ? findCircuit(project, strOf(comp.props, 'circuit'))?.name : getDef(comp.type)?.name) || comp.id : componentId;
  const onlyPin = comp && (comp.type === 'input' || comp.type === 'output' || comp.type === 'led' || comp.type === 'probe' || comp.type === 'constant' || comp.type === 'clock' || comp.type === 'button');
  parts.push(onlyPin ? compLabel : `${compLabel}.${pinLabel}`);
  return parts.join(' › ');
}

export function WatchPanel(): ReactElement | null {
  const { watches, host, store } = useServices();
  const items = useObservable(watches.items);
  const rootId = useEditor((s) => s.rootCircuitId);
  const project = useEditor((s) => s.project);
  useSimStatus();
  if (items.length === 0) return null;
  return (
    <section className="watch" aria-label="Watched signals">
      <header>
        <h2>Watch</h2>
        <button className="link small" onClick={() => watches.clear()}>
          Clear
        </button>
      </header>
      <table>
        <tbody>
          {items.map((w) => {
            const live = w.rootCircuitId === rootId;
            const v = live ? host.valueAt(w.path, w.componentId, w.pin) : null;
            const rootName = findCircuit(project, w.rootCircuitId)?.name ?? w.rootCircuitId;
            return (
              <tr key={w.id}>
                <th scope="row" title={live ? w.label : `Recorded while simulating "${rootName}"`}>
                  <button
                    className="watch-go"
                    onClick={() => {
                      if (!live) store.openCircuit(w.rootCircuitId);
                      else {
                        store.exitTo(0);
                        for (const id of w.path) store.enterInstance(id);
                      }
                      store.setSelection({ components: new Set([w.componentId]), wires: new Set() });
                    }}
                  >
                    {w.label}
                  </button>
                </th>
                <td className="mono">
                  {live ? (
                    v ? (
                      <button className="radix" title="Change number format" onClick={() => watches.cycleRadix(w.id)}>
                        {v.width === 1 ? formatValue(v, 'bin') : `${w.radix === 'hex' ? '0x' : w.radix === 'bin' ? '0b' : ''}${formatValue(v, w.radix)}`}
                      </button>
                    ) : (
                      <span className="muted">gone</span>
                    )
                  ) : (
                    <span className="muted small">in {rootName}</span>
                  )}
                </td>
                <td>
                  <button className="icon-button small" aria-label={`Stop watching ${w.label}`} onClick={() => watches.remove(w.id)}>
                    <Icon name="close" size={12} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
