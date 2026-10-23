# MyCPU and the 8-bit computer

*Projects → Examples → 8-bit computer* opens a complete computer: **MyCPU**, an 8-bit CPU built from the project's own components, placed next to a program ROM, a data RAM, a clock, eight input switches and an output register. Everything inside MyCPU is simulated: the adders are made of gates, the control unit is gates, and the registers are register components.

Press **Run** (or **T** to advance one tick). The program in ROM prints Fibonacci numbers on `OUT` (0, 1, 1, 2, … 144) and halts. Double-click the CPU to look inside it, and keep going down to the gates; every level shows that instance's live values.

## Component hierarchy

| Component | Built from | Purpose |
|-----------|-----------|---------|
| Half adder | XOR, AND | 1-bit add |
| Full adder | 2 half adders, OR | 1-bit add with carry |
| Adder (8-bit) | 8 full adders | ripple-carry `S = A + B + Cin` |
| Decoder 3→8 | NOT and 3-input AND gates | one-hot select |
| Mux 2:1 | 2 tri-state buffers, NOT; parameter **N** (bus width) | `Y = S ? B : A` |
| ALU (8-bit) | adder, decoder, a mux (N = 8), gates, tri-state result bus | 8 operations, Z and C flags |
| Control unit | NOT, AND, OR gates | opcode decoding and jump conditions |
| **MyCPU** | control unit, ALU, 2 muxes, an adder as PC incrementer, registers | the CPU |
| 8-bit computer | MyCPU, ROM, RAM, clock, input pins, a register, gates | the machine |

The computer contains 59 component instances from 9 definitions; the adder definition alone is used twice (ALU and program counter), each use with its own 8 full adders and 16 half adders.

## Architecture

* **Registers:** accumulator `A` (8 bits), flags `Z` and `C`, program counter `PC` (8 bits). All power up as 0; `RST` clears them.
* **Harvard memory:** instructions come from a 256 × 16-bit ROM addressed by the PC; data lives in a separate address space.
* **One instruction per clock cycle.** During the low half of the clock the instruction, operand and ALU result settle; on the rising edge the accumulator, flags and PC load, and a store writes RAM or the output register.
* **Data address space:** `0x00–0x7F` RAM (128 bytes), `0x80–0xFF` I/O. Reading I/O returns the `IN` switches, writing I/O loads the `OUT` register.

CPU ports: `CLK`, `RST`, `INSTR[16]` (from ROM), `DIN[8]` (data in) → `PC[8]` (to ROM), `ADDR[8]`, `DOUT[8]`, `WE` (data memory), and `A[8]`, `HALT` for observation.

## Instruction set

Each instruction is one 16-bit word:

```
bit   15..12   11       10    9..8     7..0
      opcode   I / C1   C0    unused   operand
```

* bits 15–12: opcode;
* bit 11: **I**, immediate operand (ALU instructions);
* bits 11–10: condition (jumps): `00` always, `01` zero, `10` carry, `11` not zero;
* bits 7–0: operand, an immediate value or a data address.

| Opcode | Mnemonic | Effect |
|--------|----------|--------|
| `0x0` | `NOP` | nothing |
| `0x1` | `HLT` | stop: the PC holds |
| `0x2` | `ST addr` | `MEM[addr] = A` |
| `0x3` | `JMP`, `JZ`, `JC`, `JNZ addr` | `PC = addr` if the condition holds |
| `0x8` | `LD addr` / `LDI imm` | `A = x` |
| `0x9` | `ADD` / `ADDI` | `A = A + x` |
| `0xA` | `SUB` / `SUBI` | `A = A − x` |
| `0xB` | `AND` / `ANDI` | `A = A & x` |
| `0xC` | `OR` / `ORI` | `A = A \| x` |
| `0xD` | `XOR` / `XORI` | `A = A ^ x` |
| `0xE` | `NOT` | `A = ~A` |
| `0xF` | `SHR` | `A = A >> 1` |

For ALU instructions, `x` is `MEM[addr]`, or the operand itself when the I bit is set (the `…I` forms). Every ALU instruction sets **Z** when the result is 0. `ADD` and `SUB` set **C** to the adder's carry out (for `SUB`, C = 1 means no borrow, i.e. A ≥ x); the other ALU instructions clear it. `ST` and jumps leave the flags alone.

The low three opcode bits of an ALU instruction select the ALU operation directly: `000` B, `001` A + B, `010` A − B (A + ~B + 1), `011` AND, `100` OR, `101` XOR, `110` NOT A, `111` A >> 1.

## Programs

`src/samples/mycpu-isa.ts` contains an assembler, a reference emulator and two programs. Assembly syntax: `label:`, `name = value` for constants, one instruction per line, `;` comments, numbers in decimal, `0x` hex or `0b` binary.

```asm
; Fibonacci numbers on the output port (address 0x80).
x   = 0x00
y   = 0x01
t   = 0x02
OUT = 0x80

        LDI 0
        ST  x
        LDI 1
        ST  y
loop:   LD  x
        ST  OUT        ; show x
        ADD y          ; A = x + y, C = 1 on overflow
        JC  done
        ST  t
        LD  y
        ST  x          ; x = y
        LD  t
        ST  y          ; y = x + y
        JMP loop
done:   HLT
```

To run another program in the editor, select the ROM and edit its contents (hex words from address 0, e.g. `8800 2080 1000` for `LDI 0`, `ST 0x80`, `HLT`). Programs can also be assembled in code and loaded with `computerProject(assemble(source).words)`.

## Verification

`tests/samples/computer.test.ts` checks:

* the 8-bit adder on random operands and carries;
* the decoder and the multiplexer;
* all eight ALU operations with their Z and C flags on edge cases and random operands;
* the control unit for every opcode × condition × flag combination;
* whole programs on the gate-level computer against the reference emulator: output values, cycle counts and the accumulator for Fibonacci, sum-to-N with input from the switches (several N), and a program that exercises every instruction, addressing mode and jump condition;
* the hierarchy (59 instances, 9 shared templates, gate counts, 6-level-deep engine keys), save and load, loading a new program, and that changing the half adder definition changes the behaviour of every adder inside the CPU.

`tests/e2e/components.spec.ts` runs the example from the toolbar until it halts, checks `OUT`, and opens the CPU down to a full adder to read live values there. `npm run bench` measures about 33 000 instructions per second for the gate-level computer in Node.
