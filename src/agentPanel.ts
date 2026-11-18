/**
 * Agent panel: a chat webview where one request drives a TrueForge agent
 * through a tool loop (read file, search, propose write, run command).
 * Replies stream token by token; tool approvals pause the turn until the
 * user answers here; cancel is immediate and leaves the workspace clean.
 *
 * Small/local models sometimes print a tool call as plain JSON text instead
 * of making a real tool call. The panel detects that shape, executes the
 * call directly against the vscode-tools MCP server over HTTP, and feeds
 * the result back into the turn - so weak models still work end to end.
 */
import * as vscode from "vscode";
import { ForgeClient, StreamedEvent } from "./trueforgeClient";
import { buildContext } from "./context";

const TOOL_NAMES = ["read_file", "search_workspace", "propose_write", "run_command"];
const NEEDS_APPROVAL = new Set(["propose_write", "run_command"]);
const MAX_TOOL_HOPS = 8;

interface TextToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Parse a tool call the model printed as plain JSON text, with tolerant key aliases. */
export function extractTextToolCall(text: string): TextToolCall | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return undefined;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof obj !== "object" || obj === null) {
    return undefined;
  }
  const o = obj as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : undefined;
  if (!name || !TOOL_NAMES.includes(name)) {
    return undefined;
  }
  let args: Record<string, unknown> = {};
  const params = (o.parameters ?? o.arguments) as Record<string, unknown> | undefined;
  if (params && typeof params === "object") {
    const inner = (params.input ?? params.arguments) as Record<string, unknown> | undefined;
    args = { ...params, ...(inner && typeof inner === "object" ? inner : {}) };
    delete args.input;
    delete args.arguments;
    delete args.mcp_server;
  }
  // Key aliases small models use.
  for (const alias of ["filename", "file", "filepath", "file_name"]) {
    if (args[alias] !== undefined && args.path === undefined) {
      args.path = args[alias];
    }
    delete args[alias];
  }
  if (args.cmd !== undefined && args.command === undefined) {
    args.command = args.cmd;
  }
  delete args.cmd;
  if (args.query === undefined && typeof args.path === "string" && name === "search_workspace") {
    args.query = args.path;
    delete args.path;
  }
  return { name, args };
}

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pendingManualApproval?: (allow: boolean) => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getClient: () => ForgeClient,
    private readonly getBudgetTokens: () => number,
    private readonly getMcpUrl: () => string,
    private readonly onProposedDiff: (relPath: string, diff: string) => Promise<void>,
    private readonly onResetSession: () => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "send") {
        await this.runTurn(msg.text);
      } else if (msg.type === "cancel") {
        await this.getClient().cancel();
        this.post({ type: "status", text: "Cancelled. No changes were applied." });
      } else if (msg.type === "approve") {
        if (this.pendingManualApproval) {
          const resolve = this.pendingManualApproval;
          this.pendingManualApproval = undefined;
          resolve(true);
        } else {
          await this.getClient().approve(msg.threadId, msg.toolCallId, true);
        }
      } else if (msg.type === "deny") {
        if (this.pendingManualApproval) {
          const resolve = this.pendingManualApproval;
          this.pendingManualApproval = undefined;
          resolve(false);
        } else {
          await this.getClient().approve(msg.threadId, msg.toolCallId, false, "User denied in editor");
        }
      } else if (msg.type === "newSession") {
        this.onResetSession();
        this.post({ type: "status", text: "New session started." });
      }
    });
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  private async runTurn(userText: string): Promise<void> {
    try {
      const ctx = await buildContext(userText, this.getBudgetTokens());
      if (ctx.chosen.length > 0) {
        this.post({
          type: "context",
          text:
            `Context (${Math.ceil(ctx.usedChars / 4)}/${ctx.budgetChars / 4} tokens): ` +
            ctx.chosen.map((c) => `${c.path} - ${c.reason}`).join("; "),
        });
      }
      let nextInput = ctx.text + `Instruction: ${userText}`;
      const client = this.getClient();
      let lastCallKey = "";
      let repeated = false;
      let toolRuns = 0;
      let retriedEmpty = false;
      for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
        let textOut = "";
        let realToolActivity = false;
        for await (const ev of client.streamTurn(nextInput)) {
          if (ev.type === "model.message.delta") {
            textOut += ev.content ?? "";
          }
          if (ev.type === "tool.response" || ev.type === "tool.approval_required") {
            realToolActivity = true;
          }
          this.renderEvent(ev);
        }
        if (realToolActivity) {
          break;
        }
        // Weak-model fallback: the model printed its tool call as JSON text.
        const call = extractTextToolCall(textOut);
        if (!call) {
          // After a tool result, a 3B model may answer with nothing at all.
          if (toolRuns > 0 && textOut.trim() === "") {
            if (!retriedEmpty) {
              retriedEmpty = true;
              this.post({ type: "status", text: "The model returned nothing; asking again for a plain answer..." });
              nextInput =
                `Answer the original task in one or two plain sentences using the tool result above. ` +
                `Do not write any JSON or tool call. Original task: ${userText}`;
              continue;
            }
            this.post({
              type: "status",
              text:
                "The model returned no answer. The tool output above has the result - " +
                "press New and ask again if you want it phrased.",
            });
          }
          break;
        }
        const callKey = JSON.stringify(call);
        if (callKey === lastCallKey) {
          repeated = true;
          break;
        }
        lastCallKey = callKey;
        toolRuns++;
        if (NEEDS_APPROVAL.has(call.name)) {
          this.post({ type: "status", text: `Approval needed for tool call ${call.name} (manual fallback)` });
          const allow = await new Promise<boolean>((resolve) => {
            this.pendingManualApproval = resolve;
            this.post({ type: "approval", threadId: "manual", toolCallId: "manual" });
          });
          if (!allow) {
            this.post({ type: "status", text: `Denied ${call.name}. Stopped; workspace untouched.` });
            return;
          }
        }
        this.post({ type: "status", text: `Running ${call.name} (manual fallback)...` });
        let result: string;
        try {
          result = await this.callMcpTool(call.name, call.args);
        } catch (err) {
          this.post({ type: "error", text: `Tool ${call.name} failed: ${(err as Error).message}` });
          return;
        }
        this.post({ type: "tool", text: result.slice(0, 2000) });
        if (call.name === "propose_write") {
          const diffMatch = result.match(/Proposed diff .*?:\n([\s\S]*)/);
          const pathMatch = result.match(/for (.+?):\n/);
          if (diffMatch && pathMatch) {
            await this.onProposedDiff(pathMatch[1], diffMatch[1]);
          }
        }
        nextInput =
          `The tool ${call.name} was executed and returned:\n${result}\n` +
          `Now answer the original task in plain words using this result. ` +
          `Do NOT write more tool JSON unless a different tool is truly needed. ` +
          `Original task: ${userText}`;
      }
      if (repeated) {
        this.post({
          type: "status",
          text:
            "The model kept repeating the same tool call instead of answering, so I stopped it. " +
            "The tool output above has the information - if no plain answer appears, try the New button and ask again.",
        });
      }
      this.post({ type: "status", text: "Done." });
    } catch (err) {
      this.post({ type: "error", text: `Model/server error: ${(err as Error).message}. Workspace untouched.` });
    }
  }

  /** Execute one tool call directly against the vscode-tools MCP server (streamable HTTP). */
  private async callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await fetch(this.getMcpUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await res.text();
    // The server may answer with SSE frames ("data: {...}" lines) or plain JSON.
    const dataLines = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    const parsed = JSON.parse(dataLines || raw) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
      error?: { message?: string };
    };
    if (parsed.error) {
      throw new Error(parsed.error.message ?? "MCP error");
    }
    const texts = (parsed.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    return texts || "(empty result)";
  }

  private renderEvent(ev: StreamedEvent): void {
    switch (ev.type) {
      case "model.message.delta":
        this.post({ type: "delta", id: ev.id, text: ev.content ?? "" });
        break;
      case "tool.response": {
        const body = typeof ev.content === "string" ? ev.content : JSON.stringify(ev.content ?? "");
        this.post({ type: "tool", text: body.slice(0, 2000) });
        const diffMatch = body.match(/Proposed diff .*?:\n([\s\S]*)/);
        const pathMatch = body.match(/for (.+?):\n/);
        if (diffMatch && pathMatch) {
          void this.onProposedDiff(pathMatch[1], diffMatch[1]);
        }
        break;
      }
      case "tool.approval_required":
        for (const tc of ev.toolCalls ?? []) {
          this.post({ type: "approval", threadId: ev.threadId ?? "main", toolCallId: tc.id });
        }
        break;
      case "turn.update":
        this.post({ type: "status", text: `Turn ${(ev.state?.status as string) ?? "update"}...` });
        break;
      case "turn.done":
        this.post({ type: "status", text: "Turn finished." });
        break;
      default:
        break;
    }
  }

  private html(): string {
    return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); margin: 0; padding: 8px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  #log { flex: 1; overflow-y: auto; white-space: pre-wrap; font-size: 12px; }
  .user { color: var(--vscode-textLink-foreground); margin: 8px 0 2px; font-weight: bold; }
  .delta { margin: 0 0 6px; }
  .tool { background: var(--vscode-textCodeBlock-background); padding: 4px; border-radius: 4px; margin: 4px 0; font-family: monospace; font-size: 11px; }
  .context { color: var(--vscode-descriptionForeground); font-style: italic; margin: 4px 0; }
  .error { color: var(--vscode-errorForeground); margin: 4px 0; }
  .status { color: var(--vscode-descriptionForeground); margin: 4px 0; }
  #inputRow { display: flex; gap: 4px; padding-top: 6px; }
  #input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; cursor: pointer; }
