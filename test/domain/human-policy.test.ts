import { describe, expect, it } from "vitest";
import { AGENT_ENV_MARKERS, assertHumanSession, confirmationMatches, digestPrefix, HumanRequiredError } from "../../src/domain/policy/human.js";
import { confirmByTyping, type HumanIO } from "../../src/application/human-confirmation.js";

const tty = { stdinIsTTY: true, stdoutIsTTY: true, env: {} as Record<string, string | undefined> };

function io(answer: string): HumanIO {
  return { ...tty, write: () => undefined, ask: async () => answer };
}

describe("assertHumanSession", () => {
  it("passes with TTYs and a clean env", () => {
    expect(() => assertHumanSession(tty, "approve")).not.toThrow();
  });

  it("passes with unrelated env variables", () => {
    expect(() => assertHumanSession({ ...tty, env: { PATH: "/bin", TERM: "xterm" } }, "approve")).not.toThrow();
  });

  it("throws when stdin is not a TTY", () => {
    expect(() => assertHumanSession({ ...tty, stdinIsTTY: false }, "approve")).toThrow(HumanRequiredError);
    expect(() => assertHumanSession({ ...tty, stdinIsTTY: false }, "approve")).toThrow(/approve needs an interactive terminal/);
  });

  it("throws when stdout is not a TTY", () => {
    expect(() => assertHumanSession({ ...tty, stdoutIsTTY: false }, "purge")).toThrow(/purge needs an interactive terminal/);
  });

  it("throws when neither is a TTY", () => {
    expect(() => assertHumanSession({ ...tty, stdinIsTTY: false, stdoutIsTTY: false }, "x")).toThrow(HumanRequiredError);
  });

  it("lists the expected agent markers", () => {
    expect([...AGENT_ENV_MARKERS]).toEqual(["DISK_JANITOR_AGENT", "DISK_JANITOR_NONINTERACTIVE", "AGENT_SESSION", "NONINTERACTIVE", "CI"]);
  });

  for (const marker of ["DISK_JANITOR_AGENT", "DISK_JANITOR_NONINTERACTIVE", "AGENT_SESSION", "NONINTERACTIVE", "CI"]) {
    for (const value of ["1", "true", "yes", "TRUE", " Yes ", "anything"]) {
      it(`refuses when ${marker}=${JSON.stringify(value)}`, () => {
        const run = () => assertHumanSession({ ...tty, env: { [marker]: value } }, "approve");
        expect(run).toThrow(HumanRequiredError);
        expect(run).toThrow(new RegExp(`refuses to run while ${marker} is set`));
      });
    }
    for (const value of ["", "0", "false", "no", " FALSE ", "No", undefined]) {
      it(`allows when ${marker}=${JSON.stringify(value)}`, () => {
        expect(() => assertHumanSession({ ...tty, env: { [marker]: value } }, "approve")).not.toThrow();
      });
    }
  }

  it("still refuses when one of several markers is set", () => {
    expect(() => assertHumanSession({ ...tty, env: { CI: "0", AGENT_SESSION: "1" } }, "approve")).toThrow(/AGENT_SESSION/);
  });

  it("HumanRequiredError has its own name", () => {
    expect(new HumanRequiredError("x").name).toBe("HumanRequiredError");
  });
});

describe("confirmByTyping / digestPrefix", () => {
  const digest = "0123abcd" + "e".repeat(56);

  it("digestPrefix is the first 8 characters", () => {
    expect(digestPrefix(digest)).toBe("0123abcd");
    expect(digestPrefix(digest)).toHaveLength(8);
    expect(digestPrefix("abc")).toBe("abc");
  });

  it("accepts the exact prefix and trims whitespace", async () => {
    const p = digestPrefix(digest);
    expect(await confirmByTyping(io(p), p, "Type it")).toBe(true);
    expect(await confirmByTyping(io(`  ${p}\t\n`), p, "Type it")).toBe(true);
  });

  for (const wrong of ["", " ", "y", "yes", "0123abcc", "0123ABCD", "0123abcd extra", "extra 0123abcd", "0123abcde", "0123abc", "0123 abcd"]) {
    it(`rejects ${JSON.stringify(wrong)}`, async () => {
      expect(await confirmByTyping(io(wrong), "0123abcd", "Type it")).toBe(false);
    });
  }

  it("shows the prompt text and never the expected value", async () => {
    let prompt = "";
    const h: HumanIO = { ...tty, write: () => undefined, ask: async (q) => ((prompt = q), "") };
    await confirmByTyping(h, "0123abcd", "Type the confirmation code printed by dry-run to apply the plan");
    expect(prompt).toBe("Type the confirmation code printed by dry-run to apply the plan, anything else cancels: ");
    expect(prompt).not.toContain("0123abcd");
  });

  it("does not echo the expected value even when it contains control characters", async () => {
    let prompt = "";
    const h: HumanIO = { ...tty, write: () => undefined, ask: async (q) => ((prompt = q), "") };
    await confirmByTyping(h, "a\u001b[2Jb", "Type the code");
    expect(prompt).not.toContain("\u001b");
    expect(prompt).not.toContain("a\\x1b");
  });
});

describe("confirmationMatches", () => {
  it("accepts the exact text", () => {
    expect(confirmationMatches("0123abcd", "0123abcd")).toBe(true);
  });

  it("trims surrounding whitespace from what was typed", () => {
    expect(confirmationMatches("0123abcd", " \t0123abcd\r\n")).toBe(true);
  });

  it("does not trim the expected text", () => {
    expect(confirmationMatches(" x", "x")).toBe(false);
  });

  it.each(["", "0123abc", "0123ABCD", "0123abcd0", "0123 abcd", "o123abcd"])("rejects %j", (typed) => {
    expect(confirmationMatches("0123abcd", typed)).toBe(false);
  });

  it("an empty expectation only matches blank input", () => {
    expect(confirmationMatches("", "")).toBe(true);
    expect(confirmationMatches("", "  ")).toBe(true);
    expect(confirmationMatches("", "x")).toBe(false);
  });
});
