import type { OpenFilesPort } from "../../../src/application/ports/discovery.js";
import type { OpenFileIndex } from "../../../src/domain/discovery/facts.js";

/** Scripted OpenFilesPort. `names: null` means lsof is not installed (the check is unavailable). */
export class FakeOpenFiles implements OpenFilesPort {
  snapshots = 0;
  constructor(public names: string[] | null = []) {}
  async snapshot(): Promise<OpenFileIndex> {
    this.snapshots++;
    return this.names === null ? { available: false, names: [] } : { available: true, names: [...this.names] };
  }
}
