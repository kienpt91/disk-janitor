import { describe, expect, it } from "vitest";
import { contentNameReason, protectedReason } from "../src/domain/policy/protected.js";

const HOME = "/Users/alice";
const HOMES = [HOME];

describe("protectedReason: path components", () => {
  it.each([
    ["/work/app/.git/objects", ".git"],
    ["/Users/alice/.ssh/keys", ".ssh"],
    ["/Users/alice/.gnupg", ".gnupg"],
    ["/Users/alice/.aws/cache", ".aws"],
    ["/Users/alice/.config/tool/node_modules", ".config"],
    ["/Users/alice/.kube/cache", ".kube"],
    ["/Users/alice/.docker/buildx", ".docker"],
    ["/Users/alice/Library/Keychains/login", "keychains"],
    ["/Users/alice/Library/Mobile Documents/com~apple~CloudDocs/x", "mobile documents"],
    ["/Users/alice/Library/CloudStorage/GoogleDrive-a/b", "cloudstorage"],
    ["/Users/alice/Dropbox/proj/node_modules", "dropbox"],
    ["/Users/alice/OneDrive/proj", "onedrive"],
    ["/Users/alice/Google Drive/proj", "google drive"],
    ["/Users/alice/iCloud Drive/proj", "icloud drive"],
    ["/Users/alice/Dropbox (Personal)/proj", "dropbox"],
    ["/srv/pgdata/base", "pgdata"],
    ["/srv/mysql-data/x", "mysql-data"],
    ["/srv/redis-data", "redis-data"],
    ["/srv/mongodb-data/y", "mongodb-data"],
  ])("%s is protected (%s)", (path, needle) => {
    const reason = protectedReason(path, HOMES);
    expect(reason).not.toBeNull();
    expect(reason as string).toContain(needle);
  });

  it("protects environment files but matches by path component", () => {
    expect(protectedReason("/work/app/.env")).toContain("environment file");
    expect(protectedReason("/work/app/.env.local/x")).toContain("environment file");
    expect(protectedReason("/work/app/.envrc-not")).toBeNull();
  });

  it("protects secret-looking components", () => {
    expect(protectedReason("/work/my-secrets/app")).toContain("looks like a secret");
    expect(protectedReason("/work/credentials/x")).toContain("looks like a secret");
    expect(protectedReason("/work/passwords/x")).toContain("looks like a secret");
    expect(protectedReason("/work/private_key/x")).toContain("looks like a secret");
    expect(protectedReason("/work/id_ed25519")).toContain("ssh key");
    expect(protectedReason("/work/store.kdbx/x")).toContain("key or credential store");
    expect(protectedReason("/work/login.keychain-db")).toContain("keychain");
    expect(protectedReason("/work/.npmrc/x")).toContain("credential file");
  });

  it("is case-insensitive", () => {
    expect(protectedReason("/work/.GIT/x")).not.toBeNull();
    expect(protectedReason("/work/.SSH")).not.toBeNull();
    expect(protectedReason("/work/DROPBOX/x")).not.toBeNull();
    expect(protectedReason("/work/SeCrEtS/x")).not.toBeNull();
    expect(protectedReason("/work/.ENV")).not.toBeNull();
  });
});

describe("protectedReason: home-relative locations", () => {
  it.each(["Documents", "Desktop", "Downloads", "Pictures", "Music", "Movies"])("~/%s and below is protected", (dir) => {
    expect(protectedReason(`${HOME}/${dir}`, HOMES)).toBe(`inside the protected location ~/${dir.toLowerCase()}`);
    expect(protectedReason(`${HOME}/${dir}/proj/node_modules`, HOMES)).toContain("protected location");
  });

  it("protects Library subfolders holding personal data", () => {
    expect(protectedReason(`${HOME}/Library/Application Support/x`, HOMES)).toContain("~/library/application support");
    expect(protectedReason(`${HOME}/Library/Mail`, HOMES)).toContain("~/library/mail");
    expect(protectedReason(`${HOME}/Library/Messages/a`, HOMES)).toContain("~/library/messages");
  });

  it("is relative to the given home, not to a literal /Users prefix", () => {
    const home = "/data/people/bob";
    expect(protectedReason(`${home}/Documents/app`, [home])).toContain("~/documents");
    expect(protectedReason(`${home}/Downloads`, [home])).toContain("~/downloads");
    expect(protectedReason(`${home}/code/app`, [home])).toBeNull();
  });

  it("protects the home directory itself", () => {
    expect(protectedReason(HOME, HOMES)).toBe("the home directory itself is protected");
  });

  it("works with a home reached through several candidates", () => {
    expect(protectedReason("/b/Documents/x", ["/a", "/b"])).toContain("~/documents");
  });

  it("is case-insensitive for home-relative locations", () => {
    expect(protectedReason(`${HOME}/DOCUMENTS/x`, HOMES)).toContain("~/documents");
    expect(protectedReason("/users/ALICE/downloads/x")).toContain("~/downloads");
  });

  it("without homes still recognises /Users/<name> and /home/<name> layouts", () => {
    expect(protectedReason("/Users/carol/Desktop/p")).toContain("~/desktop");
    expect(protectedReason("/home/dave/Pictures/p")).toContain("~/pictures");
  });

  it("a directory merely named like a protected one deeper in the tree is not protected by prefix rules", () => {
    expect(protectedReason(`${HOME}/projects/Documents/app`, HOMES)).toBeNull();
    expect(protectedReason(`${HOME}/DocumentsOld/app`, HOMES)).toBeNull();
  });
});

