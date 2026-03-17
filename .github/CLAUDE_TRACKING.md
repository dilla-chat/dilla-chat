# Tracking Issues Built/Fixed by Claude

This document explains how to identify and track issues that were built or fixed by Claude, either through the auto-fix workflow or through direct Claude Code intervention.

## Overview

Issues and PRs related to Claude fall into two categories:

1. **Auto-fix issues**: Issues automatically created by the CI workflow when builds/tests/lint fail, labeled with `auto-fix`
2. **Claude PRs**: Pull requests created by Claude Code to fix issues or implement features

## Quick Start

Use the provided script to list all Claude-related issues and PRs:

```bash
# List all open issues/PRs related to Claude
.github/scripts/list-claude-issues.sh

# List all closed issues/PRs
.github/scripts/list-claude-issues.sh --state closed

# List everything (open and closed)
.github/scripts/list-claude-issues.sh --state all

# Get JSON output for programmatic processing
.github/scripts/list-claude-issues.sh --format json
```

## Identifying Issues Built/Fixed by Claude

### Method 1: Using the Script

The easiest way is to use `.github/scripts/list-claude-issues.sh`:

```bash
cd .github/scripts
./list-claude-issues.sh
```

This will show:
- All issues with the `auto-fix` label (created by GitHub Actions when CI fails)
- All PRs authored by Claude
- Which issues each PR fixes

### Method 2: Using GitHub CLI (gh)

#### List auto-fix issues:
```bash
# Open auto-fix issues
gh issue list --label "auto-fix" --state open

# All auto-fix issues (open and closed)
gh issue list --label "auto-fix" --state all

# Get detailed JSON
gh issue list --label "auto-fix" --state all --json number,title,state,labels,createdAt,closedAt,url
```

#### List Claude PRs:
```bash
# Open PRs by Claude
gh pr list --author "Claude" --state open

# All PRs by Claude (open, closed, merged)
gh pr list --author "Claude" --state all

# Get detailed JSON including which issues they fix
gh pr list --author "Claude" --state all --json number,title,state,url,body,mergedAt
```

### Method 3: Using GitHub Web UI

