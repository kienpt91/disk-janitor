import { readFile, stat } from "node:fs/promises";
import { MAX_CONFIG_BYTES, parseRawConfig, type RawConfig } from "../domain/model/config.js";

/** Read a JSON config file (at most 64 KiB, unknown keys rejected). */
export async function loadConfigFile(path: string): Promise<RawConfig> {
  const st = await stat(path);
  if (!st.isFile()) throw new Error(`config is not a regular file: ${path}`);
  if (st.size > MAX_CONFIG_BYTES) throw new Error(`config file is larger than ${MAX_CONFIG_BYTES} bytes`);
  return parseRawConfig(await readFile(path, "utf8"));
}
