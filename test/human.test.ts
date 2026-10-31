import { describe, expect, it } from "vitest";
import { AGENT_ENV_MARKERS, assertHumanSession, confirmByTyping, digestPrefix, HumanRequiredError, type HumanIO } from "../src/human.js";

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
    expect(await confirmByTyping(io(p), p, "apply")).toBe(true);
    expect(await confirmByTyping(io(`  ${p}\t\n`), p, "apply")).toBe(true);
  });

  for (const wrong of ["", " ", "y", "yes", "0123abcc", "0123ABCD", "0123abcd extra", "extra 0123abcd", "0123abcde", "0123abc", "0123 abcd"]) {
    it(`rejects ${JSON.stringify(wrong)}`, async () => {
      expect(await confirmByTyping(io(wrong), "0123abcd", "apply")).toBe(false);
    });
  }

  it("shows the expected text and the action in the prompt", async () => {
    let prompt = "";
    const h: HumanIO = { ...tty, write: () => undefined, ask: async (q) => ((prompt = q), "") };
    await confirmByTyping(h, "0123abcd", "apply the plan");
    expect(prompt).toBe("Type 0123abcd to apply the plan, anything else cancels: ");
  });

  it("escapes control characters in the expected text shown to the human", async () => {
    let prompt = "";
    const h: HumanIO = { ...tty, write: () => undefined, ask: async (q) => ((prompt = q), "") };
    await confirmByTyping(h, "a\u001b[2Jb", "purge");
    expect(prompt).not.toContain("\u001b");
    expect(prompt).toContain("\\x1b");
  });
});
