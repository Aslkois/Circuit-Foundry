# Architecture

Circuit Foundry has three layers with one-way dependencies:

```
  editor (React, canvas, browser storage)
     │ uses
  model (documents, catalog, connectivity, compiler, file format)
     │ uses
  engine (four-state values, primitives, event-driven simulator)
```

`src/engine`, `src/model` and `src/samples` compile against `tsconfig.core.json`, which has no DOM or Node type definitions, and ESLint forbids browser and Node globals there. That code runs unchanged in the browser, in Node (`scripts/sim.ts`, `scripts/bench.ts`), in a Web Worker (a later option), and in tests.

## Engine (`src/engine`)

### Values

A signal of width 1–32 bits is a pair of 32-bit words in the Verilog `aval/bval` encoding:

| a | b | meaning |
|---|---|---------|
| 0 | 0 | 0 |
| 1 | 0 | 1 |
| 0 | 1 | Z: floating (nothing drives it) |
| 1 | 1 | X: unknown (conflict, uninitialized state, unknown input) |

All gate functions are branch-free word operations, so a 32-bit AND costs the same as a 1-bit AND. Gates treat floating inputs as unknown, and X is never optimistic: `0 AND X = 0`, `1 AND X = X`, `X XOR anything = X`.

### Netlist

The engine's only input is a flat `Netlist`:

* **nets**: word-level signals with a fixed width;
* **components**: a primitive type, its props, and a net index for each pin;
* **bit links**: joins between single bits of two nets. Splitters compile to bit links; they have no behaviour of their own.

Primitives (`src/engine/primitives`) declare their pins, delay, whether they are sequential, and a `Behavior` factory. Built-in gates also declare a `GateKernel` (operation and negation); the simulator evaluates those inline from flat arrays. The results match the `Behavior` path exactly, and the tests run both.

### Simulation algorithm

`Simulator` is event-driven with integer time in gate delays (each gate defaults to 1). Every step processes all events scheduled for the earliest pending time, in four phases:

1. **apply**: write new driver values from the events;
2. **resolve**: recompute each affected net from all of its drivers. Z yields to a driven value; equal known values agree; otherwise the bit is X and is flagged as contention;
3. **mark**: collect the components that read a changed net;
4. **evaluate**: run each of them once. They read the now-fixed net values and schedule output changes at least one delay ahead.

Because every evaluation in a step sees the same net snapshot and can only affect the future, the result never depends on evaluation order (`tests/engine/simulator.test.ts` checks this by shuffling component order). Each step does bounded, non-recursive work. Driver values are tracked as *projected* values, so an output scheduled to change and then change back within its delay is handled correctly (transport delay).

Consequences that are real hardware behaviour, not artefacts:

* glitches: `A AND NOT A` pulses for one delay when A rises;
* ripple delay: a 4-bit ripple-carry adder needs more time to settle on `15 + 1` than on `0 + 1`;
* oscillation: an SR latch released from S = R = 1 into S = R = 0 at the same instant oscillates in a unit-delay world. The engine reports it rather than hiding it.

### Bit-level links (splitters)

Nets touched by bit links get per-bit *threads* (union-find over `(net, bit)`). A driver change on such a net marks only the threads of the bits that changed, each thread is resolved from every driver bit on it, and the result is written to every `(net, bit)` location. Nets without links stay word-level, which is the fast path. Splitters are therefore bidirectional, so tri-state buses work through them.

### Settling, oscillation and loops

`settle()` runs steps until the queue is empty. If the circuit keeps changing for more than `maxSettleSteps` consecutive steps (default 100 000, counted across calls and reset by external stimulus), it is reported as oscillating, with the components and nets that kept changing, and the simulation pauses. An acyclic circuit always settles within its critical-path depth, so this limit cannot misfire on deep logic. Callers can bound the work per call (`settle({ maxEvents })`). The editor uses this to keep settling across animation frames instead of freezing on a huge design.

