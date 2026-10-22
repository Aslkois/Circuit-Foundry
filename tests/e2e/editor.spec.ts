import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/*
 * End-to-end checks of the success criterion: build a half adder from
 * individual gates with real mouse and keyboard input, verify its outputs for
 * every input combination, then save and reopen it (reload, and via an
 * exported file) without losing behaviour.
 *
 * Grid positions are converted to page coordinates with the controller's
 * clientPoint() hook; all interaction goes through real pointer events.
 */

type Pt = [number, number];

async function client(page: Page, [x, y]: Pt): Promise<{ x: number; y: number }> {
  return page.evaluate(([gx, gy]) => {
    const cf = (window as unknown as { circuitFoundry: { services: { controller(): { clientPoint(x: number, y: number): { x: number; y: number } } } } }).circuitFoundry;
    return cf.services.controller().clientPoint(gx, gy);
  }, [x, y] as const);
}

async function place(page: Page, type: string, at: Pt, label?: string): Promise<void> {
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
async function wire(page: Page, from: Pt, to: Pt): Promise<void> {
  const a = await client(page, from);
  const b = await client(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + Math.sign(b.x - a.x || 1) * 30, a.y, { steps: 3 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

async function clickAt(page: Page, at: Pt): Promise<void> {
  const p = await client(page, at);
  await page.mouse.click(p.x, p.y);
}

/** Value (as a bit string) at a pin of a top-level component, read from the running simulation. */
async function bits(page: Page, componentId: string, pin: string): Promise<string> {
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

async function componentCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const cf = (window as unknown as { circuitFoundry: { store: { viewedCircuit: { components: unknown[] } } } }).circuitFoundry;
    return cf.store.viewedCircuit.components.length;
  });
}

/** Ids follow placement order: A=c1, B=c2, XOR=c3, AND=c4, S=c5, C=c6. */
async function expectHalfAdder(page: Page): Promise<void> {
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

async function buildHalfAdder(page: Page): Promise<void> {
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

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.goto('/');
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByText('Empty circuit')).toBeVisible();
});

test('builds a working half adder from gates, then saves and reopens it', async ({ page }) => {
  await buildHalfAdder(page);
  await expectHalfAdder(page);
  await page.screenshot({ path: 'test-results/half-adder-built.png' });

  // No problems reported for a correctly wired circuit.
  await expect(page.getByTestId('problems-toggle')).toHaveText(/0\s*0\s*0/);

  // Autosave, then reload the page: the project comes back with the same behaviour.
  await expect(page.getByTestId('save-status')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect.poll(() => componentCount(page)).toBe(6);
  await expectHalfAdder(page);
});

test('exports a project file and imports it into a fresh browser profile', async ({ page, browser }) => {
  await buildHalfAdder(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export project file' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const text = readFileSync(path, 'utf8');
  const doc = JSON.parse(text);
  expect(doc.format).toBe('circuit-foundry-project');
  expect(doc.formatVersion).toBe(1);
  expect(doc.project.circuits[0].components).toHaveLength(6);

  const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page2 = await fresh.newPage();
  await page2.goto('/');
  await expect(page2.getByText('Empty circuit')).toBeVisible();
  const chooser = page2.waitForEvent('filechooser');
  await page2.getByRole('button', { name: 'Import project file' }).click();
  await (await chooser).setFiles(path);
  await expect.poll(() => componentCount(page2)).toBe(6);
  await expectHalfAdder(page2);
  await fresh.close();
});

test('undo, redo, rotate and delete', async ({ page }) => {
  await buildHalfAdder(page);
  // Select the XOR gate and delete it: S loses its driver and floats.
  await clickAt(page, [10, 1]);
  await page.keyboard.press('Delete');
  await expect.poll(() => componentCount(page)).toBe(5);
  expect(await bits(page, 'c5', 'in')).toBe('z');
  await page.keyboard.press('Control+z');
  await expect.poll(() => componentCount(page)).toBe(6);
  await expectHalfAdder(page);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => componentCount(page)).toBe(5);
  await page.keyboard.press('Control+z');

  // Rotate the AND gate with R, check it, and rotate back with Shift+R.
  await clickAt(page, [10, 9]);
  await page.keyboard.press('r');
  const rotation = () =>
    page.evaluate(() => {
      const cf = (window as unknown as { circuitFoundry: { store: { viewedCircuit: { components: { id: string; rotation: number }[] } } } }).circuitFoundry;
      return cf.store.viewedCircuit.components.find((c) => c.id === 'c4')!.rotation;
    });
  await expect.poll(rotation).toBe(90);
  await page.keyboard.press('Shift+R');
  await expect.poll(rotation).toBe(0);
  await expectHalfAdder(page);
});

test('opens an example, looks inside a subcircuit, and runs a clock', async ({ page }) => {
  await page.getByTestId('projects-button').click();
  await page.getByTestId('sample-d-flip-flop').click();
  await expect(page.locator('.circuit-row', { hasText: 'Clocked demo' })).toBeVisible();
  await page.locator('.circuit-row', { hasText: 'Clocked demo' }).locator('.circuit-open').click();
  await expect(page.locator('.breadcrumbs')).toContainText('Clocked demo');

  // D=0 initially; set D=1 and tick the clock twice (one full period): the LED (c4) lights.
  await clickAt(page, [-1, 0]);
  await expect.poll(() => bits(page, 'c1', 'out')).toBe('1');
  await page.getByTestId('tick-button').click();
  await page.getByTestId('tick-button').click();
  await expect.poll(() => bits(page, 'c4', 'in')).toBe('1');

  // Run the clock continuously and pause again.
  await page.getByTestId('run-button').click();
  await expect(page.getByTestId('sim-state')).toContainText('running');
  await page.waitForTimeout(600);
  await page.getByTestId('run-button').click();
  await expect(page.getByTestId('sim-state')).not.toContainText('running');

  // Double-click the flip-flop instance to look inside it.
  const ff = await client(page, [10, 1]);
  await page.mouse.dblclick(ff.x, ff.y);
  await expect(page.locator('.breadcrumbs')).toContainText('D flip-flop');
  await expect(page.locator('.instance-note')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.instance-note')).toHaveCount(0);
});

test('reports an oscillating circuit instead of hanging', async ({ page }) => {
  // An inverter whose output feeds its own input, enabled through a NAND gate.
  await place(page, 'input', [0, 0], 'EN');
  await place(page, 'nand', [8, 1]);
  await wire(page, [0, 0], [5, 0]);
  await wire(page, [11, 1], [12, 1]);
  await page.keyboard.press('w');
  // Feedback: from the NAND output around to its second input.
  await wire(page, [12, 1], [12, 4]);
  await wire(page, [12, 4], [4, 4]);
  await wire(page, [4, 4], [4, 2]);
  await wire(page, [4, 2], [5, 2]);
  await page.keyboard.press('Escape');
  await clickAt(page, [-1, 0]); // EN = 1: the NAND now inverts its own output
  await expect(page.getByTestId('sim-state')).toContainText('Oscillating');
  await page.getByTestId('problems-toggle').click();
  await expect(page.locator('.problems')).toContainText('does not settle');
});

test('creates a reusable component and uses it in another circuit', async ({ page }) => {
  // New circuit "Inverter": in → NOT → out.
  await page.getByRole('button', { name: 'New circuit' }).click();
  const rename = page.getByLabel('Circuit name');
  await rename.fill('Inverter');
  await rename.press('Enter');
  await expect(page.locator('.breadcrumbs')).toContainText('Inverter');
  await place(page, 'input', [0, 0], 'in');
  await place(page, 'not', [6, 0]);
  await place(page, 'output', [12, 0], 'out');
  await wire(page, [0, 0], [4, 0]);
  await wire(page, [8, 0], [12, 0]);

  // The interface is derived from the labelled pins.
  await clickAt(page, [20, 10]); // click empty canvas to show circuit properties
  await expect(page.locator('.ports')).toContainText('in');
  await expect(page.locator('.ports')).toContainText('out');

  // An Inverter cannot be placed inside itself.
  const row = page.locator('.circuit-row', { hasText: 'Inverter' });
  await row.hover();
  await expect(row.getByRole('button', { name: 'Place Inverter' })).toBeDisabled();

  // Back to Main: place two inverters in series between an input and an output.
  await page.locator('.circuit-row', { hasText: 'Main' }).locator('.circuit-open').click();
  await expect(page.locator('.breadcrumbs')).toContainText('Main');
  await place(page, 'input', [0, 0], 'X');
  await row.hover();
  await row.getByRole('button', { name: 'Place Inverter' }).click();
  await clickAt(page, [8, 0]); // instance pins at x = 4 (in) and 12 (out)
  // Second instance by dragging the circuit from the list onto the canvas.
  const target = await client(page, [22, 0]);
  await row.dragTo(page.getByTestId('canvas'), { targetPosition: { x: target.x - (await page.getByTestId('canvas').boundingBox())!.x, y: target.y - (await page.getByTestId('canvas').boundingBox())!.y } });
  await place(page, 'output', [30, 0], 'Y');
  await expect.poll(() => componentCount(page)).toBe(4);
  await wire(page, [0, 0], [4, 0]);
  await wire(page, [12, 0], [18, 0]);
  await wire(page, [26, 0], [30, 0]);

  // Main: c1 = X, c2 and c3 = instances, c4 = Y. Two inversions cancel out.
  await expect.poll(() => bits(page, 'c4', 'in')).toBe('0');
  await clickAt(page, [-1, 0]);
  await expect.poll(() => bits(page, 'c4', 'in')).toBe('1');

  // Edit the definition (make it a buffer by removing the NOT and re-wiring): both instances change.
  await page.locator('.circuit-row', { hasText: 'Inverter' }).locator('.circuit-open').click();
  await clickAt(page, [6, 0]);
  await page.keyboard.press('Delete');
  await wire(page, [4, 0], [8, 0]);
  await page.locator('.circuit-row', { hasText: 'Main' }).locator('.circuit-open').click();
  // X is still 1 (state survives edits); with buffers instead of inverters Y = X.
  await expect.poll(() => bits(page, 'c1', 'out')).toBe('1');
  await expect.poll(() => bits(page, 'c4', 'in')).toBe('1');
});

test('places components by dragging them from the palette', async ({ page }) => {
  const canvas = page.getByTestId('canvas');
  const box = (await canvas.boundingBox())!;
  const at = await client(page, [10, 4]);
  await page.locator('.palette-item[data-type="and"]').dragTo(canvas, { targetPosition: { x: at.x - box.x, y: at.y - box.y } });
  await expect.poll(() => componentCount(page)).toBe(1);
  const comp = await page.evaluate(() => {
    const cf = (window as unknown as { circuitFoundry: { store: { viewedCircuit: { components: { type: string; x: number; y: number }[] } } } }).circuitFoundry;
    return cf.store.viewedCircuit.components[0];
  });
  expect(comp).toMatchObject({ type: 'and', x: 10, y: 4 });
});
