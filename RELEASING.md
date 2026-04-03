# Releasing

Use the release helper script to create and push annotated tags in a consistent format.

## Tag format

- `server-vX.Y.Z`
- `client-vX.Y.Z`

These tags match the GitHub Actions workflows:

- `.github/workflows/release-server.yml` triggers on `server-v*`
- `.github/workflows/release-client.yml` triggers on `client-v*`

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
3. Creates annotated tag(s).
4. Pushes current branch.
5. Pushes tag(s).
