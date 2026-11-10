#!/bin/sh
# Makes patches/<name> again from its maker's release plus our edits (<name>.diff).
#   patches/remake.sh <name> <version> [out-dir]
# The release must be in cargo's registry (it is once any build has fetched it).
# After a move to a newer release: fix what the diff no longer fits, then write the
# diff again with `patches/remake.sh --diff <name> <version>`.
set -e
here=$(cd "$(dirname "$0")" && pwd)
extras='Cargo.toml.orig .cargo_vcs_info.json .cargo-ok Cargo.lock .cargo .github .gitignore CHANGELOG.md examples benches tests'
original() { ls -d "$HOME"/.cargo/registry/src/*/"$1-$2" | head -1; }

if [ "$1" = --diff ]; then
    cd "$(dirname "$(original "$2" "$3")")"
    command diff -ruN $(printf -- '-x %s ' $extras README.md) "$2-$3" "$here/$2" \
        | sed -e '/^diff /d' -e "s#^--- $2-$3/\([^\t]*\).*#--- a/\1#" -e "s#^+++ $here/$2/\([^\t]*\).*#+++ b/\1#" > "$here/$2.diff" || true
    exit 0
fi

out=${3:-$here/$1}
rm -rf "$out"
cp -r "$(original "$1" "$2")" "$out"
chmod -R u+w "$out"
cd "$out"
rm -rf $extras
# A README stays only where the library reads it at build time.
grep -q 'include_str!("../README.md")' src/lib.rs || rm -f README.md
patch -s -p1 --no-backup-if-mismatch < "$here/$1.diff"
