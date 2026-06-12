# Agent Instructions

## Tech Stack

- Electron + React + TypeScript
- Package manager: pnpm

## Release Process

When asked to release a new version, follow these steps **in order**:

1. **Check for uncommitted changes** — run `git status`. If there are any staged or unstaged changes (including untracked files that should be tracked), commit them with an appropriate message before proceeding.
2. **Bump the version** — update the `"version"` field in `package.json`. Use semver: patch for fixes, minor for features, major for breaking changes. If the user specifies a version, use that instead.
3. **Commit the version bump** — commit with message `chore: bump version to <new-version>`.
4. **Tag the release** — create an annotated git tag: `git tag v<new-version>`.
5. **Push to remote** — push the commit and tag: `git push && git push --tags`.
