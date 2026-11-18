import * as vscode from "vscode";
import { ForgeClient } from "./trueforgeClient";
import { AgentPanelProvider } from "./agentPanel";
import { DiffReviewManager } from "./diffReview";
import { inlineEdit } from "./inlineEdit";
import { reconstructFromUnified } from "./simpleDiff";

const INSTRUCTIONS = [
  "You are a careful coding agent running inside VS Code via TrueForge.",
  "The vscode-tools MCP server gives you exactly these tools: read_file, search_workspace, propose_write, run_command.",
  "Call tools by these exact names only. Never invent tool names - the connector name and its description are not tools.",
  "To see any file you MUST call read_file first. To find files, call search_workspace.",
  "Never guess or make up file contents, project names or facts. If a tool call fails, say exactly what failed and stop - do not answer from imagination.",
  "If you cannot make a real tool call, reply with ONLY this JSON and nothing else: {\"name\": \"<tool>\", \"parameters\": {\"input\": {\"path\": \"<file>\"}}}.",
  "NEVER write to disk yourself: always propose changes with propose_write so the user can review hunks.",
  "When a task spans several files, find the files yourself with search_workspace before reading them.",
  "Explain briefly which files you chose and why.",
].join(" ");

export function activate(context: vscode.ExtensionContext): void {
  const config = () => vscode.workspace.getConfiguration("forge");

  let client: ForgeClient | undefined;
  const makeClient = (model?: string) =>
    new ForgeClient(config().get<string>("trueforgeBaseUrl", "http://localhost:8790"), {
      model: model ?? config().get<string>("model", "google/gemini-2.5-flash"),
      instructions: INSTRUCTIONS,
      mcpServerName: config().get<string>("mcpServerName", "vscode-tools"),
    });
  const getClient = () => (client ??= makeClient());
  /** Swap to the fallback model once (fresh session). Returns undefined when no fallback is set. */
  const retryWithFallback = (): ForgeClient | undefined => {
    const fallback = config().get<string>("fallbackModel", "");
    if (!fallback) {
      return undefined;
    }
    client = makeClient(fallback);
    return client;
  };

  const review = new DiffReviewManager();
  const output = vscode.window.createOutputChannel("Forge Agent");

  const panel = new AgentPanelProvider(
    context.extensionUri,
    getClient,
    () => config().get<number>("contextBudgetTokens", 12000),
    () => config().get<string>("mcpServerUrl", "http://localhost:8791/mcp"),
    async (relPath, diff) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        return;
      }
      const uri = vscode.Uri.joinPath(root, relPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const proposed = reconstructFromUnified(doc.getText(), diff);
      if (proposed !== undefined) {
        await review.reviewAndApply(doc.uri, proposed, `agent change to ${relPath}`);
      } else {
        output.appendLine(`Forge: could not parse proposed diff for ${relPath}`);
      }
    },
    () => {
      client?.endSession();
      client = undefined;
    },
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("forge.agentView", panel),
    vscode.commands.registerCommand("forge.inlineEdit", () =>
      inlineEdit(getClient, retryWithFallback, review, config().get<number>("contextBudgetTokens", 12000)),
    ),
    vscode.commands.registerCommand("forge.openAgent", () =>
      vscode.commands.executeCommand("workbench.view.extension.forge"),
    ),
    vscode.commands.registerCommand("forge.undoLastApply", () => review.undoLast()),
    vscode.commands.registerCommand("forge.newSession", () => {
      client?.endSession();
      client = undefined;
      vscode.window.showInformationMessage("Forge: new session will start on the next request.");
    }),
    output,
  );
}

export function deactivate(): void {
  // Nothing to clean up: TrueForge sessions live on the local server.
}