#### Find auto-fix issues:
1. Go to the [Issues page](https://github.com/dilla-chat/dilla-chat/issues)
2. Click on "Labels" and select `auto-fix`
3. Or use this search query: `is:issue label:auto-fix`

#### Find Claude PRs:
1. Go to the [Pull Requests page](https://github.com/dilla-chat/dilla-chat/pulls)
2. Use this search query: `is:pr author:app/anthropic-code-agent`
3. Or filter by author: `Claude`

### Method 4: Using GitHub API

#### Get auto-fix issues:
```bash
curl -H "Authorization: token YOUR_TOKEN" \
  "https://api.github.com/repos/dilla-chat/dilla-chat/issues?labels=auto-fix&state=all"
```

#### Get Claude PRs:
```bash
# Note: Claude's GitHub user ID is 242468646
curl -H "Authorization: token YOUR_TOKEN" \
  "https://api.github.com/repos/dilla-chat/dilla-chat/pulls?state=all" \
  | jq '.[] | select(.user.id == 242468646)'
```

## Understanding the Workflow

### Auto-Fix Workflow

1. **CI Detects Failure**
   - CI workflow runs on push to main or on PRs
   - Detects lint, build, or test failures
   - Creates an issue with:
     - Title: `[Auto-fix] {Type} {Component} {error type}`
     - Labels: `auto-fix`, plus specific labels like `lint`, `build`, `test`, `client`, `server`
     - Body: Contains error output and workflow link

2. **Auto-Fix Workflow Triggers**
   - Triggered when issue is created/labeled with `auto-fix`
   - Creates branch: `auto-fix/issue-{number}`
   - Attempts automatic fixes based on labels:
     - `lint`: Runs `npm run lint --fix` and `npm run format`
     - `build`: Reinstalls dependencies, runs `cargo build`
     - `test`: Updates dependencies and reruns tests

3. **PR Creation**
   - If fixes were made, creates PR with:
     - Title: `Auto-fix: {original issue title}`
     - Body: Links to issue with "Closes #{issue-number}"
     - Comments on issue with PR number

### Claude Code Workflow

1. **Issue Assignment**
   - User assigns an issue to Claude or creates a new issue for Claude to work on
   - Or user directly asks Claude Code to implement something

2. **Claude Creates PR**
   - Claude creates a branch (usually `claude/{descriptive-name}`)
   - Implements the fix or feature
   - Creates PR with:
     - Detailed description
     - Links to related issues using "Fixes #{issue-number}" or "Closes #{issue-number}"
     - User: "Claude" (ID: 242468646)

3. **Review and Merge**
   - Human reviews the PR
   - Merges if changes are correct
   - Issue automatically closes when PR is merged

## Label System

### Primary Labels

- **`auto-fix`**: Triggers the auto-fix workflow; indicates the issue was automatically detected
- **`manual-intervention`**: Indicates the auto-fix workflow couldn't fix the issue automatically

### Issue Type Labels

- **`lint`**: Linting/code style issues
- **`build`**: Build failures
- **`test`**: Test failures

### Component Labels

- **`client`**: Client-side (React/TypeScript) issues
- **`server`**: Server-side (Rust) issues
- **`release`**: Issues from the release workflow

## Tracking Issue Resolution

### Check if an Issue Was Fixed by Claude

1. **Via the script:**
   ```bash
   .github/scripts/list-claude-issues.sh --state closed
   ```

2. **Via GitHub CLI:**
   ```bash
   # Find PRs that closed a specific issue
   gh pr list --search "fixes #4 OR closes #4" --state all --author "Claude"
   ```

3. **Via GitHub Web UI:**
   - Open the issue
   - Check the "Linked pull requests" section
   - Look for PRs authored by Claude

### Check Success Rate

```bash
# Total auto-fix issues
gh issue list --label "auto-fix" --state all --json number --jq 'length'

# Closed auto-fix issues
gh issue list --label "auto-fix" --state closed --json number --jq 'length'

# Calculate success rate
echo "scale=2; $(gh issue list --label "auto-fix" --state closed --json number --jq 'length') / $(gh issue list --label "auto-fix" --state all --json number --jq 'length') * 100" | bc
```

## Examples

### Example 1: List All Issues Claude Has Fixed

```bash
# Get all closed issues with auto-fix label
.github/scripts/list-claude-issues.sh --state closed

# Or using gh directly
gh issue list --label "auto-fix" --state closed
```

### Example 2: Find Which Issues a Specific PR Fixed

```bash
# Get PR #7 details
gh pr view 7 --json body,title,state,mergedAt

# Extract issue numbers from the PR body
gh pr view 7 --json body --jq '.body' | grep -oP '(?:Closes?|Fixes?|Resolves?) #\K\d+'
```

### Example 3: Generate a Report of Claude's Work

```bash
# Generate JSON report
.github/scripts/list-claude-issues.sh --state all --format json > claude-report.json

# Pretty print statistics
echo "Claude Activity Report"
echo "====================="
echo ""
echo "Auto-fix Issues:"
jq '.autofix_issues | length' claude-report.json
echo ""
echo "Claude PRs:"
jq '.claude_prs | length' claude-report.json
```

## Integration with Other Tools

### CI/CD Pipeline

You can integrate the script into your CI/CD pipeline:

```yaml
- name: Report Claude activity
  run: |
    .github/scripts/list-claude-issues.sh --state all --format json > claude-activity.json

- name: Upload artifact
  uses: actions/upload-artifact@v4
  with:
    name: claude-activity-report
    path: claude-activity.json
```

### Metrics Dashboard

Use the JSON output to build metrics:

```bash
# Get metrics
metrics=$(cat <<EOF
{
  "total_autofix_issues": $(gh issue list --label "auto-fix" --state all --json number --jq 'length'),
  "closed_autofix_issues": $(gh issue list --label "auto-fix" --state closed --json number --jq 'length'),
  "open_autofix_issues": $(gh issue list --label "auto-fix" --state open --json number --jq 'length'),
  "total_claude_prs": $(gh pr list --author "Claude" --state all --json number --jq 'length'),
  "merged_claude_prs": $(gh pr list --author "Claude" --state merged --json number --jq 'length'),
  "open_claude_prs": $(gh pr list --author "Claude" --state open --json number --jq 'length')
}
EOF
)

echo "$metrics" | jq '.'
```

## Troubleshooting

### Script Shows No Results

1. Verify GitHub CLI is installed: `gh --version`
2. Verify authentication: `gh auth status`
3. Verify repository access: `gh repo view dilla-chat/dilla-chat`

### Wrong Repository

Set the repository explicitly:

```bash
export GITHUB_REPOSITORY="dilla-chat/dilla-chat"
.github/scripts/list-claude-issues.sh
```

Or use gh with repo flag:

```bash
gh issue list --repo dilla-chat/dilla-chat --label "auto-fix"
```

## See Also

- [AUTO_FIX.md](.github/AUTO_FIX.md) - Documentation on the auto-fix workflow
- [CI Workflow](.github/workflows/ci.yml) - The CI workflow that creates issues
- [Auto-Fix Workflow](.github/workflows/auto-fix.yml) - The workflow that attempts fixes
