/** Raised when another disk-janitor operation holds the apply lock. */
export class LockHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockHeldError";
  }
}
