#!/bin/sh
# End-to-end demo of the real CLI against a throwaway fake HOME under /tmp.
# Run it only inside a disposable container or VM: it creates and quarantines directories,
# but only below $DEMO (never your real home). Needs a built dist/ (npm run build), git and `script`.
set -eu

DEMO=${DEMO:-/tmp/dj-demo}
CLI="node $(pwd)/dist/bin.js"
case "$DEMO" in /tmp/*) ;; *) echo "refusing: DEMO must be under /tmp" >&2; exit 2 ;; esac
rm -rf "$DEMO"
mkdir -p "$DEMO/home/projects" "$DEMO/home/Documents" "$DEMO/home/.ssh"
export HOME="$DEMO/home"
export GIT_AUTHOR_NAME=demo GIT_AUTHOR_EMAIL=demo@example.invalid GIT_COMMITTER_NAME=demo GIT_COMMITTER_EMAIL=demo@example.invalid
P="$HOME/projects"

blob() { head -c "$2" /dev/zero > "$1"; }
age() { find "$1" -exec touch -h -d '90 days ago' {} +; }

# 1. stale project in a clean git repo: node_modules and dist are ignored
mkdir -p "$P/webapp/src" "$P/webapp/node_modules/left-pad" "$P/webapp/dist"
printf '{"name":"webapp","version":"1.0.0"}\n' > "$P/webapp/package.json"
printf '{"lockfileVersion":3}\n' > "$P/webapp/package-lock.json"
printf 'node_modules\ndist\n' > "$P/webapp/.gitignore"
echo 'console.log(1)' > "$P/webapp/src/index.js"
blob "$P/webapp/node_modules/left-pad/index.js" 3145728
blob "$P/webapp/dist/bundle.js" 2097152
(cd "$P/webapp" && git init -q -b main && git add -A && git commit -q -m init)
age "$P/webapp"

# 2. stale project with no git
mkdir -p "$P/old-api/node_modules/express" "$P/old-api/target/debug"
printf '{"name":"old-api"}\n' > "$P/old-api/package.json"
printf 'lockfileVersion: 9\n' > "$P/old-api/pnpm-lock.yaml"
printf '[package]\nname = "old-api"\n' > "$P/old-api/Cargo.toml"
blob "$P/old-api/node_modules/express/index.js" 2621440
blob "$P/old-api/target/debug/app" 4194304
age "$P/old-api"

# 3. project with uncommitted work: must be skipped
mkdir -p "$P/wip/node_modules/dep"
printf '{"name":"wip"}\n' > "$P/wip/package.json"
printf '{"lockfileVersion":3}\n' > "$P/wip/package-lock.json"
printf 'node_modules\n' > "$P/wip/.gitignore"
blob "$P/wip/node_modules/dep/index.js" 2097152
(cd "$P/wip" && git init -q -b main && git add -A && git commit -q -m init && echo 'half-written' > notes.txt)
age "$P/wip"

# 4. recently used project: must be skipped
mkdir -p "$P/fresh/node_modules/dep"
printf '{"name":"fresh"}\n' > "$P/fresh/package.json"
printf '{"lockfileVersion":3}\n' > "$P/fresh/package-lock.json"
blob "$P/fresh/node_modules/dep/index.js" 2097152

# 5. attack: node_modules is a symlink to a directory that must never be touched
mkdir -p "$P/trap" "$DEMO/victim"
printf '{"name":"trap"}\n' > "$P/trap/package.json"
printf '{"lockfileVersion":3}\n' > "$P/trap/package-lock.json"
echo precious > "$DEMO/victim/keep.txt"
ln -s "$DEMO/victim" "$P/trap/node_modules"

# 6. python project with a cache
mkdir -p "$P/pylib/pkg/__pycache__"
printf '[project]\nname = "pylib"\n' > "$P/pylib/pyproject.toml"
echo 'x = 1' > "$P/pylib/pkg/mod.py"
blob "$P/pylib/pkg/__pycache__/mod.cpython-312.pyc" 2097152
age "$P/pylib"

# 7. package-manager cache below the home directory
mkdir -p "$HOME/.npm/_cacache/content-v2"
blob "$HOME/.npm/_cacache/content-v2/blob" 5242880
age "$HOME/.npm"

# tripwires that must survive everything
echo "tax records" > "$HOME/Documents/taxes.txt"
echo "-----fake key material-----" > "$HOME/.ssh/id_demo"

run() { echo; echo "\$ disk-janitor $*"; $CLI "$@"; }
OPTS="--root $P --home $HOME --caches --state-dir $DEMO/state"

run scan $OPTS
run scan $OPTS --verbose --json >/dev/null
run plan $OPTS
PLAN=$(ls "$DEMO/state/plans" | sed 's/\.json$//')
DIGEST=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).digest)' "$DEMO/state/plans/$PLAN.json")
run explain "$PLAN" --state-dir "$DEMO/state"

echo; echo "# an agent (no terminal) cannot approve:"
run approve "$PLAN" --state-dir "$DEMO/state" </dev/null || true
echo; echo "# and apply without approval is refused:"
run apply "$PLAN" $OPTS || true

echo; echo "# a human types the digest prefix at a real terminal (pty provided by script(1)):"
echo "\$ disk-janitor approve $PLAN"
printf '%s\n' "$(echo "$DIGEST" | cut -c1-8)" | script -qec "$CLI approve $PLAN --state-dir $DEMO/state" /dev/null | tr -d '\r'

run apply "$PLAN" $OPTS
run status --state-dir "$DEMO/state"
echo; echo "# the approval was single-use, so the same plan cannot be applied again:"
run apply "$PLAN" $OPTS || true

echo; echo "# undo one item by path:"
run restore "$P/webapp/node_modules" --state-dir "$DEMO/state"
echo; echo "# what would a purge delete? (TTL 0 only for this demo; the default is 7 days)"
run purge --state-dir "$DEMO/state" --ttl-days 0 --dry-run
echo; echo "# purge is human-only as well: without a terminal it refuses"
run purge --state-dir "$DEMO/state" --ttl-days 0 </dev/null || true
CODE=$($CLI purge --state-dir "$DEMO/state" --ttl-days 0 --dry-run | sed -n 's/.*real purge: \([0-9a-f]*\)).*/\1/p')
echo; echo "# a human types the confirmation code at a real terminal:"
echo "\$ disk-janitor purge --ttl-days 0"
printf '%s\n' "$CODE" | script -qec "$CLI purge --state-dir $DEMO/state --ttl-days 0" /dev/null | tr -d '\r'
run status --state-dir "$DEMO/state"
echo; echo "# the audit log (first 160 columns of each line) and its chain check:"
run audit --state-dir "$DEMO/state" 2>&1 | cut -c1-160 | tail -n 8
run doctor --state-dir "$DEMO/state" --root "$P"
echo; echo "# tripwires (must all still be there):"
cat "$HOME/Documents/taxes.txt" "$HOME/.ssh/id_demo" "$DEMO/victim/keep.txt"
ls "$P/webapp"