</style>
</head>
<body>
  <div class="status">Forge panel build 2026-11-18c</div>
  <div id="log"></div>
  <div id="inputRow">
    <input id="input" placeholder="Ask the agent... (@file to mention)" />
    <button id="send">Send</button>
    <button id="cancel">Stop</button>
    <button id="newSession">New</button>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const add = (cls, text) => {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };
  let currentDelta;
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'user') { add('user', m.text); currentDelta = undefined; }
    else if (m.type === 'delta') {
      if (!currentDelta || currentDelta.dataset.mid !== m.id) {
        currentDelta = add('delta', '');
        currentDelta.dataset.mid = m.id;
      }
      currentDelta.textContent += m.text;
      log.scrollTop = log.scrollHeight;
    }
    else if (m.type === 'tool') { add('tool', m.text); currentDelta = undefined; }
    else if (m.type === 'context') { add('context', m.text); }
    else if (m.type === 'error') { add('error', m.text); }
    else if (m.type === 'status') { add('status', m.text); currentDelta = undefined; }
    else if (m.type === 'approval') {
      const row = add('status', 'Approval needed for tool call ' + m.toolCallId + ' ');
      const yes = document.createElement('button'); yes.textContent = 'Approve';
      const no = document.createElement('button'); no.textContent = 'Deny';
      yes.onclick = () => { vscode.postMessage({ type: 'approve', threadId: m.threadId, toolCallId: m.toolCallId }); row.textContent = 'Approved.'; };
      no.onclick = () => { vscode.postMessage({ type: 'deny', threadId: m.threadId, toolCallId: m.toolCallId }); row.textContent = 'Denied.'; };
      row.appendChild(yes); row.appendChild(no);
    }
  });
  document.getElementById('send').onclick = () => {
    const input = document.getElementById('input');
    if (input.value.trim()) { vscode.postMessage({ type: 'send', text: input.value }); input.value = ''; }
  };
  document.getElementById('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
  document.getElementById('newSession').onclick = () => vscode.postMessage({ type: 'newSession' });
  document.getElementById('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { document.getElementById('send').onclick(); }
  });
</script>
</body>
</html>`;
  }
}
