# Hierarchical components

Every circuit in a project is also a component. Its labelled Input and Output pins are its ports, and it can be placed inside any other circuit that it does not itself contain. Components nest to any depth: the 8-bit computer example goes computer → MyCPU → ALU → 8-bit adder → full adder → half adder → gates.

Build once, reuse everywhere: an instance is a reference to the definition, not a copy. Edit the definition and every instance changes, while each instance keeps its own state.

## Making a component

There are three ways:

* **From a selection.** Select part of a circuit and press **Ctrl+G** (or *Create component…* in the inspector). The dialog lists the ports the component will get before anything changes. The selection moves into a new circuit and one instance takes its place:
  * every signal that crosses the edge of the selection becomes a port, named after an Input/Output pin or tunnel on that net where there is one, or after a labelled port inside (`FA0.Cout`), else `in0`, `out0`, …;
  * Input and Output pins inside the selection stay ports with their labels, and are put back outside on the new instance so the circuit keeps its inputs and outputs;
  * both sides are rewired automatically: dead-end wire stubs are removed and each net is reconnected with a clean route (one that touches nothing else), joining several branches with a single spine. Only when no clean route exists is a pair of tunnels used instead, and the result says so.

  The circuit behaves exactly as before, and the whole operation is one undo step.
* **From a new circuit.** Add a circuit in the *Circuits* list and give it labelled Input and Output pins.
* **From another project.** The import button in the *Circuits* header copies components from another project in this browser, from an example, or from a project file, together with everything they contain. Ids and names that clash are renamed; components that are already present unchanged (for example from an earlier import) are reused rather than duplicated.

Place components from the palette's *This project* group (drawn with their real symbols) or by dragging a circuit from the *Circuits* list. A circuit that contains the one you are editing is not offered, because placing it would make a circuit contain itself.

## The interface: symbol and ports

Select nothing (click empty canvas) while viewing a circuit to see its *Symbol* in the inspector, with a live preview:

* **Side and order** of each port: left, right, top or bottom, and its position along that side.
* **Clock marker** (`>`): on by default for ports labelled `CLK` or `CLOCK`.
* **Body text** and **body width**.

Ports can be single bits or buses up to 32 bits wide (the width of the Input/Output pin), and can be data, clocks, enables or any other control signal; the symbol is purely how they are arranged.

### Live synchronization

Changing a definition's interface (adding or removing ports, relabelling them, moving them on the symbol, resizing the body, or a parameter that changes widths) updates every instance immediately. Wires connected to ports that move are re-routed to the new pin positions in the same undo step:

* a re-route only uses clean paths, which may cross other wires at right angles but never run along one, bend on one, or touch another pin or wire end;
* if a moved pin would land on a wire of another net, that wire is detoured around it;
* routes are retried in a different order when they block each other (for example two ports swapping places);
* a final check guarantees that no two previously separate nets end up connected. If re-routing ever could not keep them apart, the moved ports are left unconnected instead.

Connections that cannot be kept (a port that was removed, or no clean route) are left unconnected and listed in a notice; nothing is silently joined.

## Parameters

A circuit can declare integer parameters (inspector → *Parameters*), each with a default and a range. Then:

* inside the circuit, the **ƒ** button next to a numeric property binds it to an expression such as `N`, `N*2 - 1` or `clog2(DEPTH)`. Expressions support `+ - * / %`, parentheses, and the functions `min`, `max`, `clog2` and `pow2`;
* every instance shows the parameters in its inspector; leave a field empty for the default;
* inside another parametric circuit, an instance's parameter can itself be bound (`N` of an inner multiplexer = `M*2` of the outer component), so sizes flow down the hierarchy.

The definition is drawn and stored with the default values. Looking inside an instance shows it with that instance's values. Renaming a parameter updates every binding in the circuit and every instance's value; removing one drops the instance values and reports bindings that still use it.

Example: *Mux 2:1* in the 8-bit computer has `N` (default 8). It is used at N = 8 for data selection; place another one and set N = 16 to get a 16-bit multiplexer from the same definition.

Bindings change property values, not structure: a parameter can set bit widths, constant values and other props, but it cannot add or remove components. A binding that changes the position of pins (such as the number of gate inputs) can leave wires that no longer meet those pins; the width checks and diagnostics report such problems.

## Looking inside

Double-click an instance (or *Look inside* in its inspector) to open it with the live values of *that* instance. The breadcrumb bar shows the path (`8-bit computer › CPU › ALU › ADDER › FA0`); Esc goes back up. You can watch any signal at any depth in the Watch panel. Editing while inside an instance edits the shared definition, which the editor states in the breadcrumb bar.

## State and dependencies

* Every instance gets its own registers, flip-flops, latches and RAM contents. Two instances of the same RAM-based component store different data.
* A circuit may not contain itself, directly or through other components: the editor refuses such placements, the compiler skips and reports cyclic instances, and nesting depth is capped at 64.
* Feedback inside a circuit (latches, cross-coupled gates) and feedback between instances through wires are both fine: only the *containment* relation must be acyclic.

## How it is simulated

Compilation flattens the hierarchy into one netlist for the engine, sharing as much work as possible:

* each definition is analysed once per distinct set of parameter values into a *template* (its primitives, nets and child instances in local numbering), cached on the definition;
* instantiating a template only offsets net numbers, so a design with 64 MyCPU instances (3 649 instances, 9 088 primitives) compiles in about 30 ms from 9 shared templates;
* ports merge the inner and outer nets instead of adding buffers, so crossing a boundary costs no delay and tri-state buses work across it;
* engine component keys are instance paths (`c3/c12/c4`), which is what keeps each instance's state separate and lets the editor keep state across edits.

See [architecture.md](architecture.md) for details and [mycpu.md](mycpu.md) for the CPU example.
