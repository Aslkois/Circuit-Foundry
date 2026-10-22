# Circuit Foundry

A local-first digital logic and computer-architecture simulator. You build circuits from individual gates, wire them on a schematic canvas, turn them into reusable components, and nest them: NAND gates → latch → flip-flop → register → RAM → (eventually) a CPU.

Everything runs in the browser. There is no backend, account or hosted service: projects are stored in the browser's own storage and can be exported as portable, versioned JSON files.

> **Status: milestone 1 complete.** The editor, the simulation engine, custom components, saving/loading and seven verified example circuits work today. See [docs/roadmap.md](docs/roadmap.md) for what comes next.

## Quick start

Requirements: Node.js 20.19+ (22 LTS recommended) and npm.

```sh
npm install
npm run dev          # start the editor at http://localhost:5173
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Type-check and produce a static build in `dist/` (open it with `npm run preview`, or serve the folder from any static host) |
| `npm test` | Unit, model and sample-circuit tests (Vitest) |
| `npm run test:e2e` | End-to-end tests in Chromium (Playwright; builds and serves the app itself) |
| `npm run check` | Type-check, lint and unit tests together |
| `npm run sim -- --sample ripple-adder --set A=9 --set B=7` | Simulate a project headlessly from the command line ([details](#command-line)) |
| `npm run bench` | Engine performance benchmarks |

The end-to-end tests need a Playwright Chromium build. If you do not have one, run `npx playwright install chromium` once.

## Using the editor

* **Place components:** click one in the palette, then click on the canvas, or drag it onto the canvas. `R` rotates it before or after placing.
* **Wire:** drag from any pin or wire end. Wires snap to the grid and bend at right angles. A wire ending on another wire joins it (a dot marks the junction); wires that only cross are not connected. With the wire tool (`W`) you can also click from point to point.
* **Change inputs:** click the bits of an Input pin. Push buttons are 1 while held.
* **Read signals:** wire colours show values: bright green 1, dark green 0, blue unknown (X), grey floating (Z), red conflicting drivers, amber multi-bit buses. Hover a wire for its value in binary, hex and decimal; select a component to see all of its pin values in the inspector.
* **Build components:** add a circuit in the *Circuits* list, give it labelled Input and Output pins, then drag it from the list into another circuit. Double-click an instance to look inside it with live values. The editor refuses to place a circuit inside itself, directly or indirectly.
* **Clocks:** *Run* advances clocks at the chosen tick rate; *Tick* advances one tick. Turn off *Auto-propagate* to step through gate delays one at a time with *Step*.
* **Save:** projects save automatically in this browser. Use *Projects* to switch between projects or open an example, and the export/import buttons to move projects as files.

Press `?` in the app for the complete list of keyboard shortcuts.

## Examples

Open them from *Projects → Examples*. Each one is an ordinary editable project, and each is verified by the test suite:

1. **Basic logic gates**: all seven gates side by side (truth tables).
2. **Half adder** and **half and full adder**: the full adder is built from two half-adder subcircuits (truth tables).
3. **Four-bit ripple-carry adder**: four full adders, 4-bit buses and splitters (all 512 input combinations).
4. **SR latch**: two cross-coupled NOR gates (set, reset, hold, and oscillation from the forbidden state).
5. **D flip-flop**: master-slave, from NAND-gate D latches, plus a clocked demo (edge behaviour).
6. **Four-bit register**: gate-level register bits with load enable (every value stored and held).
7. **Small RAM from gates**: 4 × 4 bits, with a 2-to-4 decoder, write-enable gating, gate-level registers and a tri-state read bus (independent write and read-back of every address).

The register and flip-flop *primitives* in the palette are optimized behavioural models and are labelled as such. The examples above use only gates.

## Command line

The engine and document model are plain TypeScript with no DOM dependency, so projects simulate in Node without a browser:

```sh
npm run sim -- --list                                   # list built-in examples
npm run sim -- --sample half-adder --table              # exhaustive truth table
npm run sim -- my-project.cfproj --circuit "ALU" --set A=0x3 --set B=5
npm run sim -- --sample d-flip-flop --circuit dff-demo --set D=1 --ticks 2
```

## Project structure

```
src/engine/    Simulation engine: four-state values, primitives, event-driven simulator (no DOM, no Node APIs)
src/model/     Documents, component catalog, connectivity, hierarchy flattening, file format (no DOM)
src/samples/   Example projects, built in code and verified by tests
src/editor/    React UI, canvas renderer and interaction, simulation host, browser storage
scripts/       Headless runner and benchmarks (run directly with Node)
tests/         engine/, model/, samples/ (Vitest) and e2e/ (Playwright)
docs/          Architecture, project file format, roadmap
```

* [docs/architecture.md](docs/architecture.md): how the layers fit together, the timing model, and how to extend the system.
* [docs/project-format.md](docs/project-format.md): the `.cfproj` file format, versioning and compatibility rules.
* [docs/roadmap.md](docs/roadmap.md): milestones.

## License

Public domain ([Unlicense](LICENSE)).
