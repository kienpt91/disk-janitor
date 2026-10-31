import { randomBytes } from "node:crypto";
import type { IdSource } from "../application/ports/common.js";

/** IdSource adapter over the operating system's CSPRNG. */
export const cryptoIds: IdSource = {
  hex: (bytes) => randomBytes(bytes).toString("hex"),
};
