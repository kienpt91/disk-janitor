import { openState, type State } from "../../src/infrastructure/state/state-dir.js";
import { makeSandbox, type Sandbox } from "./helpers.js";

export interface SandboxState {
  sb: Sandbox;
  state: State;
}

/** A real state directory (mode 0700, subdirectories created) inside a throwaway temp sandbox. */
export async function openSandboxState(name = "state"): Promise<SandboxState> {
  const sb = makeSandbox();
  const state = await openState(name === "state" ? sb.state : `${sb.base}/${name}`, [sb.projects]);
  return { sb, state };
}
