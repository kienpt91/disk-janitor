// The protected-path denylist. It always wins: no detector, no configuration and no plan can
// make a protected path a candidate. Matching is case-insensitive (default macOS volumes
// are case-insensitive) and applies to every component of the absolute path.

import { sep } from "node:path";
import { isInside } from "../shared/paths.js";

const EXACT_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".config",
  ".kube",
  ".azure",
  ".docker",
  ".password-store",
  "keychains",
  "mobile documents",
  "cloudstorage",
  "dropbox",
  "onedrive",
  "google drive",
  "googledrive",
  "icloud drive",
  "iclouddrive",
  "box",
  "box sync",
  "nextcloud",
  "owncloud",
  "pcloud drive",
  "megasync",
  "pgdata",
  "pg_data",
  "postgres-data",
  "mysql-data",
  "mongo-data",
  "mongodb-data",
  "redis-data",
  "db-data",
]);

const SEGMENT_PATTERNS: Array<[RegExp, string]> = [
  [/^\.env(\..*)?$/, "environment file"],
  [/^dropbox(\b|$)/, "sync folder"],
  [/^onedrive(\b|$)/, "sync folder"],
  [/^google drive(\b|$)/, "sync folder"],
  [/^icloud(\b|$)/, "sync folder"],
  [/\.keychain(-db)?$/, "keychain"],
  [/\.(kdbx|p12|pfx|jks|keystore)$/, "key or credential store"],
  [/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, "ssh key"],
  [/secret|credential|passwd|password|private[-_ ]?key/, "name looks like a secret"],
  [/^\.(netrc|pgpass|htpasswd|npmrc|pypirc)$/, "credential file"],
];

// Directories directly under the user's home that hold personal data.
const HOME_PROTECTED_PREFIXES = [
  "documents",
  "desktop",
  "downloads",
  "pictures",
  "music",
  "movies",
  "videos",
  "public",
  "library/keychains",
  "library/mobile documents",
  "library/cloudstorage",
  "library/application support",
  "library/preferences",
  "library/mail",
  "library/messages",
  "library/safari",
  "library/containers",
  "library/group containers",
  ".local/share/keyrings",
  ".mozilla",
];

const USER_HOME_RE = /^\/(users|home)\/[^/]+\/(.+)$/;

/** Reason a path is protected, or null. `homes` are canonical home directories to evaluate against. */
export function protectedReason(absPath: string, homes: readonly string[] = []): string | null {
  const lower = absPath.toLowerCase();
  const segments = lower.split(sep).filter((s) => s.length > 0);
  for (const seg of segments) {
    if (EXACT_SEGMENTS.has(seg)) return `path component "${seg}" is protected`;
    for (const [re, why] of SEGMENT_PATTERNS) {
      if (re.test(seg)) return `path component "${seg}" is protected (${why})`;
    }
  }
  const prefixCheck = (rel: string): string | null => {
    for (const prefix of HOME_PROTECTED_PREFIXES) {
      if (rel === prefix || rel.startsWith(prefix + "/")) return `inside the protected location ~/${prefix}`;
    }
    return null;
  };
  for (const home of homes) {
    const h = home.toLowerCase();
    if (lower === h) return "the home directory itself is protected";
    if (isInside(h, lower)) {
      const hit = prefixCheck(lower.slice(h.length + (h === "/" ? 0 : 1)));
      if (hit) return hit;
    }
  }
  const m = USER_HOME_RE.exec(lower);
  if (m) {
    const hit = prefixCheck(m[2] as string);
    if (hit) return hit;
  }
  return null;
}

const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults?)$/;
const DB_MARKERS = new Set(["pg_version", "ibdata1", "wiredtiger", "wiredtiger.wt", "mongod.lock", "postmaster.pid"]);

/**
 * Reason a file or directory name found *inside* a candidate makes the whole candidate
 * ineligible. `strict` additionally rejects key material by extension; it is used for build
 * outputs, where such files are never expected, but not for node_modules, whose packages
 * legitimately ship test certificates.
 */
export function contentNameReason(name: string, strict: boolean): string | null {
  const lower = name.toLowerCase();
  if (lower === ".git") return "contains a nested .git entry";
  if (/^\.env(\..*)?$/.test(lower) && !ENV_TEMPLATE.test(lower)) return "contains an environment file";
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(lower)) return "contains an ssh private key";
  if (/^\.(netrc|pgpass|htpasswd)$/.test(lower)) return "contains a credential file";
  if (/\.(kdbx|p12|pfx|jks)$/.test(lower) || /\.keychain(-db)?$/.test(lower)) return "contains a key or credential store";
  if (DB_MARKERS.has(lower)) return "looks like a database data directory";
  if (strict) {
    if (/\.(pem|key|keystore)$/.test(lower)) return "contains key material";
    if (/^(credentials|secrets?)(\..*)?$/.test(lower) || lower === ".npmrc" || lower === ".pypirc") {
      return "contains a file named like a secret";
    }
  }
  return null;
}
