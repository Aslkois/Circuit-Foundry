import { expect, test, type Page } from '@playwright/test';
import { bits, buildHalfAdder, clickAt, client, expectHalfAdder, place, wire } from './helpers.ts';

/*
 * Hierarchical components through the UI: create a component from a
 * selection, look inside it, edit its symbol and parameters, and check that
 * instances keep working with their connections intact.
 */

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.goto('/');
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByText('Empty circuit')).toBeVisible();
});

async function valueInside(page: Page, path: string[], componentId: string, pin: string): Promise<string> {
  return page.evaluate(
    ([p, id, pinName]) => {
      const cf = (window as unknown as { circuitFoundry: { host: { valueAt(p: string[], c: string, n: string): { width: number; a: number; b: number } | null } } }).circuitFoundry;
      const v = cf.host.valueAt(p as string[], id as string, pinName as string);
      if (!v) return 'none';
      let s = '';
      for (let i = v.width - 1; i >= 0; i--) s += (v.b >>> i) & 1 ? ((v.a >>> i) & 1 ? 'x' : 'z') : String((v.a >>> i) & 1);
      return s;
    },
    [path, componentId, pin] as const,
  );
}

async function setField(page: Page, label: string, value: string): Promise<void> {
  const field = page.getByLabel(label, { exact: true });
  await field.fill(value);
  await field.press('Enter');
}

test('turns a selection into a component that keeps the circuit working', async ({ page }) => {
  await buildHalfAdder(page);
  // Select the two gates (XOR at 10,1 and AND at 10,9).
  await clickAt(page, [10, 1]);
  const and = await client(page, [10, 9]);
  await page.keyboard.down('Shift');
  await page.mouse.click(and.x, and.y);
  await page.keyboard.up('Shift');
  await expect(page.locator('.inspector')).toContainText('2 component(s)');

  await page.keyboard.press('Control+g');
  const dialog = page.getByRole('dialog', { name: 'Create component' });
  await expect(dialog).toBeVisible();
  // The ports are named after the pins they connect to.
  for (const name of ['A', 'B', 'S', 'C']) await expect(dialog.locator('.ports')).toContainText(name);
  await dialog.getByLabel('Name').fill('Adder core');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.notice')).toContainText('Created "Adder core" with 4 ports');
  await expect(page.locator('.notice')).not.toContainText('tunnel');

  // The new component appears in the palette and the circuit list.
  await expect(page.locator('.palette-item[aria-label="Component Adder core"]')).toBeVisible();
  await expect(page.locator('.circuit-row', { hasText: 'Adder core' })).toBeVisible();

  // Same behaviour as before, now through the instance (c7).
  await expectHalfAdder(page);
  await expect(page.getByTestId('problems-toggle')).toHaveText(/0\s*0\s*0/);

  // Look inside the instance: its gates are simulated with this instance's values (A = 0, B = 1 now).
  const inst = await page.evaluate(() => {
    const cf = (window as unknown as { circuitFoundry: { store: { viewedCircuit: { components: { id: string; type: string; x: number; y: number }[] } } } }).circuitFoundry;
    const c = cf.store.viewedCircuit.components.find((k) => k.type === 'subcircuit')!;
    return { id: c.id, x: c.x, y: c.y };
  });
  const at = await client(page, [inst.x, inst.y]);
  await page.mouse.dblclick(at.x, at.y);
  await expect(page.locator('.breadcrumbs')).toContainText('Adder core');
  await expect.poll(() => valueInside(page, [inst.id], 'c3', 'out')).toBe('1');
  await expect.poll(() => valueInside(page, [inst.id], 'c4', 'out')).toBe('0');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('.breadcrumbs')).not.toContainText('Adder core');

  // Undo restores the flat circuit in one step.
  await page.keyboard.press('Control+z');
  await expect(page.locator('.circuit-row', { hasText: 'Adder core' })).toHaveCount(0);
  await expectHalfAdder(page);
});

test('parametric component: bind widths to N, set N per instance, edit the symbol', async ({ page }) => {
  // Definition "Inv": in → NOT → out.
  await page.getByRole('button', { name: 'New circuit' }).click();
  const rename = page.getByLabel('Circuit name');
  await rename.fill('Inv');
  await rename.press('Enter');
  await place(page, 'input', [0, 0], 'in');
  await place(page, 'not', [6, 0]);
  await place(page, 'output', [12, 0], 'out');
  await wire(page, [0, 0], [4, 0]);
  await wire(page, [8, 0], [12, 0]);

  // Add parameter N (default 8) and bind every bit width to it.
  await clickAt(page, [20, 10]);
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(page.locator('.param-editor')).toContainText('');
  await expect(page.locator('tr[data-param="N"]')).toBeVisible();
  for (const at of [
    [-1, 0],
    [6, 0],
    [13, 0],
  ] as const) {
    await clickAt(page, [at[0], at[1]]);
    await page.getByRole('button', { name: 'Bind Bit width to a parameter expression' }).click();
    await setField(page, 'Bit width', 'N');
  }
  await expect(page.getByTestId('problems-toggle')).toHaveText(/0\s*0\s*0/);

  // Main: X (4 bits) → Inv with N = 4 → Y (4 bits).
  await page.locator('.circuit-row', { hasText: 'Main' }).locator('.circuit-open').click();
  await page.locator('.palette-item[aria-label="Component Inv"]').click();
  await clickAt(page, [10, 0]);
  await setField(page, 'N', '4');
  await place(page, 'input', [0, 0], 'X');
  await setField(page, 'Bit width', '4');
  await place(page, 'output', [20, 0], 'Y');
  await setField(page, 'Bit width', '4');
  await wire(page, [0, 0], [6, 0]);
  await wire(page, [14, 0], [20, 0]);
  await expect(page.getByTestId('problems-toggle')).toHaveText(/0\s*0\s*0/);
  // Ids in Main: c1 = instance, c2 = X, c3 = Y.
  await expect.poll(() => bits(page, 'c3', 'in')).toBe('1111');
  await clickAt(page, [-3, 0]);
  await setField(page, 'Set value', '0x5');
  await expect.poll(() => bits(page, 'c3', 'in')).toBe('1010');

  // Move the input port to the top of the symbol: the wire from X follows.
  await page.locator('.circuit-row', { hasText: 'Inv' }).locator('.circuit-open').click();
  await clickAt(page, [20, 10]);
  await page.getByLabel('Side of in').selectOption('top');
  await setField(page, 'Body text', 'INV');
  await page.locator('.circuit-row', { hasText: 'Main' }).locator('.circuit-open').click();
  await expect(page.locator('.notice')).toHaveCount(0);
  await expect.poll(() => bits(page, 'c3', 'in')).toBe('1010');
  await expect(page.getByTestId('problems-toggle')).toHaveText(/0\s*0\s*0/);
});
