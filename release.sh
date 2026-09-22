#!/usr/bin/env bash
# Release a new version: creates a git tag + GitHub release.
#
# Pushing the tag triggers the GitHub Actions workflow
# (.github/workflows/docker-image.yml) which builds and pushes the
# multi-arch Docker image. Do NOT build the image locally.
#
# Usage:
#   ./release.sh            # auto: next patch version from the last published image
#   ./release.sh v0.2.1     # optional: explicit version
set -euo pipefail

VERSION="${1:-}"

# next_version_from_hub: prints the next patch version (vX.Y.(Z+1)) computed
# from the highest semver tag currently published on Docker Hub, or nothing.
next_version_from_hub() {
  command -v curl >/dev/null 2>&1 || return 1
  command -v python3 >/dev/null 2>&1 || return 1
  curl -fsSL "https://hub.docker.com/v2/repositories/paulomcnally/presence-ihost/tags?page_size=100" 2>/dev/null \
    | python3 -c 'import sys, json, re
pat = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
tags = (t["name"] for t in json.load(sys.stdin).get("results", []))
vs = sorted((tuple(map(int, m.groups())) for t in tags if (m := pat.match(t))), reverse=True)
if vs:
    ma, mi, pa = vs[0]
    print(f"v{ma}.{mi}.{pa + 1}")' 2>/dev/null || true
}

# next_version_from_git: prints the next patch version after the highest semver
# tag in the repository, or nothing.
next_version_from_git() {
  LAST="$(git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)"
  if [[ -n "$LAST" ]]; then
    python3 -c 'import sys, re
ma, mi, pa = map(int, re.match(r"v(\d+)\.(\d+)\.(\d+)", sys.argv[1]).groups())
print(f"v{ma}.{mi}.{pa + 1}")' "$LAST" 2>/dev/null || true
  fi
}

if ! command -v gh >/dev/null 2>&1; then
  echo "error: 'gh' CLI is required to create the GitHub release" >&2
  exit 1
fi

if ! git diff --quiet HEAD; then
  echo "error: working tree is not clean; commit or stash changes first" >&2
  exit 1
fi

if [[ "$(git symbolic-ref --short HEAD)" != "main" ]]; then
  echo "error: releases must be cut from 'main'" >&2
  exit 1
fi

git fetch origin --tags --quiet
if [[ "$(git rev-parse "origin/main" 2>/dev/null || true)" != "$(git rev-parse HEAD)" ]]; then
  echo "error: local HEAD is not in sync with origin/main; pull first" >&2
  exit 1
fi

# Resolve the version to cut.
if [[ -n "$VERSION" ]]; then
  if ! [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: version must look like vX.Y.Z (e.g. v0.2.1)" >&2
    exit 1
  fi
else
  VERSION="$(next_version_from_hub)"
  if [[ -z "$VERSION" ]]; then
    echo "warning: could not query Docker Hub, falling back to git tags" >&2
    VERSION="$(next_version_from_git)"
  fi
  if [[ -z "$VERSION" ]]; then
    VERSION="v0.1.0"
  fi
  echo "No version given: derived $VERSION from the last published image."
fi

if git tag --list "$VERSION" | grep -q .; then
  echo "error: tag $VERSION already exists" >&2
  exit 1
fi

git tag "$VERSION"
git push origin "$VERSION"

PREVIOUS="$(git describe --tags --abbrev=0 "$VERSION^" 2>/dev/null || true)"

if [[ -n "$PREVIOUS" ]]; then
  NOTES="$(git log --oneline --no-decorate "$PREVIOUS..$VERSION" | sed 's/^/- /')"
else
  NOTES="- Initial release"
fi

gh release create "$VERSION" \
  --title "$VERSION" \
  --notes "Changes in this release:
$NOTES

The multi-arch Docker image is built and published automatically by GitHub Actions on this tag:
\`paulomcnally/presence-ihost:$VERSION\` (linux/arm/v7, linux/amd64)."

echo "Release $VERSION created: https://github.com/paulomcnally/presence-ihost/releases/tag/$VERSION"
echo "Docker image will be built automatically by CI (do NOT build locally)."