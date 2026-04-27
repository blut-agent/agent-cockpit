# Agent Cockpit

A unified developer dashboard VS Code extension that works in VS Code, Cursor, and Windsurf.

## Features (MVP)

### Panel 1: Agent Context ✅
- **Agent Status** — Real-time heartbeat status from your Hermes agent
- **Open PRs** — Displays your open pull requests from `contributions.md`
- **Lessons Learned** — Shows the last 3 lessons from `mistakes.md`
- **Wiki Search** — Search your Hermes wiki via the agent gateway

### Panel 2: AI Review (TODO)
- Review current file via agent gateway
- Review staged diff via agent gateway

### Panel 3: Code Quality (TODO)
- Run sonar-scanner and parse output
- Show bugs, smells, coverage, security issues

### Panel 4: CI / Status (TODO)
- CI status of latest commit
- Open PRs in repo with review status

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

## Usage

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Look for "Agent Cockpit" in the sidebar
3. Click the refresh icon to update data
4. Use the wiki search box to query your agent's knowledge base

## Architecture

- **TypeScript** extension using the VS Code Extension API
- **Webview** panels with vanilla HTML/CSS (no frontend framework)
- **Gateway communication** via HTTPS POST to your Hermes Cloudflare tunnel
- **SSE streaming** support for real-time responses

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
