import { assertHumanSession, confirmationMatches } from "../domain/policy/human.js";
import type { Plan } from "../domain/model/types.js";
import type { HumanIO } from "./human-confirmation.js";

export type ApprovalDecision = "approved" | "declined";

/**
 * Whoever decides whether a plan may be applied. Implementations: a terminal prompt (the default),
 * or an OS-level dialog (best effort). The use case does not care which; it records the kind in the
 * audit log.
 */
export interface Approver {
  readonly kind: "terminal" | "os-dialog";
  /** Cheap checks that must pass before anything else happens (throws when this approver cannot run here). */
  preflight?(): void;
  decide(plan: Plan, validityMs: number): Promise<ApprovalDecision>;
}

/** What the terminal approver shows. Presentation lives outside the application layer. */
export interface ApprovalView {
  /** Plan id, totals, roots, validity and warnings. It must not contain the plan digest. */
  header(plan: Plan, validityMs: number): string[];
  /** One line per candidate: ALL of them, never a truncated list. */
  candidates(plan: Plan): string[];
}

export const APPROVAL_PAGE_SIZE = 20;

/**
 * The terminal approver: requires a human session (TTY on stdin and stdout, no agent marker), shows
 * the header and every candidate (paged), then requires the FULL plan digest, which this screen does
 * not print: the human reads it from `disk-janitor explain`. This stops accidental and
 * non-interactive runs. It is not a security boundary against a same-user process that can drive a
 * pty and run `explain` itself (see SECURITY.md).
 */
export function terminalApprover(io: HumanIO, view: ApprovalView, pageSize = APPROVAL_PAGE_SIZE): Approver {
  return {
    kind: "terminal",
    preflight() {
      assertHumanSession(io, "approve");
    },
    async decide(plan, validityMs) {
      assertHumanSession(io, "approve");
      for (const line of view.header(plan, validityMs)) io.write(line);
      const lines = view.candidates(plan);
      for (let i = 0; i < lines.length; i += pageSize) {
        for (const line of lines.slice(i, i + pageSize)) io.write(line);
        const shown = Math.min(i + pageSize, lines.length);
        if (shown < lines.length) {
          const answer = await io.ask(`-- ${shown} of ${lines.length} candidates shown; Enter for the next page, q to cancel -- `);
          if (answer.trim().toLowerCase() === "q") return "declined";
        }
      }
      io.write("");
      const typed = await io.ask(
        "Type the full plan digest to approve. It is not shown on this screen: copy it from `disk-janitor explain <plan id>`. Anything else cancels: ",
      );
      return confirmationMatches(plan.digest, typed) ? "approved" : "declined";
    },
  };
}
