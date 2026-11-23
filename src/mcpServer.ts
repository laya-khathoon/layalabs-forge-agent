/**
 * MCP server exposing the editor's capabilities to the TrueForge agent:
 * read_file, search_workspace, propose_write and run_command.
 *
 * Two transports:
 *   node out/mcpServer.js               stdio (TrueForge spawns the process)
 *   node out/mcpServer.js --http 8791   streamable HTTP at http://localhost:8791/mcp
 * (TrueForge standalone's Settings -> Connectors form takes a remote URL,
 * so the HTTP mode is the one that works there; register it with auth None.)
 *
 * The agent - not the extension - decides what to read and change.
 * propose_write never touches disk: it returns a unified diff,
 * and the user reviews the hunks in the editor before anything is applied.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execFileSync, execSync } from "child_process";
import { computeDiff, formatUnified } from "./simpleDiff";

const WORKSPACE_ROOT = path.resolve(process.env.FORGE_WORKSPACE_ROOT ?? process.cwd());
const MAX_READ_CHARS = 30000;
const MAX_OUTPUT_CHARS = 8000;

function safePath(relPath: string): string {
  const abs = path.resolve(WORKSPACE_ROOT, relPath);
  const relative = path.relative(WORKSPACE_ROOT, abs);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Path escapes the workspace: ${relPath}`);
  }
  // Resolve the nearest existing parent too, so a symlink cannot escape.
  let existing = abs;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) { throw new Error("No existing workspace parent"); }
    existing = parent;
  }
  const physicalRoot = fs.realpathSync(WORKSPACE_ROOT);
  const physicalRelative = path.relative(physicalRoot, fs.realpathSync(existing));
  if (path.isAbsolute(physicalRelative) || physicalRelative === ".." || physicalRelative.startsWith(`..${path.sep}`)) {
    throw new Error("Symlink escapes the workspace");
  }
  if (relative.split(path.sep).some(part => part === ".git" || part === ".env" || part.startsWith(".env."))) {
    throw new Error("Private configuration files cannot be read through tools");
  }
  return abs;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function buildServer(): McpServer {
const server = new McpServer({ name: "vscode-tools", version: "0.1.0" });

server.registerTool(
  "read_file",
  {
    title: "Read file",
    description: "Read a file from the workspace (path relative to the workspace root).",
    inputSchema: { path: z.string().describe("Path relative to the workspace root") },
    annotations: { readOnlyHint: true },
  },
  async ({ path: relPath }) => {
    const abs = safePath(relPath);
    const content = fs.readFileSync(abs, "utf8");
    return textResult(
      content.length > MAX_READ_CHARS
        ? `${content.slice(0, MAX_READ_CHARS)}\n... [truncated, file is ${content.length} chars]`
        : content,
    );
  },
);

server.registerTool(
  "search_workspace",
  {
    title: "Search workspace",
    description:
      "Search for a plain-text or regex pattern across the workspace and return matching file paths with line numbers.",
    inputSchema: {
      query: z.string().describe("Text or regex to search for"),
      max_results: z.number().optional().describe("Maximum matches to return (default 40)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, max_results }) => {
    const max = Math.max(1, Math.min(100, Math.floor(max_results ?? 40)));
    let out: string;
    try {
      out = execFileSync("rg", ["--line-number", "--no-heading", "--max-count", String(max), "--glob", "!.env*", "--", query, WORKSPACE_ROOT], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
    } catch {
      // Fallback without ripgrep: walk the tree and match lines.
      const hits: string[] = [];
      const needle = new RegExp(query, "i");
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (hits.length >= max) {
            return;
          }
          if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules") {
            continue;
          }
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else {
            try {
              const lines = fs.readFileSync(full, "utf8").split("\n");
              lines.forEach((line, i) => {
                if (hits.length < max && needle.test(line)) {
                  hits.push(`${path.relative(WORKSPACE_ROOT, full)}:${i + 1}: ${line.trim()}`);
                }
              });
            } catch {
              // Skip binary/unreadable files.
            }
          }
        }
      };
      walk(WORKSPACE_ROOT);
      out = hits.join("\n");
    }
    return textResult(out ? out.slice(0, MAX_OUTPUT_CHARS) : "No matches.");
  },
);

server.registerTool(
  "propose_write",
  {
    title: "Propose write",
    description:
      "Propose new content for a file. Returns a unified diff for the user to review. " +
      "NEVER writes to disk: the user accepts or rejects each hunk in the editor.",
    inputSchema: {
      path: z.string().describe("Path relative to the workspace root"),
      content: z.string().describe("The complete proposed new content of the file"),
    },
  },
  async ({ path: relPath, content }) => {
    const abs = safePath(relPath);
    const original = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const hunks = computeDiff(original, content);
    if (hunks.length === 0) {
      return textResult("No changes: proposed content is identical to the file on disk.");
    }
    const diff = formatUnified(hunks, relPath);
    return textResult(`Proposed diff (${hunks.length} hunk(s)) for ${relPath}:\n${diff.slice(0, MAX_OUTPUT_CHARS)}`);
  },
);

server.registerTool(
  "run_command",
  {
    title: "Run command",
    description: "Run a shell command in the workspace root and return its output (30s timeout).",
    inputSchema: { command: z.string().describe("Shell command to run") },
    annotations: { destructiveHint: true },
  },
  async ({ command }) => {
    if (process.env.FORGE_ALLOW_COMMANDS !== "1") {
      return textResult("Shell commands are disabled. Start with FORGE_ALLOW_COMMANDS=1 only for a trusted local client, and approve commands in the editor.");
    }
    try {
      const out = execSync(command, {
        cwd: WORKSPACE_ROOT,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      });
      return textResult(out.slice(0, MAX_OUTPUT_CHARS) || "(no output)");
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      return textResult(
        `Command failed (exit ${e.status ?? "?"}):\n${(e.stdout ?? "") + (e.stderr ?? "")}`.slice(0, MAX_OUTPUT_CHARS) ||
          (e.message ?? "unknown error"),
      );
    }
  },
);

return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((size, part) => size + part.length, 0) > 1024 * 1024) {
      throw new Error("Request body exceeds 1 MiB");
    }
  }
  if (chunks.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const httpIdx = process.argv.indexOf("--http");
  if (httpIdx === -1) {
    await buildServer().connect(new StdioServerTransport());
    return;
  }
  const port = Number(process.argv[httpIdx + 1] ?? 8791);
  // Stateless mode (no session ids): a fresh server+transport per request.
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      // This server can read local files. Never expose it to the LAN or
      // allow a browser page to use DNS rebinding / cross-origin requests.
      const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
      if (!allowedHosts.has(req.headers.host ?? "") || req.headers.origin) {
        res.writeHead(403);
        res.end("Local server-to-server requests only");
        return;
      }
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== "/mcp") {
        res.writeHead(404);
        res.end();
        return;
      }
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
  httpServer.listen(port, "127.0.0.1", () => {
    // eslint-disable-next-line no-console
    console.error(`vscode-tools MCP server listening on http://localhost:${port}/mcp`);
  });
}

void main();
