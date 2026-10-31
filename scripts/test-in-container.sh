#!/bin/sh
# Installs, typechecks, runs every layer of the test suite and the coverage report inside a
# throwaway container (non-root, no host HOME). Nothing runs on the host. Needs docker and network
# for `npm ci` only; the tests themselves need no network.
#   IMAGE=node:22 sh scripts/test-in-container.sh        # default
#   IMAGE=node:24 sh scripts/test-in-container.sh
# The image needs git (the official full node images have it).
set -eu
IMAGE=${IMAGE:-node:22}
cd "$(dirname "$0")/.."
VOL=disk-janitor-node-modules-$(echo "$IMAGE" | tr ':/' '--')
docker volume create "$VOL" >/dev/null
docker run --rm -u 0 -v "$VOL:/nm" "$IMAGE" chown "$(id -u):$(id -g)" /nm >/dev/null
exec docker run --rm --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
  -e HOME=/tmp/home -e npm_config_cache=/tmp/npm-cache -e npm_config_update_notifier=false \
  -v "$PWD:/work" -v "$VOL:/work/node_modules" -w /work "$IMAGE" sh -c '
    npm ci --ignore-scripts &&
    npm run typecheck &&
    npm run test:layers &&
    npm run coverage &&
    npm run build'
