# Automated Issue Detection and Fixing

This repository includes automated GitHub Actions workflows that detect issues and attempt to fix them automatically.

## How It Works

### 1. Continuous Integration (CI) Workflow

The CI workflow (`.github/workflows/ci.yml`) runs on every push to `main` and on pull requests. It:

- **Client Checks**:
  - Runs ESLint to check for code quality issues
  - Builds the client to ensure it compiles successfully

- **Server Checks**:
  - Runs Go tests to ensure functionality
  - Builds the server binary

- **Issue Creation**:
  - If any check fails, automatically creates a GitHub issue with:
    - Descriptive title (e.g., "[Auto-fix] Client lint errors detected")
    - Full error output
    - Link to the failing workflow run
    - Labels: `auto-fix`, plus specific labels like `lint`, `build`, `test`, `client`, or `server`

### 1.5. Release Workflow

The Release workflow (`.github/workflows/release.yml`) runs when a version tag (e.g., `v1.0.0`) is pushed. It:

- **Client Build**:
  - Builds the web client for embedding in the server

- **Server Builds**:
  - Cross-compiles server binaries for multiple platforms (Linux, macOS, Windows)
  - Supports multiple architectures (amd64, arm64)

- **GitHub Release**:
  - Creates a GitHub release with all binaries
  - Generates SHA256 checksums

- **Issue Creation**:
  - If any build or release step fails, automatically creates a GitHub issue with:
    - Descriptive title (e.g., "[Auto-fix] Release: Client build failure")
    - Error details and workflow link
    - Labels: `auto-fix`, `build`, `release`, and specific component labels

### 2. Auto-Fix Workflow

The auto-fix workflow (`.github/workflows/auto-fix.yml`) triggers when an issue is created or labeled with `auto-fix`. It:

1. **Creates a Fix Branch**: Creates a new branch named `auto-fix/issue-{number}`

2. **Attempts Automatic Fixes**:
   - **Lint issues**: Runs `npm run lint --fix` and `npm run format`
   - **Build issues**:
     - Client: Reinstalls dependencies and rebuilds
     - Server: Runs `go mod tidy` and rebuilds
   - **Test issues**: Updates dependencies and reruns tests

3. **Creates a Pull Request**:
   - If changes were made, commits them and creates a PR
   - Links the PR to the issue with "Closes #{issue-number}"
   - Comments on the issue with the PR number

4. **Reports Status**:
   - If no fixes were possible, comments on the issue that manual intervention is needed

## Triggering Auto-Fix Manually

You can manually trigger the auto-fix workflow by:

1. Creating an issue with the `auto-fix` label
2. Adding the `auto-fix` label to an existing issue

Additional labels help the workflow understand what type of fix to attempt:
- `lint` - for linting issues
- `build` - for build failures
- `test` - for test failures
- `client` - for client-side issues
- `server` - for server-side issues

## Example

When a lint error is introduced:

1. **CI workflow runs** → Detects lint errors
2. **Issue created** → "[Auto-fix] Client lint errors detected" with labels `auto-fix`, `lint`, `client`
3. **Auto-fix workflow triggers** → Runs `npm run lint --fix`
4. **PR created** → Links back to the issue
5. **Developer reviews** → Merges the PR if the fix is correct
6. **Issue closes** → Automatically when PR is merged

## Configuration

### Labels

Make sure the following labels exist in your repository:
- `auto-fix` - Triggers the auto-fix workflow
- `lint` - Indicates linting issues
- `build` - Indicates build failures
- `test` - Indicates test failures
- `client` - Indicates client-side issues
- `server` - Indicates server-side issues
- `release` - Indicates issues from the release workflow
- `manual-intervention` - Indicates issues that likely require manual fixes

### Permissions

The workflows require the following permissions:
- `contents: write` - To create branches and commits
- `issues: write` - To create and comment on issues
- `pull-requests: write` - To create pull requests

## Limitations

The auto-fix workflow can handle:
- ✅ Simple linting errors that can be auto-fixed
- ✅ Missing or outdated dependencies
- ✅ Simple formatting issues

It cannot handle:
- ❌ Complex logic errors
- ❌ Breaking API changes
- ❌ Issues requiring architectural decisions
- ❌ Security vulnerabilities requiring careful review

For issues that cannot be auto-fixed, the workflow will comment on the issue indicating that manual intervention is required.

## Customization

To customize the auto-fix behavior:

1. Edit `.github/workflows/auto-fix.yml`
2. Add additional fix strategies in the appropriate sections
3. Consider the specific needs of your codebase (e.g., additional tools, custom scripts)

## Security Considerations

- The auto-fix workflow has write access to the repository
- All auto-generated PRs should be reviewed before merging
- Consider requiring reviews for auto-fix PRs
- Monitor for any unexpected behavior or security issues
