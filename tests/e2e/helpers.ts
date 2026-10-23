import { expect, type Page } from '@playwright/test';

/*
 * Shared end-to-end helpers. Grid positions are converted to page
 * coordinates with the controller's clientPoint() hook; all interaction goes
 * through real pointer events.
 */

export type Pt = [number, number];

export async function client(page: Page, [x, y]: Pt): Promise<{ x: number; y: number }> {
  return page.evaluate(([gx, gy]) => {
    const cf = (window as unknown as { circuitFoundry: { services: { controller(): { clientPoint(x: number, y: number): { x: number; y: number } } } } }).circuitFoundry;
    return cf.services.controller().clientPoint(gx, gy);
  }, [x, y] as const);
}

export async function place(page: Page, type: string, at: Pt, label?: string): Promise<void> {
  await page.click(`.palette-item[data-type="${type}"]`);
  const p = await client(page, at);
  await page.mouse.click(p.x, p.y);
  if (label !== undefined) {
    const field = page.getByLabel('Label', { exact: true });
    await field.fill(label);
    await field.press('Enter');
  }
}

/** Drag a wire; the first movement is horizontal so the route bends horizontal-first. */
export async function wire(page: Page, from: Pt, to: Pt): Promise<void> {
  const a = await client(page, from);
  const b = await client(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + Math.sign(b.x - a.x || 1) * 30, a.y, { steps: 3 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

export async function clickAt(page: Page, at: Pt): Promise<void> {
  const p = await client(page, at);
  await page.mouse.click(p.x, p.y);
}

/** Value (as a bit string) at a pin of a top-level component, read from the running simulation. */
export async function bits(page: Page, componentId: string, pin: string): Promise<string> {
  return page.evaluate(
    ([id, pinName]) => {
      const cf = (window as unknown as { circuitFoundry: { host: { valueAt(p: string[], c: string, n: string): { width: number; a: number; b: number } | null } } }).circuitFoundry;
      const v = cf.host.valueAt([], id, pinName);
      if (!v) return 'none';
      let s = '';
      for (let i = v.width - 1; i >= 0; i--) {
        const a = (v.a >>> i) & 1;
        const b = (v.b >>> i) & 1;
        s += b ? (a ? 'x' : 'z') : String(a);
      }
      return s;
    },
    [componentId, pin] as const,
  );
}

export async function componentCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const cf = (window as unknown as { circuitFoundry: { store: { viewedCircuit: { components: unknown[] } } } }).circuitFoundry;
    return cf.store.viewedCircuit.components.length;
  });
}

/** Ids follow placement order: A=c1, B=c2, XOR=c3, AND=c4, S=c5, C=c6. */
export async function expectHalfAdder(page: Page): Promise<void> {
  // Each input starts at 0; click a bit cell (grid -1,0 relative to the pin anchor) to toggle it.
  const A: Pt = [-1, 0];
  const B: Pt = [-1, 10];
  const table: [number, number, string, string][] = [
    [0, 0, '0', '0'],
    [1, 0, '1', '0'],
    [1, 1, '0', '1'],
    [0, 1, '1', '0'],
  ];
  await expect.poll(() => bits(page, 'c1', 'out')).toMatch(/^[01]$/);
  await expect.poll(() => bits(page, 'c2', 'out')).toMatch(/^[01]$/);
  let a = Number(await bits(page, 'c1', 'out'));
  let b = Number(await bits(page, 'c2', 'out'));
  for (const [wantA, wantB, s, c] of table) {
    if (a !== wantA) {
      await clickAt(page, A);
      a = wantA;
    }
    if (b !== wantB) {
      await clickAt(page, B);
      b = wantB;
    }
    await expect.poll(() => bits(page, 'c1', 'out')).toBe(String(wantA));
    await expect.poll(() => bits(page, 'c2', 'out')).toBe(String(wantB));
    expect(await bits(page, 'c5', 'in'), `S for A=${wantA} B=${wantB}`).toBe(s);
    expect(await bits(page, 'c6', 'in'), `C for A=${wantA} B=${wantB}`).toBe(c);
  }
}

export async function buildHalfAdder(page: Page): Promise<void> {
  await place(page, 'input', [0, 0], 'A');
  await place(page, 'input', [0, 10], 'B');
  await place(page, 'xor', [10, 1]);
  await place(page, 'and', [10, 9]);
  await place(page, 'output', [18, 1], 'S');
  await place(page, 'output', [18, 9], 'C');
  expect(await componentCount(page)).toBe(6);

  await wire(page, [0, 0], [7, 0]); // A → XOR.in0
  await wire(page, [0, 10], [7, 10]); // B → AND.in1
  await wire(page, [7, 8], [3, 0]); // AND.in0 → tap on A's wire
  await wire(page, [7, 2], [5, 10]); // XOR.in1 → tap on B's wire
  await wire(page, [13, 1], [18, 1]); // XOR.out → S
  await wire(page, [13, 9], [18, 9]); // AND.out → C
}