`findFeedbackLoops()` finds strongly connected components of the combinational dependency graph (sequential primitives break edges). Loops are reported as notes, not errors: an SR latch *is* a loop.

### Clocks and time

Propagation time (gate delays) and clock time (ticks) are separate. `tick()` advances every clock by one tick and the caller settles. A clock with `highTicks = lowTicks = 1` has a period of two ticks. Edge-triggered primitives sample their inputs at the instant they see the clock edge, so chains of flip-flops on one clock never race. Unknown clock transitions are handled pessimistically.

### State snapshots

`exportState()` captures behaviour state (switch values, register contents) and driver values, keyed by stable component keys. `importState()` restores them into a simulator built from a different netlist. The editor uses this to keep state across every edit: component keys are hierarchical instance paths, so an unchanged latch keeps its stored bit even though its state lives in the feedback loop's nets, not in any primitive.

## Model (`src/model`)

### Documents

A `Project` holds named `Circuit`s. A circuit has components (type, integer grid position, rotation, props) and wires (axis-aligned segments). Documents are immutable: every edit returns a new object and shares unchanged parts. That keeps undo/redo snapshots cheap and lets caches key on object identity.

### Catalog

`src/model/catalog` describes each component type: palette metadata, props with validation, pin geometry for given props (local coordinates facing east, rotated by multiples of 90°), and its *simulation role*:

| role | meaning |
|------|---------|
| `primitive` | maps to an engine primitive; pins are matched by name |
| `inputPort` / `outputPort` | Input and Output pins: a user-controlled source and an indicator at top level, ports inside a subcircuit |
| `splitter` | compiles to bit links |
| `subcircuit` | an instance of another circuit in the project |
| `passive` | display only (LED, probe, text) |

### Connectivity

`analyzeConnectivity()` turns geometry into nets with union-find over grid points:

* a wire connects its endpoints;
* wire ends and pins at the same point connect;
* a wire end or pin on the interior of another wire connects to it (T junction, drawn with a dot);
* wires that cross at interior points do **not** connect.

Net width comes from the pins on the net; probes adapt to it. Disagreeing widths are reported, and those pins are isolated so the rest of the design still simulates.

After every edit, `normalizeWires()` rewrites wires into a canonical form: collinear overlaps merged, segments split at junctions, explicit four-way junctions preserved. Connectivity is unchanged by construction; a randomized test checks this over hundreds of generated layouts.

### Hierarchy and compilation

`compileProject(project, rootId)` flattens the hierarchy into one engine netlist. Each subcircuit instance is expanded in place, and the nets on an instance's ports are *merged* with the nets of the Input/Output pins inside. Ports therefore add no delay and pass signals in both directions, and every instance has its own state. Engine keys are instance paths (`c9/c2/c4`), and the compiled `InstanceNode` tree maps every instance's local nets to flat nets, so the editor can show live values inside any instance.

Cycles are rejected at three levels: the editor will not place a circuit inside itself (`wouldCreateCycle`), the compiler skips cyclic instances and reports them, and nesting depth is capped.

### Diagnostics

Compilation reports unknown component types (preserved in the file, not simulated), invalid props, width conflicts, missing or recursive subcircuits, duplicate port labels and multiple non-tri-state drivers on one wire. At run time the editor adds oscillation and feedback-loop notes, mapped back to the circuit and components involved.

### File format

See [project-format.md](project-format.md). Parsing validates everything and reports the failing path. Older versions are migrated step by step; newer versions are refused rather than silently losing data; unknown component types and props are preserved.

## Editor (`src/editor`)

```
EditorStore ──notify──► SimulationHost.sync() ─► compile + Simulator (+ state carry-over)
     │                         │
     ├──► React panels         ├──► status (throttled) ─► toolbar / status bar / inspector
     └──► CanvasController ◄───┘ valueVersion polled each animation frame
              │
              └─► Renderer (Canvas 2D, draws only when something changed)
```

