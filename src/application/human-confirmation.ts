import { escapeText } from "../domain/shared/escape.js";
import { confirmationMatches, type HumanSession } from "../domain/policy/human.js";

/** The terminal as seen by use cases that need a human: session facts plus prompting and output. */
export interface HumanIO extends HumanSession {
  /** Print a line of already-escaped text. */
  write(text: string): void;
  /** Prompt and read one line. */
  ask(question: string): Promise<string>;
}

/** Ask the human to type `expected` back exactly. Anything else cancels. */
export async function confirmByTyping(io: HumanIO, expected: string, action: string): Promise<boolean> {
  const answer = await io.ask(`Type ${escapeText(expected)} to ${action}, anything else cancels: `);
  return confirmationMatches(expected, answer);
}
