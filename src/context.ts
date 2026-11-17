/**
 * Context assembly: explicit @file / @symbol mentions plus automatic
 * retrieval of code the user did not mention, within a stated token budget.
 * The chosen files (and why) are reported so the selection is visible.
 */
import * as vscode from "vscode";
import * as path from "path";
import { execFileSync } from "child_process";

export interface ChosenContext {
  path: string;
  reason: string;
  chars: number;
}

export interface BuiltContext {
  /** Text block prepended to the user instruction. */
  text: string;
  chosen: ChosenContext[];
  budgetChars: number;
  usedChars: number;
}

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
const STOP_WORDS = new Set([
  "this", "that", "with", "from", "should", "would", "could", "please", "function", "return",
  "false", "true", "command", "file", "files", "test", "tests", "make", "update", "change",
  "print", "json", "them", "then", "than", "into", "must", "also", "well", "case",
]);

function extractIdentifiers(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(IDENTIFIER_RE)) {
    const w = m[0];
    if (!STOP_WORDS.has(w.toLowerCase())) {
      found.add(w);
    }
  }
  // Longest first: specific identifiers beat short generic ones.
  return [...found].sort((a, b) => b.length - a.length).slice(0, 8);
}

function searchFiles(query: string, max: number): string[] {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return [];
  }
  try {
    const out = execFileSync(
      "rg",
      ["--files-with-matches", "--fixed-strings", "--max-count", "1", query, root],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((p) => path.relative(root, p))
      .slice(0, max);
  } catch {
    return [];
  }
}

/**
 * Build the context block for one user instruction.
 * 1. The file/selection the user is editing (if any) always fits.
 * 2. @file mentions are resolved against the workspace.
 * 3. Identifiers from the instruction are searched; the files with the
 *    most identifier hits are added until the budget is full.
 */
export async function buildContext(
  instruction: string,
  budgetTokens: number,
  explicit?: { path: string; content: string },
): Promise<BuiltContext> {
  const budgetChars = budgetTokens * 4;
  const chosen: ChosenContext[] = [];
  const parts: string[] = [];
  let used = 0;

  const push = (relPath: string, content: string, reason: string) => {
    if (used >= budgetChars) {
      return;
    }
    const clipped = content.slice(0, budgetChars - used);
    parts.push(`### ${relPath} (${reason})\n${clipped}`);
    chosen.push({ path: relPath, reason, chars: clipped.length });
    used += clipped.length;
  };

  if (explicit) {
    push(explicit.path, explicit.content, "selected in the editor");
  }

  const mentions = [...instruction.matchAll(/@([\w./-]+)/g)].map((m) => m[1]);
  for (const mention of mentions) {
    const files = await vscode.workspace.findFiles(`**/${mention}**`, "**/node_modules/**", 3);
    for (const f of files) {
      const doc = await vscode.workspace.openTextDocument(f);
      push(vscode.workspace.asRelativePath(f), doc.getText(), `mentioned as @${mention}`);
    }
  }

  const already = new Set(chosen.map((c) => c.path));
  const identifiers = extractIdentifiers(instruction);
  const scores = new Map<string, number>();
  for (const id of identifiers) {
    for (const f of searchFiles(id, 10)) {
      if (!already.has(f)) {
        scores.set(f, (scores.get(f) ?? 0) + id.length);
      }
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [relPath] of ranked) {
    if (used >= budgetChars) {
      break;
    }
    try {
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, relPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      push(relPath, doc.getText(), `auto-retrieved (matched: ${identifiers.join(", ")})`);
    } catch {
      // File disappeared between search and read; skip it.
    }
  }

  const text =
    parts.length === 0
      ? ""
      : `Context (budget ~${budgetTokens} tokens, using ~${Math.ceil(used / 4)}):\n\n${parts.join("\n\n")}\n\n`;
  return { text, chosen, budgetChars, usedChars: used };
}
