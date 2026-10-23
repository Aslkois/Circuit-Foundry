import type { Point } from './types.ts';

export type Severity = 'error' | 'warning' | 'info';

export type DiagnosticCode =
  | 'unknown-type'
  | 'invalid-props'
  | 'width-conflict'
  | 'missing-circuit'
  | 'recursive-subcircuit'
  | 'duplicate-port'
  | 'multiple-drivers'
  | 'missing-root'
  | 'feedback-loop'
  | 'oscillation'
  | 'contention'
  | 'netlist'
  | 'binding';

export interface Diagnostic {
  readonly severity: Severity;
  readonly code: DiagnosticCode;
  readonly message: string;
  /** Circuit definition the problem is in. */
  readonly circuitId: string;
  readonly componentIds?: readonly string[];
  readonly wireIds?: readonly string[];
  readonly points?: readonly Point[];
}

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function sortDiagnostics(list: Diagnostic[]): Diagnostic[] {
  return list.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
