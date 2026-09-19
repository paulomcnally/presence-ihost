#!/usr/bin/env bash
# Release a new version: creates a git tag + GitHub release.
#
# Pushing the tag triggers the GitHub Actions workflow
# (.github/workflows/docker-image.yml) which builds and pushes the
# multi-arch Docker image. Do NOT build the image locally.
#
# Usage:
#   ./release.sh v0.2.1
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version>" >&2
  echo "  e.g. $0 v0.2.1" >&2
  exit 1
fi

if ! [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must look like vX.Y.Z (e.g. v0.2.1)" >&2
  exit 1
fi

if git tag --list "$VERSION" | grep -q .; then
  echo "error: tag $VERSION already exists" >&2
  exit 1
fi

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