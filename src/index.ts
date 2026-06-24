#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { getFailedTests } from "./report-reader";
import { parseTrace, getNetworkLog, getActionHistory } from "./trace-parser";
import { getScreenshotBase64, getScreenshotsAroundTime } from "./screenshot";
import { suggestFix } from "./fix-suggester";
import { validateFilePath, SecurityError } from "./security";

const server = new Server(
  { name: "playwright-debug-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_failed_tests",
      description: "Get failed tests from a Playwright JSON report",
      inputSchema: {
        type: "object",
        properties: {
          report_path: {
            type: "string",
            description: "Absolute path to Playwright JSON report file e.g. /project/test-results/results.json"
          }
        },
        required: ["report_path"]
      }
    },
    {
      name: "analyze_trace",
      description: "Analyze a Playwright trace.zip file for a failed test",
      inputSchema: {
        type: "object",
        properties: {
          trace_path: {
            type: "string",
            description: "Absolute path to trace.zip file"
          }
        },
        required: ["trace_path"]
      }
    },
    {
      name: "get_network_log",
      description: "Get network logs from a Playwright trace.zip file",
      inputSchema: {
        type: "object",
        properties: {
          trace_path: { type: "string" },
          filter: {
            type: "string",
            enum: ["all", "failed", "4xx", "5xx"],
            default: "all"
          }
        },
        required: ["trace_path"]
      }
    },
    {
      name: "get_action_history",
      description: "Get a chronological list of all actions performed in a Playwright trace",
      inputSchema: {
        type: "object",
        properties: {
          trace_path: { type: "string" }
        },
        required: ["trace_path"]
      }
    },
    {
      name: "get_screenshots_around_time",
      description: "Get screenshots immediately before and after a specific timestamp in the trace",
      inputSchema: {
        type: "object",
        properties: {
          trace_path: { type: "string" },
          target_time: { type: "number", description: "The timeline timestamp (in ms) of the action" }
        },
        required: ["trace_path", "target_time"]
      }
    },
    {
      name: "suggest_fix",
      description: "Suggest a fix for a Playwright test error",
      inputSchema: {
        type: "object",
        properties: {
          error_message: { type: "string" },
          failing_action: { type: "string" },
          selector_used: { type: "string" }
        },
        required: ["error_message", "failing_action"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
  const { name, arguments: args } = request.params;
  process.stderr.write(`[playwright-debug-mcp] Tool called: ${name} with args: ${JSON.stringify(args)}\n`);

  try {
    if (name === "get_failed_tests") {
      const reportPath = validateFilePath(args?.report_path as string, '.json');
      const failedTests = getFailedTests(reportPath);
      return {
        content: [{ type: "text", text: JSON.stringify(failedTests, null, 2) }]
      };
    }

    if (name === "analyze_trace") {
      const tracePath = validateFilePath(args?.trace_path as string, '.zip');
      process.stderr.write(`[playwright-debug-mcp] Parsing trace: ${tracePath}\n`);
      const analysis = parseTrace(tracePath);
      
      const textContent = JSON.stringify({
        failing_action: analysis.failing_action,
        error_message: analysis.error_message,
        selector_used: analysis.selector_used,
        console_errors: analysis.console_errors,
        network_failures: analysis.network_failures,
        action_history: analysis.action_history,
        recent_network_requests: analysis.recent_network_requests,
        dom_snapshot: analysis.dom_snapshot
      }, null, 2);

      const contentItems: any[] = [{ type: "text", text: textContent }];
      
      if (analysis.screenshot_sha1) {
        const screenshotBase64 = getScreenshotBase64(tracePath, analysis.screenshot_sha1);
        if (screenshotBase64) {
          contentItems.push({
            type: "image",
            data: screenshotBase64,
            mimeType: "image/jpeg"
          });
        }
      }

      return {
        content: contentItems
      };
    }

    if (name === "get_network_log") {
      const tracePath = validateFilePath(args?.trace_path as string, '.zip');
      const rawFilter = (args?.filter as string) || 'all';
      const validFilters = ['all', 'failed', '4xx', '5xx'] as const;
      if (!validFilters.includes(rawFilter as any)) {
        throw new Error(`Invalid filter "${rawFilter}". Must be one of: ${validFilters.join(', ')}.`);
      }
      const logs = getNetworkLog(tracePath, rawFilter as 'all' | 'failed' | '4xx' | '5xx');
      return {
        content: [{ type: "text", text: JSON.stringify(logs, null, 2) }]
      };
    }

    if (name === "get_action_history") {
      const tracePath = validateFilePath(args?.trace_path as string, '.zip');
      const history = getActionHistory(tracePath);
      return {
        content: [{ type: "text", text: JSON.stringify(history, null, 2) }]
      };
    }

    if (name === "get_screenshots_around_time") {
      const tracePath = validateFilePath(args?.trace_path as string, '.zip');
      const rawTime = args?.target_time;
      if (typeof rawTime !== 'number' || isNaN(rawTime)) {
        throw new Error('target_time must be a valid number (millisecond timestamp from get_action_history).');
      }
      const targetTime = rawTime;
      const screenshots = getScreenshotsAroundTime(tracePath, targetTime);
      
      const contentItems: any[] = [];
      if (screenshots.before_action) {
        contentItems.push({ type: "text", text: "Screenshot BEFORE action:" });
        contentItems.push({ type: "image", data: screenshots.before_action, mimeType: "image/jpeg" });
      } else {
        contentItems.push({ type: "text", text: "No BEFORE screenshot found." });
      }
      
      if (screenshots.after_action) {
        contentItems.push({ type: "text", text: "Screenshot AFTER action:" });
        contentItems.push({ type: "image", data: screenshots.after_action, mimeType: "image/jpeg" });
      } else {
        contentItems.push({ type: "text", text: "No AFTER screenshot found." });
      }

      return { content: contentItems };
    }

    if (name === "suggest_fix") {
      const errorMessage = args?.error_message;
      const failingAction = args?.failing_action;
      if (typeof errorMessage !== 'string' || !errorMessage) {
        throw new Error('error_message is required and must be a non-empty string.');
      }
      if (typeof failingAction !== 'string' || !failingAction) {
        throw new Error('failing_action is required and must be a non-empty string.');
      }
      const selectorUsed = (args?.selector_used as string) || '';
      
      const suggestion = suggestFix(errorMessage, failingAction, selectorUsed);
      return {
        content: [{ type: "text", text: JSON.stringify(suggestion, null, 2) }]
      };
    }

    throw new Error(`Unknown tool: ${name}`);

  } catch (err: any) {
    const isSecurityErr = err instanceof SecurityError;
    process.stderr.write(`[playwright-debug-mcp] ${isSecurityErr ? 'SECURITY BLOCK' : 'Error'} in tool ${name}: ${err.stack}\n`);
    return {
      content: [{ type: "text", text: `${isSecurityErr ? 'Security Error' : 'Error'}: ${err.message}` }],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[playwright-debug-mcp] Server started and connected to stdio\n`);
}

main().catch(err => {
  process.stderr.write(`[playwright-debug-mcp] Fatal error: ${err.message}\n`);
  process.exit(1);
});
