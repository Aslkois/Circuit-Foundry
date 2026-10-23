# Roadmap

Circuit Foundry grows in milestones. Each one ships working, tested features rather than placeholders. The guiding sequence is the one a computer is built in: gates → storage → memory → datapath → control → programs.

## Milestone 1: foundation (done)

* Four-state, event-driven simulation engine with deterministic, order-independent stepping, unit gate delays, contention and floating detection, tri-state buses, bidirectional splitters, clocks, oscillation detection, feedback-loop analysis and state snapshots. Headless and tested.
* Document model with geometric connectivity, wire canonicalization, hierarchical compilation of nested subcircuits with cycle protection, and diagnostics.
* Versioned, documented project format with validation, migrations and preservation of unknown data.
* Interactive editor: palette with drag-and-drop, orthogonal wiring (drag or click-to-route), selection, marquee, move with rubber-band wires, rotate, copy/paste/duplicate, undo/redo, pan/zoom, grid snapping, live signal colours and hover values, inspector with editable properties and live pin values, problems panel, run/pause/tick/step/reset, adjustable tick rate, keyboard shortcuts.
* Custom components: any circuit with labelled pins can be placed in another circuit, nested to any depth, and inspected live from inside an instance.
* Local-first persistence (IndexedDB autosave, project list, file export/import).
* Seven verified examples: gates, half and full adder, 4-bit ripple-carry adder, SR latch, gate-level D flip-flop, 4-bit register, 4 × 4 RAM from gates.
* Unit, model, sample and end-to-end tests; benchmarks; headless command-line runner.

## Hierarchical component system (done)

Custom reusable circuits are a core part of the model, not an add-on (see [components.md](components.md)):

* Create a component from any selection (Ctrl+G): boundary signals become named ports, both sides are rewired cleanly, behaviour is preserved, one undo step.
* Unlimited nesting with cycle protection; instances reference shared definitions and keep independent state (registers, latches, RAM).
* Custom symbols: ports on any side and in any order, clock markers, body width and text, with a live preview.
* Live synchronization: editing a definition updates every instance and re-routes the wires around moved ports, never creating new connections (verified by a fuzz test).
* Parametric components: integer parameters, property bindings with an expression language, per-instance values, parameters passed down through nested components.
* Look inside any instance at any depth with its live values.
* Compilation shares one template per definition and parameter set.
* Import components (with their dependencies) from other projects, examples or files.
* Tunnels (net labels).
* RAM and ROM components with a memory viewer and editor.
* The 8-bit computer example: MyCPU, an accumulator CPU built from gate-level components, running programs from ROM with RAM, a clock and I/O ([mycpu.md](mycpu.md)).
* Project format version 2 (parameters, bindings, symbols) with migration from version 1.

### Known limitations

* Signals are at most 32 bits wide.
* Simulation state is not saved in project files (reopening starts from power-on).
* Parameters change property values, not structure: there is no generate-style replication (an N-bit adder from N full adders must be drawn for a fixed N).
* Components can be rotated but not mirrored.
* Wires are not routed around component bodies (automatic re-routing avoids pins and other wires, not bodies).
* The simulation runs on the main thread (with time budgets).
* Every edit recompiles the edited circuit's connectivity and the flattened design. That is instant for typical designs and about 0.1 s for a flat circuit of 5 000 gates; hierarchical designs only re-analyse the definitions that changed.

## Milestone 2: memory and observation

* ~~RAM and ROM primitives with a memory editor and viewer~~ (done).
* Load and save memory images (raw binary and Intel HEX).
* A state inspector listing every storage element (latch loops, flip-flops, registers, memories) in the design hierarchy.
* Display devices: hex digit, 7-segment display, LED matrix. Input devices: keypad, DIP switches.
* Save optional simulation state with a project.

## Milestone 3: timing and debugging tools

* Waveform viewer and logic analyzer: record chosen nets per gate delay or per clock tick, zoom, cursors, bus decoding.
* Breakpoints on signal conditions; pause when a net changes or matches a value.
* Per-component delay settings in the editor, for timing experiments (race conditions, setup and hold).
* Simulation in a Web Worker for very large designs.
* Incremental connectivity and compilation, so edits to very large flat circuits stay instant.

## Milestone 4: building processors

* ~~Datapath components from gates (multiplexer, decoder, adder, ALU) and an example CPU with a documented instruction set~~ (done: the 8-bit computer).
* More datapath examples: comparators, a register file, a multi-cycle CPU with microcode.
* Assembler integration in the editor: a text editor for programs, assembly against a user-defined instruction set description, loading the result into ROM/RAM. (A code-level assembler for MyCPU exists in `src/samples/mycpu-isa.ts`.)
* Memory-mapped I/O devices (terminal, keyboard, display) and a processor debug view: program counter, registers, disassembly around the PC, single-instruction stepping.

## Milestone 5: scale and polish

* ~~Custom subcircuit appearance~~ and ~~importing circuits from other projects~~ (done).
* Generate-style replication for parametric components (N copies of a sub-block).
* Mirroring, wire auto-routing around bodies, and cleanup tools.
* Shared component libraries that update every project using them.
* Saving directly to the local file system where the browser supports it.
* Light theme, accessibility review, touch input.
