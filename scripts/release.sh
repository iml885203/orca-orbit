#!/bin/sh
# Release the plugin: scripts/release.sh <version>, for example scripts/release.sh 0.1.2.
#
# The community catalog lists a release from its `v<version>` tag, and it never accepts a moved
# tag: once a version is pushed, it is final. So every check runs before anything is committed,
# and the commit and the tag are pushed together or not at all.
set -eu

version=${1:-}
tag="v$version"
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "usage: scripts/release.sh <major.minor.patch>" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."

fail() { echo "release: $*" >&2; exit 1; }

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || fail "check out main first"
[ -z "$(git status --porcelain)" ] || fail "commit or stash your changes first"
git fetch --quiet origin --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "main is not at origin/main; pull or push first"
git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null && fail "$tag already exists, and released tags never move"

# The catalog rejects a plugin without a licence.
[ -f LICENSE ] || fail "LICENSE is missing"
node -e 'const m = require("./orca-plugin.json"); if (!m.license) process.exit(1)' || fail "orca-plugin.json has no \"license\""

orca plugin test . >/dev/null || fail "tests failed; run: orca plugin test ."

node -e '
  const fs = require("fs")
  const m = JSON.parse(fs.readFileSync("orca-plugin.json", "utf8"))
  m.version = process.argv[1]
  fs.writeFileSync("orca-plugin.json", JSON.stringify(m, null, 2) + "\n")
' "$version"

# Validate the manifest as it will be tagged, and undo the bump if it is invalid.
orca plugin validate . >/dev/null || { git checkout -- orca-plugin.json; fail "invalid plugin; run: orca plugin validate ."; }

git commit --quiet -m "Release $version" -- orca-plugin.json
git tag -a "$tag" -m "$tag"

printf 'Push %s and main to origin? This publishes it. [y/N] ' "$tag"
read -r answer
if [ "$answer" != y ]; then
  git tag -d "$tag" >/dev/null
  git reset --quiet --hard HEAD~1
  fail "not pushed; the release commit and tag were removed"
fi

git push --atomic origin main "$tag"
echo "Released $tag. Listing status: https://www.onorca.dev/plugins/iml885203/orca-orbit"
