# Agent Cockpit

A unified developer dashboard VS Code extension that works in VS Code, Cursor, and Windsurf.

## Features

### Panel 1: Agent Context ✅
- **Agent Status** — Real-time heartbeat status from your Hermes agent
- **Open PRs** — Displays your open pull requests from `contributions.md`
- **Lessons Learned** — Shows the last 3 lessons from `mistakes.md`
- **Wiki Search** — Search your Hermes wiki via the agent gateway

### Panel 2: AI Review ✅
- **Review Current File** — Sends file content to your Hermes agent for quality review
- **Review Staged Diff** — Sends `git diff --cached` output for review
- **Inline Comments** — Creates VS Code comment threads for review feedback
- **JSON Response Parsing** — Parses structured review output with severity, category, and line numbers

### Panel 3: Code Quality ✅
- **Sonar Scanner Integration** — Runs `sonar-scanner` if available, parses output
- **File Analysis** — Static analysis of current file (bugs, warnings, coverage)
- **Security Checks** — Detects eval(), console.log, TODOs, trailing whitespace
- **Metrics Dashboard** — Bugs, warnings, coverage, and total issues at a glance
- **Auto-scan** — Re-analyzes on file change (debounced)

### Panel 4: CI Status ✅
- **CI Detection** — Detects GitHub Actions, GitLab CI, Jenkins, CircleCI, Travis
- **Commit Status** — Shows latest commit CI status via GitHub API
- **Open PRs** — Lists open PRs in the repo with review status
- **Review Status** — Tracks approval state (Approved, Reviewed, Assigned, Open)

## Installation

### VS Code
1. Install from the VS Code Extensions marketplace (coming soon)
2. Or install from source:
   ```bash
   cd path/to/agent-cockpit
   npm install
   # Press F5 in VS Code to launch extension development host
   ```

### Manual Install (Development)
1. Clone this repo
2. Run `npm install`
3. Open in VS Code
4. Press `F5` to launch the Extension Development Host

## Configuration

Configure the extension in your workspace settings (`.vscode/settings.json`) or VS Code settings UI:

```json
{
  "agentCockpit.gatewayUrl": "https://hermes.<domain>.com",
  "agentCockpit.wikiPath": "~/.hermes/wiki",
  "agentCockpit.contributionsFile": "~/.hermes/wiki/reports/contributions.md",
  "agentCockpit.heartbeatFile": "~/.hermes/wiki/reports/heartbeat.md",
  "agentCockpit.lessonsFile": "~/.hermes/wiki/mistakes.md"
}
```

### Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `agentCockpit.gatewayUrl` | `https://hermes.<domain>.com` | Hermes agent gateway URL |
| `agentCockpit.wikiPath` | `~/.hermes/wiki` | Path to Hermes wiki directory |
| `agentCockpit.contributionsFile` | `~/.hermes/wiki/reports/contributions.md` | Path to contributions.md for tracking open PRs |
| `agentCockpit.heartbeatFile` | `~/.hermes/wiki/reports/heartbeat.md` | Path to heartbeat status file |
| `agentCockpit.lessonsFile` | `~/.hermes/wiki/mistakes.md` | Path to lessons learned |

### Authentication

The extension communicates with your Hermes agent gateway via HTTP. Set your token via the `HERMES_TOKEN` environment variable or store it in VS Code secrets.

For CI panel GitHub API access, set `GITHUB_TOKEN` environment variable with a token that has `repo` scope.

## Usage

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Look for "Agent Cockpit" in the sidebar
3. Each panel has its own refresh button and action buttons
4. Use the wiki search box to query your agent's knowledge base

### Commands

| Command | Description |
|---------|-------------|
| `Agent Cockpit: Refresh Agent Context` | Refresh the Agent Context panel |
| `Agent Cockpit: Review Current File` | Send current file to Hermes agent for review |
| `Agent Cockpit: Review Staged Diff` | Send staged git diff to Hermes agent for review |
| `Agent Cockpit: Run Sonar Scanner` | Run sonar-scanner on the current workspace |
| `Agent Cockpit: Scan Current File` | Analyze the current file for quality issues |
| `Agent Cockpit: Refresh CI Status` | Refresh CI status and PR list |

## Architecture

- **TypeScript** extension using the VS Code Extension API
- **Webview** panels with vanilla HTML/CSS (no frontend framework)
- **Gateway communication** via HTTPS POST to your Hermes Cloudflare tunnel
- **SSE streaming** support for real-time responses
- **GitHub API** integration for CI status and PR data
- **Sonar Scanner** integration for code quality metrics

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes
npm run watch

# Lint
npm run lint

# Package as VSIX
npx vsce package
```

## Compatibility

- ✅ VS Code
- ✅ Cursor (uses VS Code extension API)
- ✅ Windsurf (uses VS Code extension API)

## License

MIT
