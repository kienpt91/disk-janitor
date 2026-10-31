import type { Manifest } from "../../domain/quarantine/manifest.js";

/**
 * Where quarantined items and their sealed Manifests live. On disk the layout is
 * `<root>/<planId>/manifest.json` and `<root>/<planId>/items/NNNN`; use cases never build those
 * paths themselves. Moving items in and out is done through the FileSystem port (rename), so the
 * use cases see exactly the file system the rest of the Apply sees.
 */
export interface QuarantineStore {
  /** The directory holding one sub-directory per applied Plan. */
  readonly rootDir: string;
  /** `<root>/<planId>`. Throws QuarantineError for an id that is not a plan id. */
  planDir(planId: string): string;
  /** `<root>/<planId>/items`. */
  itemsDir(planId: string): string;
  /** `<root>/<planId>/items/<stored>`. Throws QuarantineError for a stored name that is not NNNN. */
  itemPath(planId: string, stored: string): string;
  /** Create the plan directory and its items directory (private, not recursive). Rejects when the plan directory exists. */
  create(planId: string): Promise<void>;
  /** Best effort: remove the (empty) items and plan directories of a Plan that was never applied. */
  discard(planId: string): Promise<void>;
  /** Names of the entries directly inside the root (empty when the root is missing); not filtered. */
  planIds(): Promise<string[]>;
  /** The authenticated Manifest of a Plan; null when it has none. Throws QuarantineError when it is not trustworthy. */
  load(planId: string): Promise<Manifest | null>;
  /** Seal and atomically store a Manifest, replacing the previous one. */
  save(manifest: Manifest): Promise<void>;
  /** Permanently delete one stored item (a symlink in its place is removed, never followed). Rejects on failure. */
  removeItem(planId: string, stored: string): Promise<void>;
}
