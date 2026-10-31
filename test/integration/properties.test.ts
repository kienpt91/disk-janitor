import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApplyError, type ApplyResult } from "../../src/composition/disposal.js";
import { AuditLog } from "../../src/infrastructure/state/audit-log.js";
import { parsePlan } from "../../src/domain/plan/plan.js";
import { writePlanFile } from "../../src/composition/planning.js";
import { restore } from "../../src/composition/disposal.js";
import type { FsCandidate } from "../../src/domain/model/types.js";
import { ageTree, approveAsHuman, makeProject, makeSandbox, planFor, treeHash, writeText } from "../support/helpers.js";
import { catchApply, fsCandidates, hashExcluding, mulberry32, runApply, storedItem } from "../support/helpers-apply.js";

const ITERATIONS = 80;

describe("property: random forests with random mutations between plan and apply", () => {
  it(`apply either succeeds faithfully or aborts leaving the tree untouched (${ITERATIONS} seeded runs)`, async () => {
    let succeeded = 0;
    let aborted = 0;
    const abortedByKind = new Map<number, number>();

    for (let seed = 1; seed <= ITERATIONS; seed++) {
      const rng = mulberry32(seed * 7919 + 13);
      const int = (n: number): number => Math.floor(rng() * n);
      const sb = makeSandbox();

      const count = 2 + int(4);
      const projectDirs: string[] = [];
      for (let i = 0; i < count; i++) {
        const nested = rng() < 0.3 ? join(sb.projects, `group${int(2)}`, `proj${i}`) : join(sb.projects, `proj${i}`);
        makeProject(nested, { nodeModules: 4096 * (1 + int(8)) + i * 1000 });
        projectDirs.push(nested);
      }
      const victim = join(sb.base, "victim");
      writeText(join(victim, "data.txt"), `victim ${seed}\n`);
      writeText(join(victim, "node_modules", "dep", "index.js"), "victim node_modules\n");

      const p = await planFor(sb);
      const cands: FsCandidate[] = fsCandidates(p.plan);
      expect(cands.map((c) => c.path).sort()).toEqual(projectDirs.map((d) => join(d, "node_modules")).sort());
      await approveAsHuman(p.state, p.plan, p.deps);

      const mutations = rng() < 0.25 ? 0 : 1 + int(3);
      let firstDisruptive = -1;
      for (let m = 0; m < mutations; m++) {
        const c = cands[int(cands.length)] as FsCandidate;
        const project = c.path.slice(0, -"/node_modules".length);
        const kind = int(9);
        try {
          switch (kind) {
            case 0:
              writeFileSync(join(c.path, "dep", `late${m}.js`), "late\n");
              break;
            case 1:
              rmSync(c.path, { recursive: true });
              break;
            case 2:
              rmSync(c.path, { recursive: true });
              symlinkSync(victim, c.path);
              break;
            case 3: {
              const t = new Date(Date.now() + 3000);
              utimesSync(c.path, t, t);
              break;
            }
            case 4:
              renameSync(c.path, `${c.path}.bak`);
              break;
            case 5:
              writeFileSync(join(project, "src", "index.js"), `changed ${seed}\n`);
              break;
            case 6:
              writeFileSync(join(project, "NOTES.txt"), "benign\n");
              break;
            case 7:
              renameSync(project, `${project}.aside`);
              symlinkSync(victim, project);
              break;
            default:
              writeFileSync(join(c.path, "dep", "index.js"), "x".repeat(10_000));
          }
        } catch {
          // an earlier mutation already removed the target; the run continues with what is left
          continue;
        }
        if (firstDisruptive < 0 && ![5, 6].includes(kind)) firstDisruptive = kind;
      }

      // taken after the mutations: some of them write through a symlink the test itself planted
      const victimHash = treeHash(victim);
      const after = treeHash(sb.home);
      const exclude = new Set(cands.map((c) => c.path));
      const outsideBefore = hashExcluding(sb.home, exclude);
      const candHashes = cands.map((c) => (lstatSync(c.path, { throwIfNoEntry: false }) ? treeHash(c.path) : null));

      let failure: ApplyError | null = null;
      let result: ApplyResult | null = null;
      try {
        result = await runApply(p);
      } catch (e) {
        if (!(e instanceof ApplyError)) throw e;
        failure = e;
      }

      expect(treeHash(victim), `seed ${seed}: victim`).toBe(victimHash);
      if (failure) {
        aborted++;
        abortedByKind.set(firstDisruptive, (abortedByKind.get(firstDisruptive) ?? 0) + 1);
        expect(failure.code, `seed ${seed}`).toBe("validation");
        expect(failure.problems.length, `seed ${seed}`).toBeGreaterThan(0);
        expect(treeHash(sb.home), `seed ${seed}: tree after abort`).toBe(after);
        expect(existsSync(join(p.state.quarantineDir, p.plan.id)), `seed ${seed}: quarantine`).toBe(false);
      } else {
        succeeded++;
        const res = result as NonNullable<typeof result>;
        expect(res.moved, `seed ${seed}`).toHaveLength(cands.length);
        cands.forEach((c, i) => {
          expect(lstatSync(c.path, { throwIfNoEntry: false }), `seed ${seed}: ${c.path} gone`).toBeUndefined();
          expect(treeHash(storedItem(p.state, p.plan, i)), `seed ${seed}: item ${i}`).toBe(candHashes[i]);
        });
        expect(hashExcluding(sb.home, exclude), `seed ${seed}: outside candidates`).toBe(outsideBefore);
        const out = await restore(p.state, p.deps, new AuditLog(p.state, p.deps.now), p.plan.id);
        expect(out.every((r) => r.ok), `seed ${seed}: restore`).toBe(true);
        expect(treeHash(sb.home), `seed ${seed}: restored tree`).toBe(after);
      }
      expect((await new AuditLog(p.state).verify()).ok, `seed ${seed}: audit chain`).toBe(true);
      sb.cleanup();
    }

    // the generator must exercise both outcomes and several kinds of disruption
    expect(succeeded + aborted).toBe(ITERATIONS);
    expect(succeeded).toBeGreaterThanOrEqual(15);
    expect(aborted).toBeGreaterThanOrEqual(25);
    expect(abortedByKind.size).toBeGreaterThanOrEqual(5);
  }, 240_000);
});