* **`EditorStore`** (`state/store.ts`) holds the project, the simulated root circuit and the instance path being viewed, the selection, the active tool and the undo/redo history (project snapshots).
* **`SimulationHost`** (`sim/SimulationHost.ts`) recompiles synchronously on every project change, carries simulator state across recompiles and across switches between circuits, settles in budgeted chunks, and runs clocks on animation frames with a fixed time budget. It never re-renders React per tick; status is throttled.
* **`CanvasController`** (`canvas/controller.ts`) is the pointer and keyboard state machine: select and move (with rubber-band rerouting of attached wires), marquee, wire drawing (drag or click-to-route), placement, poking inputs, pan and zoom. It turns gestures into pure model edits (`model/edit.ts`) committed to the store.
* **`Renderer`** (`canvas/renderer.ts`, `symbols.ts`) draws the grid, wires batched by colour, junctions, component symbols and overlays with Canvas 2D in world units; text is drawn in screen space so it stays crisp. The palette icons use the same symbol code.
* **Persistence** (`state/persistence.ts`, `bootstrap.ts`) autosaves to IndexedDB using the same serialized text as exported files, so storage and files share one format and one validator. It falls back to memory, with a visible warning, when storage is unavailable.

`window.circuitFoundry` exposes the store, host and storage for debugging and for the end-to-end tests.

## Testing

| Suite | What it covers |
|-------|----------------|
| `tests/engine` | value encoding, parsing and formatting; every gate against a scalar four-state reference model on every input combination (through both the kernel and behaviour paths); timing; glitches; order independence; contention; tri-state buses; floating inputs; oscillation; feedback analysis; gate-level latches and flip-flops; splitters; snapshots; budgeted settling; netlist validation |
| `tests/model` | connectivity rules; wire canonicalization (including randomized connectivity invariance); compilation of nested subcircuits, per-instance state, tri-state across boundaries, splitters, recursion, width conflicts; file format round trips, migrations, readable errors, preservation of unknown data; edit operations |
| `tests/samples` | every example compiles cleanly and round-trips; truth tables and sequential behaviour of each |
| `tests/e2e` | in Chromium: build a half adder with the mouse and verify all four input combinations; reload; export and import into a fresh profile; undo/redo, rotate and delete; examples, looking inside an instance, running a clock; oscillation reporting; creating and reusing a custom component; drag-and-drop from the palette |

## Performance

`npm run bench` builds large designs and checks their results while timing them. A typical run on Node 22 (one core of a cloud VM):

| Case | Size | Result |
|------|------|--------|
| 32-bit ripple-carry adder from gates | 163 primitives | ≈ 56 000 additions/s |
| Shift register of flip-flop primitives | 10 000 flip-flops | ≈ 25 M evaluations/s |
| Deep random logic with heavy glitching | 100 000 gates | ≈ 5 M events/s, ≈ 9 M evaluations/s |
| Gate-level 4×4 RAM example | 258 primitives | ≈ 19 000 write+read cycles/s |
| Compile a 1 537-instance hierarchy | 2 560 primitives | ≈ 40 ms |

The editor shows compile time, design size and, while running, ticks and events per second in the status bar.

## Extending

* **A new primitive:** implement `PrimitiveSpec` in `src/engine/primitives`, register it in `primitives/index.ts`, and add engine tests.
* **A new component type:** add a `ComponentTypeDef` in `src/model/catalog` (props, pin layout, simulation role) and a drawing function in `src/editor/canvas/symbols.ts`. Palette, inspector, persistence and compilation pick it up automatically.
* **Waveforms and logic analyzers:** `Simulator.step()` exposes per-step changes through `valueVersion`. A trace hook recording selected nets per time step slots in next to the existing oscillation sampler.
* **Running in a worker:** `SimulationHost` is the only place that touches `Simulator`; it can be moved behind a message channel without changing the engine or the model.
