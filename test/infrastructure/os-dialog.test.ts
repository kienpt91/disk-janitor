import { describe, expect, it } from "vitest";
import { buildPlan } from "../../src/domain/plan/plan.js";
import type { Plan } from "../../src/domain/model/types.js";
import type { CommandResult, CommandRunner } from "../../src/infrastructure/process/command-runner.js";
import {
  ApproverUnavailableError,
  createOsDialogApprover,
  dialogApproved,
  dialogArgv,
  dialogText,
  findDialogTool,
} from "../../src/infrastructure/process/os-dialog.js";
import { dockerInput, fsInput, makeConfig, ROOT } from "../support/builders.js";

const HEX8 = "0123abcd";
const MIN = 60_000;

function plan(over: { path?: string; docker?: boolean } = {}): Plan {
  const config = makeConfig(over.docker ? { dockerApply: true } : {});
  return buildPlan(config, { fs: [fsInput(over.path ?? `${ROOT}/alpha/node_modules`)], docker: over.docker ? [dockerInput()] : [], reports: [] }, Date.UTC(2026, 0, 1), HEX8);
}

interface Call {
  command: string;
  args: readonly string[];
  env: Record<string, string> | undefined;
}

/** Scripted runner: `answers[command]` is the result for that command; anything else behaves like "not installed". */
function runner(answers: Record<string, Partial<CommandResult>>): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (command, args, opts) => {
    calls.push({ command, args, env: opts?.env });
    const a = answers[command];
    if (!a) return { code: null, stdout: "", stderr: "", error: "ENOENT" };
    return { code: 0, stdout: "", stderr: "", ...a };
  };
  return { run, calls };
}

describe("dialogText", () => {
  it("names the plan, a digest prefix, the totals, the validity and the quarantine", () => {
    const p = plan();
    const text = dialogText(p, 15 * MIN);
    expect(text).toContain(p.id);
    expect(text).toContain(`digest ${p.digest.slice(0, 12)}`);
    expect(text).toContain("1 candidates");
    expect(text).toContain("valid 15 minutes");
    expect(text).toContain("quarantine you can restore");
    expect(text).not.toContain(p.digest);
  });

  it("warns that docker prunes are not reversible only when the plan has them", () => {
    expect(dialogText(plan(), 15 * MIN)).not.toContain("NOT reversible");
    expect(dialogText(plan({ docker: true }), 15 * MIN)).toContain("1 docker prune steps are NOT reversible");
  });

  it("never contains file-system data, even for a hostile candidate path", () => {
    const hostile = plan({ path: `${ROOT}/x" & do shell script "rm -rf ~"\\n\u202e/node_modules` });
    const text = dialogText(hostile, 15 * MIN);
    expect(text).not.toContain("rm -rf");
    expect(text).not.toContain('"');
    expect(text).not.toContain("\\");
    expect(text).toMatch(/^[A-Za-z0-9 .,:;()/-]+$/);
  });
});

describe("dialogArgv", () => {
  const text = "Approve plan p1: 1 candidates";

  it("uses one fixed osascript shape with the Cancel button as default", () => {
    expect(dialogArgv("osascript", text)).toEqual([
      "-e",
      'display dialog "Approve plan p1: 1 candidates" with title "disk-janitor approval" buttons {"Cancel", "Approve"} default button "Cancel" cancel button "Cancel" with icon caution giving up after 120',
    ]);
  });

  it("uses one fixed zenity shape without markup", () => {
    expect(dialogArgv("zenity", text)).toEqual([
      "--question",
      "--no-markup",
      "--title",
      "disk-janitor approval",
      "--text",
      text,
      "--ok-label",
      "Approve",
      "--cancel-label",
      "Cancel",
      "--timeout",
      "120",
    ]);
  });

  it("uses one fixed kdialog shape", () => {
    expect(dialogArgv("kdialog", text)).toEqual(["--title", "disk-janitor approval", "--warningyesno", text, "--yes-label", "Approve", "--no-label", "Cancel"]);
  });

  it.each(['say "hi"', "back\\slash", "new\nline", "tab\tchar", "it's", "<b>x</b>", "a;b$(id)", "\u202e"])("refuses text that is not on the allowlist: %j", (bad) => {
    for (const tool of ["osascript", "zenity", "kdialog"] as const) {
      expect(() => dialogArgv(tool, bad)).toThrow(ApproverUnavailableError);
    }
  });
});

describe("dialogApproved", () => {
  it("osascript: only an explicit Approve that did not time out counts", () => {
    expect(dialogApproved("osascript", { code: 0, stdout: "button returned:Approve, gave up:false\n" })).toBe(true);
    expect(dialogApproved("osascript", { code: 0, stdout: "button returned:Approve, gave up:true\n" })).toBe(false);
    expect(dialogApproved("osascript", { code: 0, stdout: "button returned:Cancel, gave up:false\n" })).toBe(false);
    expect(dialogApproved("osascript", { code: 0, stdout: "" })).toBe(false);
    expect(dialogApproved("osascript", { code: 1, stdout: "button returned:Approve, gave up:false\n" })).toBe(false);
    expect(dialogApproved("osascript", { code: null, stdout: "button returned:Approve, gave up:false\n" })).toBe(false);
  });

  it.each(["zenity", "kdialog"] as const)("%s: only exit code 0 approves", (tool) => {
    expect(dialogApproved(tool, { code: 0, stdout: "" })).toBe(true);
    for (const code of [1, 5, 255, null]) expect(dialogApproved(tool, { code, stdout: "" })).toBe(false);
  });
});

