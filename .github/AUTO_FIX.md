# Automated Issue Detection and Fixing

This repository includes automated GitHub Actions workflows that detect issues and attempt to fix them automatically.

## How It Works

### 1. Continuous Integration (CI) Workflow

The CI workflow (`.github/workflows/ci.yml`) runs on every push to `main` and on pull requests. It:

- **Client Checks**:
  - Runs ESLint to check for code quality issues
  - Builds the client to ensure it compiles successfully

- **Server Checks**:
  - Runs Rust tests to ensure functionality
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

### 2. Claude Auto-Fix Workflow (Primary)

The Claude auto-fix workflow (`.github/workflows/claude-auto-fix.yml`) triggers when an issue is created or labeled with `auto-fix`. It:

1. **Assigns to Claude Code**: Automatically assigns the issue to Claude Code agent (the AI)
2. **Notifies Claude**: Adds a comment mentioning @Claude to trigger the intelligent fix
3. **Adds Tracking Label**: Labels issue with `claude-notified` for tracking
4. **Claude Creates PR**: Claude Code analyzes the issue and creates an intelligent PR with the fix

**This is the preferred method** as Claude Code can:
- Understand complex code changes
- Write proper fixes for logic errors
- Add comprehensive tests
- Follow project conventions from CLAUDE.md

### 2.5. Fallback Auto-Fix Workflow

The fallback auto-fix workflow (`.github/workflows/auto-fix.yml`) provides simple scripted fixes:

1. **Creates a Fix Branch**: Creates a new branch named `auto-fix/issue-{number}`

2. **Attempts Automatic Fixes**:
   - **Lint issues**: Runs `npm run lint --fix` and `npm run format`
   - **Build issues**:
     - Client: Reinstalls dependencies and rebuilds
     - Server: Runs `cargo build` and rebuilds
   - **Test issues**: Updates dependencies and reruns tests

3. **Creates a Pull Request**:
   - If changes were made, commits them and creates a PR
   - Links the PR to the issue with "Closes #{issue-number}"
   - Comments on the issue with the PR number

4. **Reports Status**:
   - If no fixes were possible, comments on the issue that manual intervention is needed

**Note**: The fallback workflow can handle simple mechanical fixes, but Claude Code is preferred for intelligent problem-solving.

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
3. **Claude auto-fix workflow triggers** → Assigns issue to @Claude and notifies the AI agent
4. **Claude analyzes** → Claude Code reads the error, understands the codebase from CLAUDE.md
5. **Claude creates PR** → Intelligent fix with proper code, tests, and documentation
6. **Developer reviews** → Merges the PR if the fix is correct
7. **Issue closes** → Automatically when PR is merged

**Alternative flow** (if Claude is unavailable):
- Fallback workflow runs scripted fixes (`npm run lint --fix`)
- Creates PR with mechanical fixes if any changes made

## Configuration

### Labels

Make sure the following labels exist in your repository:
- `auto-fix` - Triggers the auto-fix workflow
- `claude-notified` - Indicates Claude Code has been notified
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

## Tracking Issues Built/Fixed by Claude

To identify and track which issues were built or fixed by Claude:

1. **Use the provided script:**
   ```bash
   .github/scripts/list-claude-issues.sh --state all
   ```

2. **Use GitHub CLI directly:**
   ```bash
   gh issue list --label "auto-fix"        # Auto-fix issues
   gh pr list --author "Claude"            # Claude PRs
   ```

3. **Use GitHub Web UI:**
   - Issues: Search for `is:issue label:auto-fix`
   - PRs: Search for `is:pr author:app/anthropic-code-agent`

For complete documentation on tracking Claude's work, see [CLAUDE_TRACKING.md](CLAUDE_TRACKING.md).

## Security Considerations

- The auto-fix workflow has write access to the repository
- All auto-generated PRs should be reviewed before merging
- Consider requiring reviews for auto-fix PRs
- Monitor for any unexpected behavior or security issues

## Claude Code Integration

The repository now uses **Claude Code** (Anthropic's AI agent) as the primary fix mechanism:

### How it Works

1. When an issue with `auto-fix` label is created, the `claude-auto-fix.yml` workflow:
   - Assigns the issue to @Claude (the AI agent)
   - Adds a comment mentioning @Claude to notify it
   - Labels the issue with `claude-notified` for tracking

2. Claude Code (via the Anthropic GitHub App) then:
   - Reads the issue description and error output
   - Analyzes the codebase using context from `CLAUDE.md`
   - Creates an intelligent fix that follows project conventions
   - Opens a PR that references the issue with "Fixes #X"
   - Adds proper tests and documentation

### Benefits of Claude Code vs Scripted Fixes

| Feature | Claude Code | Scripted Fixes |
|---------|-------------|----------------|
| **Complex logic errors** | ✅ Can understand and fix | ❌ Cannot handle |
| **Following conventions** | ✅ Reads CLAUDE.md | ❌ Generic fixes only |
| **Adding tests** | ✅ Can add comprehensive tests | ❌ No test generation |
| **Context awareness** | ✅ Understands full codebase | ❌ Runs predefined commands |
| **Breaking API changes** | ✅ Can adapt code | ❌ Cannot handle |
| **Documentation** | ✅ Updates docs as needed | ❌ No doc updates |

### Setting up Claude Code

To enable Claude Code in your repository:

1. **Install the Anthropic Claude Code GitHub App** on your repository
2. **Ensure Claude is added as a collaborator** (may happen automatically with the app)
3. **The workflow will automatically notify Claude** when issues are created

### Fallback Mechanism

If Claude Code is unavailable or doesn't respond, the fallback `auto-fix.yml` workflow provides basic scripted fixes:
- Lint fixes: `npm run lint --fix`
- Dependency issues: Reinstall/update dependencies
- Format fixes: `npm run format`

You can manually trigger the fallback by running the old workflow or by removing the `claude-notified` label.

### Monitoring Claude's Work

Track Claude's contributions using:
```bash
# See all issues Claude has been notified about
gh issue list --label "claude-notified"

# See PRs created by Claude
gh pr list --author "Claude"

# Use the tracking script
.github/scripts/list-claude-issues.sh --state all
```

For complete tracking documentation, see [CLAUDE_TRACKING.md](CLAUDE_TRACKING.md).
