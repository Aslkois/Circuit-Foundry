import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { bits, buildHalfAdder, clickAt, client, componentCount, expectHalfAdder, place, wire } from './helpers.ts';

/*
 * End-to-end checks of the success criterion: build a half adder from
 * individual gates with real mouse and keyboard input, verify its outputs for
 * every input combination, then save and reopen it (reload, and via an
 * exported file) without losing behaviour.
 *
 * Grid positions are converted to page coordinates with the controller's
 * clientPoint() hook; all interaction goes through real pointer events.
 */

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
  expect(doc.formatVersion).toBe(2);
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
  await expect(page.locator('.port-editor')).toContainText('in');
  await expect(page.locator('.port-editor')).toContainText('out');

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

async function circuitState(page: Page) {
  return page.evaluate(() => {
    const cf = (window as unknown as {
      circuitFoundry: {
        store: {
          viewedCircuit: { components: { id: string; type: string; x: number; y: number; rotation: number; props: Record<string, unknown> }[]; wires: unknown[] };
          getState(): { selection: { components: Set<string>; wires: Set<string> }; project: { name: string; mainCircuitId: string; circuits: { id: string; name: string }[] } };
        };
      };
    }).circuitFoundry;
    const s = cf.store.getState();
    return {
      components: cf.store.viewedCircuit.components,
      wires: cf.store.viewedCircuit.wires.length,
      selected: s.selection.components.size + s.selection.wires.size,
      projectName: s.project.name,
      main: s.project.mainCircuitId,
      circuits: s.project.circuits.map((c) => c.name),
    };
  });
}

test('inspector edits, clipboard, nudging and selection shortcuts', async ({ page }) => {
  await place(page, 'input', [0, 0], 'A');
  await place(page, 'not', [6, 0]);
  await place(page, 'output', [12, 0], 'Y');
  await wire(page, [0, 0], [4, 0]);
  await wire(page, [8, 0], [12, 0]);
  await expect.poll(() => bits(page, 'c3', 'in')).toBe('1');

  // Width change through the inspector creates a width conflict that the problems panel reports.
  await clickAt(page, [6, 0]);
  const width = page.getByLabel('Bit width');
  await width.fill('4');
  await width.press('Enter');
  await expect(page.getByTestId('problems-toggle')).toContainText('2');
  await page.getByTestId('problems-toggle').click();
  await expect(page.locator('.problems')).toContainText('different bit widths');
  await page.locator('.problems li.error').first().locator('button').click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('problems-toggle')).toHaveText(/0\s*0\s*0/);

  // Facing select rotates.
  await clickAt(page, [6, 0]);
  await page.getByLabel('Facing').selectOption('90');
  await expect.poll(async () => (await circuitState(page)).components.find((c) => c.id === 'c2')?.rotation).toBe(90);
  await page.keyboard.press('Control+z');

  // Clipboard: copy/paste and duplicate add components; select all + delete removes everything; undo restores.
  await clickAt(page, [6, 0]);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect.poll(async () => (await circuitState(page)).components.length).toBe(4);
  await page.keyboard.press('Control+d');
  await expect.poll(async () => (await circuitState(page)).components.length).toBe(5);
  await page.keyboard.press('Control+a');
  await expect.poll(async () => (await circuitState(page)).selected).toBeGreaterThan(5);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await circuitState(page)).components.length).toBe(0);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await circuitState(page)).components.length).toBe(3);

  // Arrow keys nudge the selection, keeping it connected.
  await clickAt(page, [12, 0]);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => (await circuitState(page)).components.find((c) => c.id === 'c3')?.y).toBe(6);
  await expect.poll(() => bits(page, 'c3', 'in')).toBe('1');

  // "Set value" on a new 3-bit input (placing selects it).
  await place(page, 'input', [0, 12], 'V');
  const w = page.getByLabel('Bit width');
  await w.fill('3');
  await w.press('Enter');
  await page.getByLabel('Set value').fill('0b101');
  await page.getByLabel('Set value').press('Enter');
  await expect.poll(() => bits(page, 'c4', 'out')).toBe('101');
  // Clicking a bit cell toggles just that bit (MSB is the leftmost cell).
  await clickAt(page, [-3, 12]);
  await expect.poll(() => bits(page, 'c4', 'out')).toBe('001');
});

