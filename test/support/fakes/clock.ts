import type { Clock, IdSource } from "../../../src/application/ports/common.js";

export class FakeClock implements Clock {
  constructor(public ms = Date.UTC(2026, 0, 1)) {}
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Deterministic ids: hex counters, so tests can predict plan ids and nonces. */
export class FakeIds implements IdSource {
  private n = 0;
  hex(bytes: number): string {
    return (++this.n).toString(16).padStart(bytes * 2, "0");
  }
}