describe("findDialogTool", () => {
  it("macOS uses osascript when it runs", async () => {
    const { run, calls } = runner({ osascript: { stdout: "1\n" } });
    expect(await findDialogTool(run, "darwin", {})).toBe("osascript");
    expect(calls[0]?.args).toEqual(["-e", "return 1"]);
  });

  it("macOS without a working osascript has no dialog", async () => {
    expect(await findDialogTool(runner({ osascript: { code: 1 } }).run, "darwin", {})).toBeNull();
    expect(await findDialogTool(runner({}).run, "darwin", {})).toBeNull();
  });

  it("Linux needs a graphical session", async () => {
    const { run, calls } = runner({ zenity: {} });
    expect(await findDialogTool(run, "linux", {})).toBeNull();
    expect(calls).toEqual([]);
  });

  it("Linux prefers zenity, falls back to kdialog, otherwise has none", async () => {
    expect(await findDialogTool(runner({ zenity: {}, kdialog: {} }).run, "linux", { DISPLAY: ":0" })).toBe("zenity");
    expect(await findDialogTool(runner({ kdialog: {} }).run, "linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe("kdialog");
    expect(await findDialogTool(runner({}).run, "linux", { DISPLAY: ":0" })).toBeNull();
  });

  it("other platforms have none", async () => {
    for (const p of ["win32", "freebsd", "aix"]) expect(await findDialogTool(runner({ zenity: {}, osascript: {} }).run, p, { DISPLAY: ":0" })).toBeNull();
  });
});

describe("createOsDialogApprover", () => {
  it("is unavailable, with a clear message and no fallback, when no dialog tool exists", async () => {
    await expect(createOsDialogApprover(runner({}).run, "linux", { DISPLAY: ":0" })).rejects.toThrow(ApproverUnavailableError);
    await expect(createOsDialogApprover(runner({}).run, "linux", {})).rejects.toThrow(/no OS confirmation dialog is available/);
  });

  it("asks through the detected tool with the exact argv and approves on an explicit Approve", async () => {
    const p = plan();
    const { run, calls } = runner({ osascript: { stdout: "button returned:Approve, gave up:false\n" } });
    const approver = await createOsDialogApprover(run, "darwin", {});
    expect(approver.kind).toBe("os-dialog");
    expect(approver.preflight).toBeUndefined();
    expect(await approver.decide(p, 15 * MIN)).toBe("approved");
    const ask = calls.at(-1) as Call;
    expect(ask.command).toBe("osascript");
    expect(ask.args).toEqual(dialogArgv("osascript", dialogText(p, 15 * MIN)));
  });

  it.each([
    ["Cancel", { code: 1 }],
    ["a timeout", { code: 0, stdout: "button returned:Approve, gave up:true" }],
    ["a killed tool", { code: null, error: "timeout" }],
  ] as Array<[string, Partial<CommandResult>]>)("declines on %s", async (_name, answer) => {
    // detection (`return 1`) succeeds; the dialog itself gives `answer`
    const run: CommandRunner = async (_c, args) =>
      args[0] === "-e" && args[1] === "return 1" ? { code: 0, stdout: "1", stderr: "" } : { code: 0, stdout: "", stderr: "", ...answer };
    const approver = await createOsDialogApprover(run, "darwin", {});
    expect(await approver.decide(plan(), 15 * MIN)).toBe("declined");
  });

  it("passes only display-related environment variables to the dialog tool", async () => {
    const { run, calls } = runner({ zenity: {} });
    const approver = await createOsDialogApprover(run, "linux", { DISPLAY: ":1", XAUTHORITY: "/home/u/.Xauthority", SECRET_TOKEN: "do-not-forward", PATH: "/usr/bin" });
    await approver.decide(plan(), 15 * MIN);
    const ask = calls.at(-1) as Call;
    expect(ask.command).toBe("zenity");
    expect(ask.env).toEqual({ DISPLAY: ":1", XAUTHORITY: "/home/u/.Xauthority" });
  });

  it("never involves a shell: the tool is the command and every argument is a separate array entry", async () => {
    const { run, calls } = runner({ kdialog: {} });
    const approver = await createOsDialogApprover(run, "linux", { DISPLAY: ":0" });
    await approver.decide(plan(), 15 * MIN);
    const ask = calls.at(-1) as Call;
    expect(["osascript", "zenity", "kdialog"]).toContain(ask.command);
    expect(Array.isArray(ask.args)).toBe(true);
    expect(ask.args.every((a) => typeof a === "string")).toBe(true);
  });
});
