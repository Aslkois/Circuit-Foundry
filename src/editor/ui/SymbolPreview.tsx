import { useEffect, useRef, type ReactElement } from 'react';
import { defaultProps, getDef, resolveComponent, unionRect, type LayoutContext, type Props, type Rect } from '../../model/index.ts';
import { Painter } from '../canvas/painter.ts';
import { drawComponent } from '../canvas/symbols.ts';
import { Viewport } from '../canvas/viewport.ts';

const NO_SUBCIRCUITS: LayoutContext = { getInterface: () => undefined };

/** Renders a component symbol with the same code as the main canvas. */
export function SymbolPreview({ type, props, width = 44, height = 30 }: { type: string; props?: Props; width?: number; height?: number }): ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const def = getDef(type);
    if (!canvas || !def) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const comp = { id: 'preview', type, x: 0, y: 0, rotation: 0 as const, props: { ...defaultProps(def), ...props, label: '' } };
    const rc = resolveComponent(comp, NO_SUBCIRCUITS);
    let r: Rect = rc.bounds;
    for (const pin of rc.pins) r = unionRect(r, { x: pin.x, y: pin.y, w: 0, h: 0 });
    const vp = new Viewport();
    vp.width = width;
    vp.height = height;
    vp.fit(r, 0.4, 20);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const p = new Painter(ctx, vp, dpr);
    p.world();
    drawComponent(p, rc, { signals: null, selected: false, ghost: false });
  }, [type, props, width, height]);
  return <canvas ref={ref} style={{ width, height }} aria-hidden="true" />;
}
