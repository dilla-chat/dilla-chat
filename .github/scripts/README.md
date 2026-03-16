# GitHub Scripts

This directory contains utility scripts for managing the dilla-chat repository.

## Scripts

### `list-claude-issues.sh`

Lists issues that were built or fixed by Claude (via auto-fix workflow or direct Claude Code intervention).

**Requirements:**
- [GitHub CLI (`gh`)](https://cli.github.com/) must be installed and authenticated

**Usage:**
```bash
# List all open Claude-related issues
./list-claude-issues.sh

# List closed issues
./list-claude-issues.sh --state closed

# List everything (open and closed)
./list-claude-issues.sh --state all

# Get JSON output for programmatic processing
./list-claude-issues.sh --format json
```

**Options:**
- `--state open|closed|all` - Filter by issue state (default: open)
- `--format json|text` - Output format (default: text)
- `--help` - Show help message

**Output:**
The script shows:
- All issues with the `auto-fix` label (created by GitHub Actions when CI fails)
- All PRs authored by Claude
- Which issues each PR fixes

### `list-claude-issues.py`

Python demonstration script showing how to query GitHub for Claude-related issues and PRs. This is a reference implementation that shows the data structures and logic for tracking Claude's work.

**Requirements:**
- Python 3.6+
- For actual API calls: `PyGithub` library (`pip install PyGithub`)

**Usage:**
```bash
# Run the demonstration
python3 list-claude-issues.py

# With different options
python3 list-claude-issues.py --state all --format json
```

## See Also

- [CLAUDE_TRACKING.md](../CLAUDE_TRACKING.md) - Complete documentation on tracking Claude's work
- [AUTO_FIX.md](../AUTO_FIX.md) - Documentation on the auto-fix workflow
