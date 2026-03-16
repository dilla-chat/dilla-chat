#!/usr/bin/env python3
"""
list-claude-issues.py
Lists issues that were built or fixed by Claude (via auto-fix workflow or direct Claude Code intervention)

Usage:
    python3 list-claude-issues.py [--state open|closed|all] [--format json|text]

Examples:
    python3 list-claude-issues.py                    # List all open Claude-related issues
    python3 list-claude-issues.py --state closed     # List closed issues
    python3 list-claude-issues.py --format json      # Output as JSON
"""

import argparse
import json
import re
import sys
from typing import Dict, List, Any

# This script demonstrates how to query GitHub for Claude-related issues and PRs
# In a real environment, you would use the GitHub API with requests or PyGithub

def extract_fixed_issues(pr_body: str) -> List[int]:
    """Extract issue numbers from PR body that are being fixed/closed"""
    if not pr_body:
        return []

    # Look for patterns like "Closes #123", "Fixes #123", "Resolves #123"
    pattern = r'(?:Closes?|Fixes?|Resolves?)\s+(?:#|jonasthim/dilla-chat#)(\d+)'
    matches = re.findall(pattern, pr_body, re.IGNORECASE)
    return [int(m) for m in matches]

def format_text_output(autofix_issues: List[Dict], claude_prs: List[Dict]) -> str:
    """Format output as human-readable text"""
    output = []
    output.append("=" * 80)
    output.append("Issues Built/Fixed by Claude")
    output.append("=" * 80)
    output.append("")

    # Auto-fix issues section
    output.append("─" * 80)
    output.append("Auto-Fix Issues (created by GitHub Actions, labeled 'auto-fix')")
    output.append("─" * 80)
    output.append("")

    if not autofix_issues:
        output.append("  No auto-fix issues found.")
    else:
        for issue in autofix_issues:
            output.append(f"  #{issue['number']} [{issue['state'].upper()}] {issue['title']}")
            labels = [label['name'] for label in issue.get('labels', [])]
            output.append(f"         Labels: {', '.join(labels)}")
            output.append(f"         URL: {issue['url']}")
            output.append("")

    output.append("")

    # Claude PRs section
    output.append("─" * 80)
    output.append("Pull Requests by Claude")
    output.append("─" * 80)
    output.append("")

    if not claude_prs:
        output.append("  No PRs by Claude found.")
    else:
        for pr in claude_prs:
            state = "MERGED" if pr.get('merged_at') else pr['state'].upper()
            output.append(f"  #{pr['number']} [{state}] {pr['title']}")
            output.append(f"         URL: {pr['url']}")

            # Extract and show fixed issues
            fixed_issues = extract_fixed_issues(pr.get('body', ''))
            if fixed_issues:
                output.append(f"         Fixes: {', '.join(f'#{num}' for num in fixed_issues)}")

            output.append("")

    output.append("")

    # Summary section
    output.append("=" * 80)
    output.append("Summary")
    output.append("=" * 80)
    output.append(f"  Auto-fix issues: {len(autofix_issues)}")
    output.append(f"  Claude PRs: {len(claude_prs)}")
    output.append("")

    return "\n".join(output)

def format_json_output(autofix_issues: List[Dict], claude_prs: List[Dict]) -> str:
    """Format output as JSON"""
    # Add extracted issue numbers to PRs
    for pr in claude_prs:
        pr['fixes_issues'] = extract_fixed_issues(pr.get('body', ''))

    result = {
        'autofix_issues': autofix_issues,
        'claude_prs': claude_prs,
        'summary': {
            'total_autofix_issues': len(autofix_issues),
            'total_claude_prs': len(claude_prs),
            'total_fixed_issues': sum(1 for pr in claude_prs if pr.get('fixes_issues'))
        }
    }
    return json.dumps(result, indent=2)

def main():
    parser = argparse.ArgumentParser(
        description='Lists issues that were built or fixed by Claude',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument(
        '--state',
        choices=['open', 'closed', 'all'],
        default='open',
        help='Filter by issue state (default: open)'
    )
    parser.add_argument(
        '--format',
        choices=['json', 'text'],
        default='text',
        help='Output format (default: text)'
    )

    args = parser.parse_args()

    # This is a demonstration script
    # In a real implementation, you would use the GitHub API to fetch this data
    print("=" * 80, file=sys.stderr)
    print("This is a demonstration script.", file=sys.stderr)
    print("To actually fetch data from GitHub, use one of these methods:", file=sys.stderr)
    print("", file=sys.stderr)
    print("1. Use the bash script: .github/scripts/list-claude-issues.sh", file=sys.stderr)
    print("2. Use GitHub CLI: gh issue list --label auto-fix", file=sys.stderr)
    print("3. Use GitHub API directly with curl or requests", file=sys.stderr)
    print("4. Use PyGithub library in Python", file=sys.stderr)
    print("", file=sys.stderr)
    print("Example implementation using PyGithub:", file=sys.stderr)
    print("", file=sys.stderr)
    print("    from github import Github", file=sys.stderr)
    print("    ", file=sys.stderr)
    print("    g = Github('your_token_here')", file=sys.stderr)
    print("    repo = g.get_repo('jonasthim/dilla-chat')", file=sys.stderr)
    print("    ", file=sys.stderr)
    print("    # Get auto-fix issues", file=sys.stderr)
    print("    autofix_issues = repo.get_issues(labels=['auto-fix'], state='all')", file=sys.stderr)
    print("    ", file=sys.stderr)
    print("    # Get Claude PRs", file=sys.stderr)
    print("    claude_prs = repo.get_pulls(state='all')", file=sys.stderr)
    print("    claude_prs = [pr for pr in claude_prs if pr.user.id == 242468646]", file=sys.stderr)
    print("=" * 80, file=sys.stderr)
    print("", file=sys.stderr)

    # Show example output structure
    example_autofix_issues = [
        {
            'number': 4,
            'title': '[Auto-fix] Client lint errors detected',
            'state': 'open',
            'labels': [{'name': 'auto-fix'}, {'name': 'lint'}, {'name': 'client'}],
            'url': 'https://github.com/jonasthim/dilla-chat/issues/4'
        }
    ]

    example_claude_prs = [
        {
            'number': 7,
            'title': '[Auto-fix] Fix client lint errors detected',
            'state': 'closed',
            'merged_at': '2026-03-16T19:44:49Z',
            'url': 'https://github.com/jonasthim/dilla-chat/pull/7',
            'body': '... Fixes jonasthim/dilla-chat#4'
        }
    ]

    if args.format == 'json':
        print(format_json_output(example_autofix_issues, example_claude_prs))
    else:
        print(format_text_output(example_autofix_issues, example_claude_prs))

if __name__ == '__main__':
    main()
