# Project file format (`.cfproj`)

Circuit Foundry projects are UTF-8 JSON files, conventionally named `*.cfproj`. The editor writes the same text to browser storage and to exported files, so a file is exactly what the app stores.

Current version: **formatVersion 1**.

## Example

The *Half adder* example, as written by the app:

```json
{
  "format": "circuit-foundry-project",
  "formatVersion": 1,
  "generator": "Circuit Foundry 0.1.0",
  "project": {
    "id": "sample-half-adder",
    "name": "Half adder",
    "mainCircuitId": "half-adder",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "modifiedAt": "2026-01-01T00:00:00.000Z",
    "circuits": [
      {
        "id": "half-adder",
        "name": "Half adder",
        "description": "Adds two bits: S is the sum bit, C the carry.",
        "components": [
          {"id":"c1","type":"input","x":0,"y":0,"rotation":0,"props":{"label":"A","width":1}},
          {"id":"c2","type":"input","x":0,"y":6,"rotation":0,"props":{"label":"B","width":1}},
          {"id":"c3","type":"xor","x":10,"y":2,"rotation":0,"props":{"inputs":2,"label":"","width":1}},
          {"id":"c4","type":"and","x":10,"y":10,"rotation":0,"props":{"inputs":2,"label":"","width":1}},
          {"id":"c5","type":"output","x":18,"y":2,"rotation":0,"props":{"label":"S","width":1}},
          {"id":"c6","type":"output","x":18,"y":10,"rotation":0,"props":{"label":"C","width":1}},
          {"id":"c7","type":"text","x":10,"y":-4,"rotation":0,"props":{"size":"small","text":"S = A XOR B (sum)    C = A AND B (carry)"}}
        ],
        "wires": [
          {"id":"w1","x1":0,"y1":0,"x2":3,"y2":0},
          {"id":"w2","x1":3,"y1":0,"x2":3,"y2":1},
          {"id":"w3","x1":3,"y1":9,"x2":7,"y2":9},
          {"id":"w4","x1":3,"y1":1,"x2":7,"y2":1},
          {"id":"w5","x1":0,"y1":6,"x2":5,"y2":6},
          {"id":"w6","x1":5,"y1":3,"x2":7,"y2":3},
          {"id":"w7","x1":5,"y1":3,"x2":5,"y2":6},
          {"id":"w8","x1":5,"y1":11,"x2":7,"y2":11},
          {"id":"w9","x1":13,"y1":2,"x2":18,"y2":2},
          {"id":"w10","x1":13,"y1":10,"x2":18,"y2":10},
          {"id":"w11","x1":3,"y1":1,"x2":3,"y2":9},
          {"id":"w12","x1":5,"y1":6,"x2":5,"y2":11}
        ]
      }
    ]
  }
}
```

The writer puts one component or wire per line and sorts props by name, so files are compact and produce small, readable diffs under version control. Readers accept any valid JSON layout.

## Structure

### Envelope

| Field | Type | Meaning |
|-------|------|---------|
| `format` | `"circuit-foundry-project"` | Identifies the file type. Required. |
| `formatVersion` | integer ≥ 1 | Version of this specification. Required. |
| `generator` | string | Name and version of the writing application. Informational. |
| `project` | object | The project. |

### Project

| Field | Type | Meaning |
|-------|------|---------|
| `id` | id | Identity of the project; used to recognise the same project when importing. |
| `name` | string | Display name. |
| `mainCircuitId` | id | The circuit simulated when the project opens. Must exist. |
| `createdAt`, `modifiedAt` | ISO-8601 string | Timestamps (may be empty). |
| `circuits` | array of Circuit | At least one. Circuit ids are unique. |

### Circuit

| Field | Type | Meaning |
|-------|------|---------|
| `id` | id | Referenced by subcircuit instances. Stable when the circuit is renamed. |
| `name` | string | Display name. |
| `description` | string, optional | Shown in the inspector and on instances. |
| `components` | array of Component | Ids unique within the circuit. |
| `wires` | array of Wire | Ids unique within the circuit. |

### Component

| Field | Type | Meaning |
|-------|------|---------|
| `id` | id | Unique within the circuit. |
| `type` | string | Catalog type (table below). Unknown types are preserved and reported, never dropped. |
| `x`, `y` | integer | Anchor position in grid units (y grows downward). |
| `rotation` | 0, 90, 180 or 270 | Clockwise rotation from facing east. |
| `props` | object | Values are numbers, strings or booleans. Missing props take their defaults; invalid values are reported and replaced by the default *at use*, while the stored value is kept. Unknown props are preserved. |

