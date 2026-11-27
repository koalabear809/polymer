#!/bin/sh
# Usage: scripts/release.sh 0.2.0
# Sets the version in src-tauri/Cargo.toml, commits, tags v0.2.0 and pushes. GitHub Actions
# then builds every platform and attaches the builds to a draft release (see RELEASING.md).
set -eu

[ $# -eq 1 ] || { echo "usage: $0 <version>   e.g. $0 0.2.0" >&2; exit 1; }
v="${1#v}"
echo "$v" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "version must look like 1.2.3" >&2; exit 1; }
cd "$(dirname "$0")/.."

[ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first." >&2; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "Release from the main branch." >&2; exit 1; }
git rev-parse "v$v" >/dev/null 2>&1 && { echo "Tag v$v already exists." >&2; exit 1; }

old=$(grep -m1 '^version' src-tauri/Cargo.toml | sed 's/.*"\(.*\)".*/\1/')
echo "Releasing $old -> $v"
printf 'Tag and push v%s? [y/N] ' "$v"
read -r answer
[ "$answer" = y ] || { echo "Cancelled."; exit 1; }

sed -i.bak "0,/^version = \".*\"/s//version = \"$v\"/" src-tauri/Cargo.toml && rm -f src-tauri/Cargo.toml.bak
(cd src-tauri && cargo update -p polymer --offline >/dev/null 2>&1 || cargo check -q)
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -q -m "Release v$v"
git tag "v$v"
git push origin main "v$v"
echo "Pushed. Watch the build: gh run watch   (then publish the draft release on GitHub)"
