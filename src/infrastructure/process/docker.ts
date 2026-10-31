import type { DockerPort } from "../../application/ports/discovery.js";
import { DOCKER_COMMANDS } from "../../domain/discovery/catalog.js";
import { parseDanglingImageBytes, parseDockerDf } from "../../domain/discovery/eligibility.js";
import type { CommandRunner } from "./command-runner.js";

/** DockerPort over the docker CLI. Executes only the fixed argument lists of DOCKER_COMMANDS. */
export function createDocker(run: CommandRunner): DockerPort {
  return {
    async usage() {
      const res = await run("docker", DOCKER_COMMANDS.df, { timeoutMs: 30_000 });
      if (res.code !== 0) return { status: "unavailable", notInstalled: res.error === "ENOENT" };
      try {
        return { status: "ok", rows: parseDockerDf(res.stdout) };
      } catch (e) {
        return { status: "unparseable", message: (e as Error).message };
      }
    },

    async danglingImageBytes() {
      const res = await run("docker", DOCKER_COMMANDS.danglingImages, { timeoutMs: 30_000 });
      if (res.code !== 0) return null;
      return parseDanglingImageBytes(res.stdout);
    },

    async prune(resource) {
      const args = resource === "build-cache" ? DOCKER_COMMANDS.pruneBuildCache : DOCKER_COMMANDS.pruneDanglingImages;
      const res = await run("docker", args, { timeoutMs: 10 * 60_000 });
      const ok = res.code === 0;
      return { ok, detail: (ok ? res.stdout : res.stderr || res.error || "failed").slice(-400) };
    },
  };
}