describe("protectedReason: negative cases", () => {
  it.each([
    "/Users/alice/projects/app",
    "/Users/alice/projects/app/node_modules",
    "/home/dave/src/site/dist",
    "/private/var/folders/ab/xyz/T/dj-test-1/projects/app",
    "/private/var/folders/ab/xyz/T/dj-test-1/projects/app/node_modules",
    "/tmp/dj-test-abc123/home/projects/webapp/dist",
    "/work/boxes/app",
    "/work/gitlab/app",
    "/work/pgdata-tools/app",
    "/work/private/app",
  ])("%s is not protected", (path) => {
    expect(protectedReason(path, HOMES)).toBeNull();
    expect(protectedReason(path)).toBeNull();
  });
});

describe("contentNameReason", () => {
  it("flags nested .git entries", () => {
    expect(contentNameReason(".git", false)).toBe("contains a nested .git entry");
    expect(contentNameReason(".GIT", false)).toBe("contains a nested .git entry");
    expect(contentNameReason(".gitignore", false)).toBeNull();
  });

  it("flags .env files but not templates", () => {
    expect(contentNameReason(".env", false)).toBe("contains an environment file");
    expect(contentNameReason(".env.local", false)).toBe("contains an environment file");
    expect(contentNameReason(".env.production", true)).toBe("contains an environment file");
    for (const t of [".env.example", ".env.sample", ".env.template", ".env.dist", ".env.default", ".env.defaults", ".ENV.EXAMPLE"]) {
      expect(contentNameReason(t, false), t).toBeNull();
    }
    expect(contentNameReason("env.js", false)).toBeNull();
  });

  it("flags ssh private keys, credential files and key stores", () => {
    expect(contentNameReason("id_rsa", false)).toBe("contains an ssh private key");
    expect(contentNameReason("id_ed25519", false)).toBe("contains an ssh private key");
    expect(contentNameReason("id_rsa.pub", false)).toBeNull();
    expect(contentNameReason(".netrc", false)).toBe("contains a credential file");
    expect(contentNameReason(".pgpass", false)).toBe("contains a credential file");
    expect(contentNameReason("vault.kdbx", false)).toBe("contains a key or credential store");
    expect(contentNameReason("cert.p12", false)).toBe("contains a key or credential store");
    expect(contentNameReason("cert.pfx", false)).toBe("contains a key or credential store");
    expect(contentNameReason("login.keychain-db", false)).toBe("contains a key or credential store");
  });

  it("flags database data-dir markers", () => {
    for (const m of ["PG_VERSION", "ibdata1", "WiredTiger", "WiredTiger.wt", "mongod.lock", "postmaster.pid"]) {
      expect(contentNameReason(m, false), m).toBe("looks like a database data directory");
    }
  });

  it("strict mode additionally rejects key material and secret-named files", () => {
    for (const n of ["server.pem", "tls.key", "app.keystore", "credentials", "credentials.json", "secrets.yml", "secret", ".npmrc", ".pypirc"]) {
      expect(contentNameReason(n, true), n).not.toBeNull();
      expect(contentNameReason(n, false), n).toBeNull();
    }
    expect(contentNameReason("server.pem", true)).toBe("contains key material");
    expect(contentNameReason("secrets.yml", true)).toBe("contains a file named like a secret");
  });

  it("strict mode does not flag ordinary names", () => {
    for (const n of ["index.js", "package.json", "keyboard.js", "monkey.txt", "secretary.md", "pemfile.txt"]) {
      expect(contentNameReason(n, true), n).toBeNull();
    }
  });
});
