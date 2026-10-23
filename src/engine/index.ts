/**
 * Circuit Foundry simulation engine.
 *
 * Pure TypeScript with no DOM or Node dependencies: it runs in the browser,
 * in a worker, in Node, or in tests. It knows nothing about geometry or the
 * editor; its input is a flat Netlist.
 */
export * from './logic.ts';
export * from './netlist.ts';
export * from './primitives/index.ts';
export * from './simulator.ts';
export { findFeedbackLoops } from './analysis.ts';