test('simulation and view controls, dialogs and project management', async ({ page }) => {
  await place(page, 'input', [0, 0], 'A');
  for (let i = 0; i < 4; i++) await place(page, 'not', [4 + 4 * i, 0]);
  await wire(page, [0, 0], [2, 0]);
  for (let i = 0; i < 3; i++) await wire(page, [6 + 4 * i, 0], [6 + 4 * i + 2, 0]);
  await expect.poll(() => bits(page, 'c5', 'out')).toBe('0');

  // Manual propagation: with auto-propagate off, each Step advances one gate delay.
  await page.getByLabel('Auto-propagate').uncheck();
  await clickAt(page, [-1, 0]);
  await expect(page.getByTestId('sim-state')).toContainText('Propagating');
  const step = page.getByRole('button', { name: 'Step one gate delay' });
  let steps = 0;
  while ((await page.getByTestId('sim-state').textContent())?.includes('Propagating')) {
    await step.click();
    steps++;
    if (steps > 20) break;
  }
  expect(steps).toBe(5); // the input source plus four inverters
  expect(await bits(page, 'c5', 'out')).toBe('1');
  await page.getByLabel('Auto-propagate').check();

  // Reset returns inputs to power-on values.
  await page.getByRole('button', { name: 'Reset simulation (all state and inputs)' }).click();
  await expect.poll(() => bits(page, 'c1', 'out')).toBe('0');

  // Zoom controls.
  const zoomLabel = page.locator('.zoom-label');
  const before = await zoomLabel.textContent();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoomLabel).not.toHaveText(before!);
  await zoomLabel.click();
  await expect(zoomLabel).toHaveText('100%');
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(zoomLabel).toHaveText('80%');
  await page.getByRole('button', { name: 'Fit circuit in view' }).click();
  await expect(zoomLabel).not.toHaveText('80%');

  // Tick rate selector.
  await page.getByLabel('Tick rate').selectOption('64');
  await expect(page.getByLabel('Tick rate')).toHaveValue('64');

  // Help dialog opens and closes with Escape.
  await page.getByRole('button', { name: 'Help and keyboard shortcuts' }).click();
  await expect(page.getByRole('dialog')).toContainText('Keyboard and mouse');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Rename the project.
  await page.locator('.project-name').click();
  await page.getByLabel('Project name').fill('Inverter chain');
  await page.getByLabel('Project name').press('Enter');
  await expect.poll(async () => (await circuitState(page)).projectName).toBe('Inverter chain');

  // Palette filter.
  await page.getByLabel('Filter components').fill('nor');
  await expect(page.locator('.palette-item')).toHaveCount(2);
  await page.getByLabel('Filter components').fill('');

  // New circuit, make it main, then delete it (after making Main the main circuit again).
  await page.getByRole('button', { name: 'New circuit' }).click();
  await page.getByLabel('Circuit name').fill('Scratch');
  await page.getByLabel('Circuit name').press('Enter');
  await page.getByRole('button', { name: 'Make this the main circuit' }).click();
  await expect.poll(async () => (await circuitState(page)).main).not.toBe('main');
  await page.locator('.circuit-list').getByRole('button', { name: 'Main', exact: true }).click();
  await page.getByRole('button', { name: 'Make this the main circuit' }).click();
  page.once('dialog', (d) => d.accept());
  const scratch = page.locator('.circuit-row', { hasText: 'Scratch' });
  await scratch.hover();
  await scratch.getByRole('button', { name: 'Delete Scratch' }).click();
  await expect.poll(async () => (await circuitState(page)).circuits).toEqual(['Main']);

  // The projects dialog lists this project; a new blank project can be created and the old one reopened.
  await page.getByTestId('projects-button').click();
  await expect(page.locator('.project-list')).toContainText('Inverter chain');
  await page.getByRole('button', { name: 'New blank project' }).click();
  await expect(page.getByText('Empty circuit')).toBeVisible();
  await page.getByTestId('projects-button').click();
  await page.locator('.project-list .project-open', { hasText: 'Inverter chain' }).click();
  await expect.poll(async () => (await circuitState(page)).components.length).toBe(5);
});

test('push buttons drive 1 only while held; probes adapt to bus width', async ({ page }) => {
  await place(page, 'button', [0, 0], 'GO');
  await place(page, 'led', [4, 0], 'lamp');
  await wire(page, [0, 0], [4, 0]);
  await expect.poll(() => bits(page, 'c2', 'in')).toBe('0');
  const btn = await client(page, [-1, 0]);
  await page.mouse.move(btn.x, btn.y);
  await page.mouse.down();
  await expect.poll(() => bits(page, 'c2', 'in')).toBe('1');
  await page.mouse.up();
  await expect.poll(() => bits(page, 'c2', 'in')).toBe('0');

  // A probe on a 6-bit bus shows the bus value.
  await place(page, 'input', [0, 6], 'V');
  await page.getByLabel('Bit width').fill('6');
  await page.getByLabel('Bit width').press('Enter');
  await place(page, 'probe', [6, 6]);
  await wire(page, [0, 6], [6, 6]);
  await clickAt(page, [0, 6 - 0.5]);
  await page.keyboard.press('Escape');
  await expect.poll(() => bits(page, 'c4', 'in')).toBe('000000');
  // No width conflict: the probe adopts the bus width.
  await expect(page.getByTestId('problems-toggle')).toHaveText(/0\s*0\s*0/);
});

test('watches a register inside the gate-level RAM while writing to it', async ({ page }) => {
  await page.getByTestId('projects-button').click();
  await page.getByTestId('sample-ram').click();
  await expect(page.locator('.breadcrumbs')).toContainText('RAM 4×4');

  // Select the "word 2" register instance and watch its Q output.
  await clickAt(page, [50, 44]);
  await page.getByRole('button', { name: 'Watch word 2.Q' }).click();
  const watch = page.locator('.watch');
  await expect(watch).toContainText('word 2.Q');
  await expect(watch).toContainText('0xx');

  // Write 1001 to address 2 by clicking input bits: A = 10, Din = 1001, WE = 1, pulse CLK.
  await clickAt(page, [-2, 4]); // A bit 1
  await clickAt(page, [-4, 78]); // Din bit 3
  await clickAt(page, [-1, 78]); // Din bit 0
  await clickAt(page, [-1, 70]); // WE
  await clickAt(page, [-1, 74]); // CLK rises
  await clickAt(page, [-1, 74]); // CLK falls
  await expect(watch).toContainText('0x9');
  await expect.poll(() => bits(page, 'c5', 'in')).toBe('1001'); // Dout reads the selected word

  // The watch keeps working while looking inside another instance.
  const reg = await client(page, [50, 44]);
  await page.mouse.dblclick(reg.x, reg.y);
  await expect(page.locator('.breadcrumbs')).toContainText('word 2');
  await expect(watch).toContainText('0x9');
  await watch.getByRole('button', { name: /Stop watching/ }).click();
  await expect(page.locator('.watch')).toHaveCount(0);
});
