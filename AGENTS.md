# Rules for agents working in this repository

- **NEVER build or push the Docker image locally** (`docker build`, `docker buildx`,
  `docker push`, `docker compose build`). The multi-arch image
  (`paulomcnally/presence-ihost`) is built and published **only** by the GitHub
  Actions workflow `.github/workflows/docker-image.yml`, which runs automatically
  when a `v*` tag is pushed. Do not suggest, run, or document local image builds.
- Releases are cut with `./release.sh vX.Y.Z` (creates the tag + GitHub release;
  CI then builds the image). Never create tags or releases manually via git/gh
  unless explicitly asked.
- Local Go and frontend builds (`go build`, `npm run build`) are fine for
  development and testing; they are not a substitute for the release image.
- If you need to inspect the image, use `docker pull paulomcnally/presence-ihost`.
- If Docker Hub credentials are required, they live as repository secrets
  (`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`) for CI use only.