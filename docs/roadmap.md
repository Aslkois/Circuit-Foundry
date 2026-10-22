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

### Known limitations

* Signals are at most 32 bits wide.
* Simulation state is not saved in project files (reopening starts from power-on).
* Subcircuit symbols have a fixed appearance (inputs left, outputs right).
* Components can be rotated but not mirrored.
* Wires do not route around components automatically.
* The simulation runs on the main thread (with time budgets).
* Every edit recompiles the edited circuit's connectivity and the flattened design. That is instant for typical designs and about 0.1 s for a flat circuit of 5 000 gates; hierarchical designs only recompute the circuit that changed.

## Milestone 2: memory and observation

* RAM and ROM primitives (configurable address and data width, separate or shared data bus), clearly marked as behavioural models, with a hex memory editor and live memory viewer that highlights the last accessed address.
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

* Datapath library examples built from gates: multiplexers, decoders, comparators, an ALU, a register file, a program counter.
* An example CPU built entirely from the project's own components, with a documented instruction set.
* Assembler integration: a text editor for programs, assembly against a user-defined instruction set description, loading the result into ROM/RAM.
* Memory-mapped I/O devices (terminal, keyboard, display) and a processor debug view: program counter, registers, disassembly around the PC, single-instruction stepping.

## Milestone 5: scale and polish

* Custom subcircuit appearance (port placement, shape, labels).
* Mirroring, wire auto-routing and cleanup tools.
* Component libraries shared between projects; import circuits from other projects.
* Saving directly to the local file system where the browser supports it.
* Light theme, accessibility review, touch input.
