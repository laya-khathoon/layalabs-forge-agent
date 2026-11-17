/**
 * Small line-based diff (LCS) used for per-hunk review.
 * Deliberately simple and dependency-free so it is easy to explain:
 * find the longest common subsequence of lines, everything outside it
 * is a removal or an addition, then group changes into hunks.
 */

export interface DiffHunk {
  oldStart: number; // 1-based line number in the original
  oldLines: string[]; // lines removed ("" entries kept for alignment)
  newLines: string[]; // lines added
}

const MAX_LINES = 3000;

export function computeDiff(oldText: string, newText: string): DiffHunk[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    // Very large files: one whole-file hunk instead of an expensive LCS.
    return a.join("\n") === b.join("\n") ? [] : [{ oldStart: 1, oldLines: a, newLines: b }];
  }
  // LCS table
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk the table and group changes into hunks
  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  let current: DiffHunk | undefined;
  const flush = () => {
    if (current && (current.oldLines.length > 0 || current.newLines.length > 0)) {
      hunks.push(current);
    }
    current = undefined;
  };
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (!current) {
        current = { oldStart: i + 1, oldLines: [], newLines: [] };
      }
      current.oldLines.push(a[i]);
      i++;
    } else {
      if (!current) {
        current = { oldStart: i + 1, oldLines: [], newLines: [] };
      }
      current.newLines.push(b[j]);
      j++;
    }
  }
  while (i < m) {
    if (!current) {
      current = { oldStart: i + 1, oldLines: [], newLines: [] };
    }
    current.oldLines.push(a[i]);
    i++;
  }
  while (j < n) {
    if (!current) {
      current = { oldStart: i + 1, oldLines: [], newLines: [] };
    }
    current.newLines.push(b[j]);
    j++;
  }
  flush();
  return hunks;
}

/** Apply only the accepted hunks to the original text. */
export function applyHunks(oldText: string, hunks: DiffHunk[], accepted: boolean[]): string {
  const lines = oldText.split("\n");
  const out: string[] = [];
  let cursor = 0; // 0-based index into original lines
  hunks.forEach((h, idx) => {
    const start = h.oldStart - 1;
    out.push(...lines.slice(cursor, start));
    if (accepted[idx]) {
      out.push(...h.newLines);
    } else {
      out.push(...lines.slice(start, start + h.oldLines.length));
    }
    cursor = start + h.oldLines.length;
  });
  out.push(...lines.slice(cursor));
  return out.join("\n");
}

/** Render hunks as a unified diff for preview. */
export function formatUnified(hunks: DiffHunk[], filePath: string): string {
  const header = `--- a/${filePath}\n+++ b/${filePath}`;
  const body = hunks
    .map((h) => {
      const lines: string[] = [`@@ -${h.oldStart},${h.oldLines.length} +${h.oldStart},${h.newLines.length} @@`];
      // Interleave removals then additions per hunk (good enough for review).
      for (const l of h.oldLines) {
        lines.push(`-${l}`);
      }
      for (const l of h.newLines) {
        lines.push(`+${l}`);
      }
      return lines.join("\n");
    })
    .join("\n");
  return `${header}\n${body}`;
}

/** Reconstruct the proposed new text from a unified diff produced by propose_write. */
export function reconstructFromUnified(oldText: string, unified: string): string | undefined {
  const lines = unified.split("\n");
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  for (const line of lines) {
    const h = line.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    if (h) {
      if (current) {
        hunks.push(current);
      }
      current = { oldStart: parseInt(h[1], 10), oldLines: [], newLines: [] };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("-")) {
      current.oldLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      current.newLines.push(line.slice(1));
    }
  }
  if (current) {
    hunks.push(current);
  }
  if (hunks.length === 0) {
    return undefined;
  }
  return applyHunks(oldText, hunks, hunks.map(() => true));
}
