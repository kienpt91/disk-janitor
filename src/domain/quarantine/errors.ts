/** Raised when a Manifest is invalid, tampered with, or asked to do something it forbids. */
export class QuarantineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuarantineError";
  }
}

/** A Manifest entry was asked to change status along an edge the lifecycle does not have. */
export class IllegalTransitionError extends QuarantineError {
  constructor(
    readonly stored: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`entry ${stored} cannot go from ${from} to ${to}`);
    this.name = "IllegalTransitionError";
  }
}