An **id** is a non-empty string of letters, digits, `-` and `_`. Component ids form hierarchical simulation keys (`c9/c2/c4`), so they cannot contain `/`.

### Wire

| Field | Type | Meaning |
|-------|------|---------|
| `id` | id | Unique within the circuit. |
| `x1`, `y1`, `x2`, `y2` | integer | Endpoints. A wire must be horizontal or vertical and non-empty. |

## Connectivity rules

Electrical connections come from geometry alone:

1. A wire connects its two endpoints.
2. Wire endpoints and component pins at the same grid point are connected.
3. A wire endpoint or pin lying on the interior of another wire connects to that wire (a T junction).
4. Wires that cross at interior points of both are **not** connected.

The editor keeps wires canonical (overlaps merged, segments split at junctions), but readers must not rely on that: the rules above give the same connectivity for any equivalent set of segments.

## Component types (version 1)

Pin positions are defined by the layout code in `src/model/catalog`. Each type below is listed with its props and defaults.

| `type` | Component | Simulation | Props (default) |
|--------|-----------|------------|-----------------|
| `and`, `or`, `nand`, `nor`, `xor`, `xnor` | Gates | gate | `inputs` 2–16 (2), `width` 1–32 (1), `label` ("") |
| `not`, `buffer` | Inverter, buffer | gate | `width` (1), `label` |
| `tristate` | Tri-state buffer | gate; output Z while `en` = 0 | `width` (1), `label` |
| `input` | Input pin | user-controlled source at top level; port inside a subcircuit | `width` (1), `label` (port name) |
| `output` | Output pin | indicator at top level; port inside a subcircuit | `width` (1), `label` (port name) |
| `button` | Push button | 1-bit source, 1 while pressed | `label` |
| `constant` | Constant | fixed value | `width` (1), `value` unsigned, must fit in `width` (1), `label` |
| `clock` | Clock | low for `lowTicks`, high for `highTicks`, shifted by `phase` | `highTicks` 1–1000 (1), `lowTicks` 1–1000 (1), `phase` 0–1000 (0), `label` |
| `led` | LED | display only | `color` green/red/yellow/blue/white, `label` |
| `probe` | Probe | display only; adopts the width of its net | `radix` hex/bin/dec/sdec (hex), `label` |
| `splitter` | Splitter | bidirectional bit connections | `busWidth` 1–32 (4), `fanout` 1–32 ≤ busWidth (4), `mapping` ("": even split) |
| `dff` | D flip-flop (behavioural) | edge-triggered, powers up 0 | `width` (1), `trigger` rising/falling (rising), `label` |
| `register` | Register (behavioural) | edge-triggered with enable and async clear, powers up 0 | `width` (8), `trigger` (rising), `label` |
| `subcircuit` | Instance of a circuit | expanded in place | `circuit` (id of a circuit in the project), `label` |
| `text` | Text note | none | `text` ("Note"), `size` small/medium/large |

**Splitter mapping:** a comma-separated list giving, for each bus bit starting at bit 0, the arm it belongs to (`"0,0,1,1"`), or `-` to leave the bit unconnected. Each arm carries its bits in ascending order. An empty mapping divides the bits evenly, with arm 0 taking the lowest bits.

**Subcircuit ports:** the ports of a circuit are its `input` and `output` components, each side ordered top to bottom (then left to right) by position. On an instance, a port pin is named by the id of that Input/Output component, which keeps connections stable when a port is relabelled.

## Versioning and compatibility

* Any change that adds or changes stored information increments `formatVersion` and adds a migration from the previous version (`MIGRATIONS` in `src/model/format.ts`).
* Readers migrate older files one version at a time on load. The stored text is only replaced when the project is next saved.
* Readers **refuse** files whose `formatVersion` is newer than they support, with an explanation, instead of loading them partially and losing data on the next save. Browser storage applies the same rule and never overwrites a project saved by a newer version.
* Unknown component types and unknown props are carried through load and save unchanged.
* Validation errors name the exact location, e.g. `Invalid project file at project.circuits[0].wires[3]: a wire must be a non-empty horizontal or vertical segment`.

Simulation state (switch positions, register contents) is not part of the file in version 1; reopening a project starts from power-on state.
