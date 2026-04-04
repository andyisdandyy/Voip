# Releasing

Use the release helper script to create and push annotated tags in a consistent format.

## Tag format

- `vX.Y.Z`

This tag matches the GitHub Actions workflows:

- `.github/workflows/release-server.yml` triggers on `v*`
- `.github/workflows/release-client.yml` triggers on `v*`

## Usage

Run from the repository root:

```powershell
.\scripts\release.ps1 <server|client|both> <X.Y.Z>
```

Examples:

```powershell
.\scripts\release.ps1 server 1.2.3
.\scripts\release.ps1 client 1.2.3
.\scripts\release.ps1 both 1.2.3
```

Optional flags:

- `-CommitMessage "..."` stages and commits all current changes before tagging.
- `-AllowDirty` allows running with uncommitted changes (not recommended).
- `-DryRun` prints git commands without executing them.
- `-Remote origin` changes which remote is pushed.

## What the script does

1. Validates semver input (`X.Y.Z`) and repository state.
2. Verifies tag does not already exist locally or on the remote.
3. Creates annotated tag `vX.Y.Z`.
4. Pushes current branch.
5. Pushes the tag.

## Why `server|client|both` still exists

To preserve command compatibility, all three targets currently map to the same shared tag (`vX.Y.Z`) so server and client artifacts land in one GitHub Release.
