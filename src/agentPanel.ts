/**
 * Agent panel: a chat webview where one request drives a TrueForge agent
 * through a tool loop (read file, search, propose write, run command).
 * Replies stream token by token; tool approvals pause the turn until the
 * user answers here; cancel is immediate and leaves the workspace clean.
 */
import * as vscode from "vscode";
import { ForgeClient, StreamedEvent } from "./trueforgeClient";
import { buildContext } from "./context";

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getClient: () => ForgeClient,
    private readonly getBudgetTokens: () => number,
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
        await this.getClient().approve(msg.threadId, msg.toolCallId, true);
      } else if (msg.type === "deny") {
        await this.getClient().approve(msg.threadId, msg.toolCallId, false, "User denied in editor");
      } else if (msg.type === "newSession") {
        this.onResetSession();
        this.post({ type: "status", text: "New session started." });
      }
    });
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  private async runTurn(instruction: string): Promise<void> {
    const client = this.getClient();
    this.post({ type: "user", text: instruction });
    try {
      const ctx = await buildContext(instruction, this.getBudgetTokens());
      if (ctx.chosen.length > 0) {
        this.post({
          type: "context",
          text: `Context (${Math.ceil(ctx.usedChars / 4)}/${ctx.budgetChars / 4} tokens): ` +
            ctx.chosen.map((c) => `${c.path} - ${c.reason}`).join("; "),
        });
      }
      const prompt = ctx.text + `Instruction: ${instruction}`;
      for await (const ev of client.streamTurn(prompt)) {
        this.renderEvent(ev);
      }
      this.post({ type: "status", text: "Done." });
    } catch (err) {
      this.post({ type: "error", text: `Model/server error: ${(err as Error).message}. Workspace untouched.` });
    }
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
    if (e.key === 'Enter') { document.getElementById('send').click(); }
  });
</script>
</body>
</html>`;
  }
}
