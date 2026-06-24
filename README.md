# Playwright Debug MCP Server

An MCP (Model Context Protocol) server designed to supercharge AI-assisted debugging of Playwright tests. 

Instead of manually downloading and scrubbing through `trace.zip` files to find why a test failed, simply point this MCP server to your trace file or Playwright results directory. The server instantly parses the exact failing action, action history, network failures, DOM snapshots, and screenshots so your AI assistant (like Claude, Cursor, Cline, or Antigravity) can instantly pinpoint the failure and suggest a code fix.

## Features

- 🐛 **`analyze_trace`**: Automatically extracts the exact action that hung or failed, the selector used, DOM snapshots, and Base64 screenshots.
- 📜 **`get_action_history`**: Extracts a full chronological timeline of every user action performed during the test.
- 🌐 **`get_network_log`**: Filters network requests inside the trace to find exactly what APIs returned 4xx or 5xx right before the crash.
- 🖼️ **`get_screenshots_around_time`**: Visual timeline extraction tool for the AI to view the exact state of the browser before and after any given timestamp.
- 🛠️ **`suggest_fix`**: A built-in logic engine mapping common Playwright errors to actionable fixes.

## Usage for the Public (VS Code, Cursor, Claude Desktop)

This server can be used out-of-the-box by any MCP-compatible AI agent without needing to clone or configure anything locally.

### Using in Cursor
1. Go to **Cursor Settings** > **Features** > **MCP Servers**
2. Click **+ Add New MCP Server**
3. Set **Type** to `command`
4. Set **Name** to `playwright-debug`
5. Set **Command** to:
   ```bash
   npx -y github:aakarshitsharma06/playwright-debug-mcp
   ```

### Using in VS Code (with Cline / RooCode extension)
Open your MCP configuration file (usually in `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`) and add:
```json
{
  "mcpServers": {
    "playwright-debugger": {
      "command": "npx",
      "args": ["-y", "github:aakarshitsharma06/playwright-debug-mcp"]
    }
  }
}
```

### Using in Claude Desktop
Open your Claude Desktop config file (`~/Library/Application Support/Claude/claude_desktop_config.json`) and add:
```json
{
  "mcpServers": {
    "playwright-debugger": {
      "command": "npx",
      "args": ["-y", "github:aakarshitsharma06/playwright-debug-mcp"]
    }
  }
}
```

## How to Build Locally

If you want to modify or run the code locally:

```bash
npm install
npm run build
node dist/index.js
```
