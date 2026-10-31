import type { ApprovalDecision, Approver } from "../../application/approvers.js";
import type { Plan } from "../../domain/model/types.js";
import type { CommandRunner } from "./command-runner.js";

export class ApproverUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApproverUnavailableError";
  }
}

export type DialogTool = "osascript" | "zenity" | "kdialog";

const DIALOG_TIMEOUT_S = 120;
const SAFE_TEXT = /^[A-Za-z0-9 .,:;()/-]+$/;
const DISPLAY_ENV = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_CURRENT_DESKTOP"];

function bytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/**
 * The dialog text is built only from fixed words, the validated plan id, the first 12 hex characters
 * of the digest and numbers: no file-system data and no quotes, so it cannot break out of the
 * AppleScript or command-line argument it is placed in. A final allowlist check enforces that.
 */
export function dialogText(plan: Plan, validityMs: number): string {
  const total = plan.candidates.reduce((s, c) => s + c.size, 0);
  const docker = plan.candidates.filter((c) => c.kind === "docker").length;
  const text =
    `Approve disk-janitor plan ${plan.id} (digest ${plan.digest.slice(0, 12)}): ` +
    `${plan.candidates.length} candidates, ${bytes(total)}, valid ${Math.round(validityMs / 60_000)} minutes. ` +
    `Directories are moved into a quarantine you can restore.` +
    (docker > 0 ? ` ${docker} docker prune steps are NOT reversible and run on the daemon selected by your docker environment variables.` : "") +
    ` Only approve if you reviewed this plan with disk-janitor explain.`;
  if (!SAFE_TEXT.test(text)) throw new ApproverUnavailableError("dialog text contained unexpected characters");
  return text;
}

/** The exact argument vector used for each tool. Exported so tests can assert it never varies in shape. */
export function dialogArgv(tool: DialogTool, text: string): string[] {
  if (!SAFE_TEXT.test(text)) throw new ApproverUnavailableError("dialog text contained unexpected characters");
  switch (tool) {
    case "osascript":
      return [
        "-e",
        `display dialog "${text}" with title "disk-janitor approval" buttons {"Cancel", "Approve"} default button "Cancel" cancel button "Cancel" with icon caution giving up after ${DIALOG_TIMEOUT_S}`,
      ];
    case "zenity":
      return [
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
        String(DIALOG_TIMEOUT_S),
      ];
    case "kdialog":
      return ["--title", "disk-janitor approval", "--warningyesno", text, "--yes-label", "Approve", "--no-label", "Cancel"];
  }
}

/** Interpret a finished dialog command: only an explicit Approve counts. */
export function dialogApproved(tool: DialogTool, result: { code: number | null; stdout: string }): boolean {
  if (result.code !== 0) return false;
  if (tool === "osascript") return /button returned:Approve\b/.test(result.stdout) && /gave up:false/.test(result.stdout);
  return true;
}

/** Find a usable dialog tool for this platform, or null. */
export async function findDialogTool(run: CommandRunner, platform: string, env: Readonly<Record<string, string | undefined>>): Promise<DialogTool | null> {
  if (platform === "darwin") {
    const r = await run("osascript", ["-e", "return 1"], { timeoutMs: 10_000 });
    return r.code === 0 ? "osascript" : null;
  }
  if (platform !== "linux") return null;
  if (!env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) return null;
  for (const tool of ["zenity", "kdialog"] as const) {
    const r = await run(tool, ["--version"], { timeoutMs: 10_000 });
    if (r.code === 0) return tool;
  }
  return null;
}

/**
 * Best-effort stronger approver: the decision comes from a native confirmation dialog (osascript on
 * macOS, zenity or kdialog on Linux) instead of a terminal, so a process that merely drives a pty
 * cannot answer it. It is only as strong as the desktop session: an agent that can click UI elements
 * (accessibility permission on macOS, an X11 session shared by the same user) can still answer it.
 * It does not need a TTY. Not available headless; there is no fallback to the terminal.
 */
export async function createOsDialogApprover(
  run: CommandRunner,
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Approver> {
  const tool = await findDialogTool(run, platform, env);
  if (!tool) {
    throw new ApproverUnavailableError(
      "no OS confirmation dialog is available here (needs osascript on macOS, or zenity/kdialog plus a graphical session on Linux); use the terminal approver instead",
    );
  }
  const extraEnv: Record<string, string> = {};
  for (const name of DISPLAY_ENV) {
    const v = env[name];
    if (v !== undefined) extraEnv[name] = v;
  }
  return {
    kind: "os-dialog",
    async decide(plan, validityMs): Promise<ApprovalDecision> {
      const argv = dialogArgv(tool, dialogText(plan, validityMs));
      const result = await run(tool, argv, { timeoutMs: (DIALOG_TIMEOUT_S + 30) * 1000, env: extraEnv });
      return dialogApproved(tool, result) ? "approved" : "declined";
    },
  };
}