const PIECES = [
  "a\nb",
  "x\ry",
  "\u001b[31mred\u001b[0m",
  "\u202eevil.txt",
  "\u2066iso\u2069",
  "-rf",
  "--help",
  "-",
  " lead",
  "trail ",
  "with space",
  "tab\there",
  "\u00fcn\u00ef\u00a9ode",
  "\u{1f600}",
  "a".repeat(255),
  `${"b".repeat(252)}.js`,
  "..hidden",
  "...",
  "$(touch pwned)",
  "`id`",
  "*",
  "?",
  "[abc]",
  "'quote'",
  '"dq"',
  ";echo hi",
  "%00",
  "%2e%2e",
  "back\\slash",
  "\u200bzw",
];

const PROJECT_NAMES = ["proj\nnewline", "proj\u202eevil", "-dash", "sp ace", "tab\tname", "plain"];

describe("property: hostile names survive plan -> approve -> apply -> restore byte for byte", () => {
  it(`random hostile file and directory names (${ITERATIONS} seeded runs)`, async () => {
    let longNames = 0;
    let multiLine = 0;
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      const rng = mulberry32(seed * 104729 + 7);
      const int = (n: number): number => Math.floor(rng() * n);
      const pick = (): string => {
        let name = PIECES[int(PIECES.length)] as string;
        if (rng() < 0.4) name += PIECES[int(PIECES.length)] as string;
        if (Buffer.byteLength(name) > 255) name = PIECES[0] as string;
        return name;
      };
      const sb = makeSandbox();
      const projectName = PROJECT_NAMES[int(PROJECT_NAMES.length)] as string;
      const project = makeProject(join(sb.projects, projectName), { nodeModules: 6000 });
      const nm = join(project, "node_modules");

      const used = new Set<string>();
      const build = (dir: string, depth: number): void => {
        const entries = 2 + int(5);
        for (let i = 0; i < entries; i++) {
          const name = pick();
          const path = join(dir, name);
          if (used.has(path)) continue;
          used.add(path);
          if (Buffer.byteLength(name) >= 250) longNames++;
          if (name.includes("\n")) multiLine++;
          const kind = int(10);
          if (kind < 5) {
            const bytes = Buffer.alloc(int(300));
            for (let b = 0; b < bytes.length; b++) bytes[b] = int(256);
            writeFileSync(path, bytes);
          } else if (kind < 8 && depth < 3) {
            mkdirSync(path);
            build(path, depth + 1);
          } else if (kind === 8) {
            symlinkSync(rng() < 0.5 ? pick() : `../${pick()}`, path);
          } else {
            writeFileSync(path, "");
          }
        }
      };
      build(join(nm, "dep"), 0);
      ageTree(project, 60);
      const before = treeHash(nm);

      const p = await planFor(sb);
      expect(fsCandidates(p.plan).map((c) => c.path), `seed ${seed}`).toEqual([nm]);
      // the plan survives serialization with the hostile path inside
      const planFile = join(sb.base, "plan.json");
      await writePlanFile(planFile, p.plan);
      const parsed = parsePlan(readFileSync(planFile, "utf8"));
      expect(parsed, `seed ${seed}: plan round trip`).toEqual(p.plan);

      await approveAsHuman(p.state, parsed, p.deps);
      const res = await runApply({ ...p, plan: parsed });
      expect(res.moved.map((m) => m.path), `seed ${seed}`).toEqual([nm]);
      expect(lstatSync(nm, { throwIfNoEntry: false }), `seed ${seed}: original gone`).toBeUndefined();
      expect(treeHash(storedItem(p.state, parsed, 0)), `seed ${seed}: quarantined content`).toBe(before);

      const out = await restore(p.state, p.deps, new AuditLog(p.state, p.deps.now), parsed.id);
      expect(out.map((r) => r.ok), `seed ${seed}: restore`).toEqual([true]);
      expect(treeHash(nm), `seed ${seed}: restored content`).toBe(before);
      expect((await new AuditLog(p.state).verify()).ok, `seed ${seed}: audit`).toBe(true);
      sb.cleanup();
    }
    expect(longNames).toBeGreaterThan(5);
    expect(multiLine).toBeGreaterThan(5);
  }, 240_000);

  it("project directories with hostile names are handled consistently by every module (fixed set)", async () => {
    const sb = makeSandbox();
    const names = ["proj\nnewline", "proj\u202eevil", "-dash", "sp ace", "tab\tname", "\u001b[2Jclear"];
    const nms = names.map((n) => join(makeProject(join(sb.projects, n), { nodeModules: 5000 }), "node_modules"));
    const p = await planFor(sb);
    expect(fsCandidates(p.plan).map((c) => c.path).sort()).toEqual([...nms].sort());
    await approveAsHuman(p.state, p.plan, p.deps);
    const hashes = new Map(nms.map((nm) => [nm, treeHash(nm)]));
    const res = await runApply(p);
    expect(res.moved).toHaveLength(names.length);
    const out = await restore(p.state, p.deps, new AuditLog(p.state, p.deps.now), p.plan.id);
    expect(out.every((r) => r.ok)).toBe(true);
    for (const nm of nms) expect(treeHash(nm)).toBe(hashes.get(nm));
    // the approval was consumed by the apply above
    expect((await catchApply(runApply(p))).code).toBe("not-approved");
  });
});
