import { confirmationMatches, type HumanSession } from "../domain/policy/human.js";

/** The terminal as seen by use cases that need a human: session facts plus prompting and output. */
export interface HumanIO extends HumanSession {
  /** Print a line of already-escaped text. */
  write(text: string): void;
  /** Prompt and read one line. */
  ask(question: string): Promise<string>;
}

/**
 * Ask the human to type `expected` back exactly. The prompt deliberately does not contain the
 * expected value: the human has to read it somewhere else first (`explain`, `purge --dry-run`), so
 * a script cannot simply echo what it is shown. `where` says where to find it. Anything else cancels.
 */
export async function confirmByTyping(io: HumanIO, expected: string, prompt: string): Promise<boolean> {
  const answer = await io.ask(`${prompt}, anything else cancels: `);
  return confirmationMatches(expected, answer);
}
