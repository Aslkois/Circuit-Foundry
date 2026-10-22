import { useEffect, useRef, type DragEvent, type ReactElement } from 'react';
import { findCircuit, getDef, strOf, usersOf } from '../../model/index.ts';
import { CanvasController } from '../canvas/controller.ts';
import { useEditor, useServices } from '../context.ts';
import { useObservable } from '../state/observable.ts';
import { resolvePath } from '../state/store.ts';
import { formatLogic } from './Inspector.tsx';
import { Icon } from './icons.tsx';
import { DRAG_MIME } from './Sidebar.tsx';

function Breadcrumbs(): ReactElement {
  const { store } = useServices();
  const project = useEditor((s) => s.project);
  const rootId = useEditor((s) => s.rootCircuitId);
  const path = useEditor((s) => s.path);
  const root = findCircuit(project, rootId);
  const crumbs: { label: string; depth: number }[] = [{ label: root?.name ?? rootId, depth: 0 }];
  for (let i = 0; i < path.length; i++) {
    const parent = resolvePath(project, rootId, path.slice(0, i)).circuit;
    const comp = parent.components.find((c) => c.id === path[i]);
    const child = comp ? findCircuit(project, strOf(comp.props, 'circuit')) : undefined;
    const label = comp && strOf(comp.props, 'label') ? `${strOf(comp.props, 'label')} (${child?.name ?? '?'})` : (child?.name ?? path[i]);
    crumbs.push({ label, depth: i + 1 });
  }
  const viewed = store.viewedCircuit;
  const users = path.length > 0 ? usersOf(project, viewed.id).length : 0;
  return (
    <nav className="breadcrumbs" aria-label="Circuit path">
      {crumbs.map((c, i) => (
        <span key={c.depth} className="crumb">
          {i > 0 && <span className="sep">›</span>}
          <button onClick={() => store.exitTo(c.depth)} disabled={c.depth === path.length} aria-current={c.depth === path.length ? 'page' : undefined}>
            {c.label}
          </button>
        </span>
      ))}
      {path.length > 0 && (
        <span className="instance-note">
          <Icon name="info" size={13} /> Live view of this instance. Edits change the “{viewed.name}” definition{users > 1 ? `, used in ${users} circuits` : ''}.
          <button className="link" onClick={() => store.exitTo(path.length - 1)}>
            <Icon name="up" size={12} /> Up
          </button>
        </span>
      )}
    </nav>
  );
}

function HoverTooltip(): ReactElement | null {
  const { view } = useServices();
  const info = useObservable(view.hover);
  if (!info) return null;
  let text: string;
  if (info.widthConflict) text = 'Bit widths disagree on this wire';
  else if (info.pins === 0) text = 'Not connected to any pin';
  else text = formatLogic(info.value);
  return (
    <div className="hover-tip" style={{ left: info.sx + 14, top: info.sy + 14 }} role="status">
      {info.pinName && <div className="tip-title">{info.pinName}</div>}
      <div className="mono">{text}</div>
      <div className="muted small">
        {info.width !== null ? `${info.width}-bit` : 'width ?'}
        {info.contended ? ' · conflicting drivers' : ''}
      </div>
    </div>
  );
}

function EmptyHint(): ReactElement | null {
  const { store, actions } = useServices();
  const empty = useEditor(() => store.viewedCircuit.components.length === 0 && store.viewedCircuit.wires.length === 0);
  if (!empty) return null;
  return (
    <div className="empty-hint">
      <h2>Empty circuit</h2>
      <p>Click a component in the palette and then click here to place it, or drag it in. Drag from a pin to draw a wire.</p>
      <p>
        <button className="link" onClick={actions.openProjects}>
          Open an example
        </button>{' '}
        ·{' '}
        <button className="link" onClick={actions.openHelp}>
          Keyboard shortcuts
        </button>
      </p>
    </div>
  );
}

function ToolHint(): ReactElement | null {
  const tool = useEditor((s) => s.tool);
  if (tool.kind === 'select') return null;
  const text =
    tool.kind === 'wire'
      ? 'Wire tool: drag between points, or click to start and click to bend; right-click or Esc to finish.'
      : `Placing ${getDef(tool.type)?.name ?? tool.type}: click to place (Shift+click to keep placing) · R rotates · Esc cancels`;
  return <div className="tool-hint">{text}</div>;
}

export function Notice(): ReactElement | null {
  const { store } = useServices();
  const notice = useEditor((s) => s.notice);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => store.dismissNotice(notice.id), notice.kind === 'error' ? 6000 : 3500);
    return () => clearTimeout(t);
  }, [notice, store]);
  if (!notice) return null;
  return (
    <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      {notice.text}
      <button className="icon-button" aria-label="Dismiss" onClick={() => store.dismissNotice(notice.id)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

export function CanvasView({ onController }: { onController: (c: CanvasController | null) => void }): ReactElement {
  const { store, host, view } = useServices();
  const ref = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<CanvasController | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const c = new CanvasController(canvas, store, host);
    c.onZoom = (z) => view.zoom.set(z);
    c.onPointer = (p) => view.pointer.set(p);
    c.onHoverInfo = (h) => view.hover.set(h);
    view.zoom.set(c.vp.zoom);
    controllerRef.current = c;
    onController(c);
    return () => {
      onController(null);
      c.dispose();
      controllerRef.current = null;
    };
  }, [store, host, view, onController]);

  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDrop = (e: DragEvent) => {
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    e.preventDefault();
    try {
      const { type, props } = JSON.parse(raw) as { type: string; props: Record<string, string | number | boolean> };
      controllerRef.current?.dropAt(e.clientX, e.clientY, type, props);
    } catch {
      /* ignore malformed drops */
    }
  };

  return (
    <main className="canvas-area">
      <Breadcrumbs />
      <div className="canvas-wrap" onDragOver={onDragOver} onDrop={onDrop}>
        <canvas ref={ref} className="circuit-canvas" tabIndex={0} aria-label="Circuit canvas" data-testid="canvas" />
        <EmptyHint />
        <ToolHint />
        <HoverTooltip />
        <Notice />
      </div>
    </main>
  );
}
