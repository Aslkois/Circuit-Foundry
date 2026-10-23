import { useSyncExternalStore } from 'react';

/** A tiny observable value for transient view state (zoom, pointer, hover). */
export class Observable<T> {
  private value: T;
  private readonly listeners = new Set<() => void>();

  constructor(value: T) {
    this.value = value;
  }

  get = (): T => this.value;

  set(value: T): void {
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const fn of this.listeners) fn();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

export function useObservable<T>(o: Observable<T>): T {
  return useSyncExternalStore(o.subscribe, o.get);
}
