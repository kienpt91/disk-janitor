import type { Config } from "../../domain/model/config.js";
import type { OpenFileIndex } from "../../domain/discovery/facts.js";
import type { Findings } from "../../domain/discovery/findings.js";
import type { Clock, FileSystem } from "../ports/common.js";
import type { DockerPort, GitPort, OpenFilesPort } from "../ports/discovery.js";

export interface DiscoveryPorts {
  fs: FileSystem;
  git: GitPort;
  openFiles: OpenFilesPort;
  docker: DockerPort;
  clock: Clock;
}

/** State of one discovery run, shared by the detectors. */
export interface DiscoveryRun {
  ports: DiscoveryPorts;
  config: Config;
  open: OpenFileIndex;
  /** Canonical home directories used by the protected-path rules. */
  homes: readonly string[];
  findings: Findings;
}
