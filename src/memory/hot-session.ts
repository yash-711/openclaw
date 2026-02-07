import fs from "node:fs/promises";
import { buildFtsQuery } from "./hybrid.js";

type HotLine = {
  line: number;
  text: string;
};

type HotSessionState = {
  size: number;
  lines: HotLine[];
};

function extractTextFromJsonlLine(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  // Session header entry: { type: "session", ... }
  if (parsed?.type === "session") {
    return null;
  }

  // Message entries are appended by SessionManager. Expect: { role, content: [{type:"text", text:"..."}], ... }
  const content = parsed?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      const t = block.text.replace(/\s+/g, " ").trim();
      if (t) {
        parts.push(t);
      }
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

function scoreTextMatch(text: string, query: string): number {
  const q = query.trim();
  if (!q) {
    return 0;
  }
  const fts = buildFtsQuery(q);
  const tokens = (fts ? fts.match(/[A-Za-z0-9_]+/g) : q.match(/[A-Za-z0-9_]+/g)) ?? [];
  if (tokens.length === 0) {
    return 0;
  }
  const hay = text.toLowerCase();
  let hit = 0;
  for (const token of tokens) {
    const needle = token.toLowerCase();
    if (needle && hay.includes(needle)) {
      hit += 1;
    }
  }
  return hit / tokens.length;
}

export class HotSessionIndex {
  private readonly maxLines: number;
  private readonly states = new Map<string, HotSessionState>();

  constructor(params: { maxLines: number }) {
    this.maxLines = Math.max(10, params.maxLines);
  }

  getState(absPath: string): HotSessionState | undefined {
    return this.states.get(absPath);
  }

  async update(absPath: string): Promise<void> {
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat) {
      this.states.delete(absPath);
      return;
    }

    const prev = this.states.get(absPath);
    const next: HotSessionState = prev
      ? { size: prev.size, lines: [...prev.lines] }
      : { size: 0, lines: [] };

    // If truncated/rotated, rebuild from scratch.
    if (stat.size < next.size) {
      next.size = 0;
      next.lines = [];
    }

    const start = next.size;
    const end = stat.size;
    if (end <= start) {
      this.states.set(absPath, { size: end, lines: next.lines });
      return;
    }

    const handle = await fs.open(absPath, "r");
    try {
      const length = end - start;
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, start);
      const text = buf.subarray(0, bytesRead).toString("utf-8");
      const rawLines = text.split("\n");
      // Line numbers: best-effort. We'll map appended lines after the current count.
      const existingLineCount = next.lines.length;
      let lineNo = existingLineCount + 1;
      for (const raw of rawLines) {
        const extracted = extractTextFromJsonlLine(raw);
        if (extracted) {
          next.lines.push({ line: lineNo, text: extracted });
        }
        lineNo += 1;
      }
      if (next.lines.length > this.maxLines) {
        next.lines = next.lines.slice(-this.maxLines);
      }
      next.size = end;
      this.states.set(absPath, next);
    } finally {
      await handle.close();
    }
  }

  search(params: {
    absPath: string;
    relPath: string;
    query: string;
    limit: number;
  }): Array<{ path: string; startLine: number; endLine: number; score: number; snippet: string }> {
    const state = this.states.get(params.absPath);
    if (!state || state.lines.length === 0) {
      return [];
    }
    const scored = state.lines
      .map((line) => {
        const score = scoreTextMatch(line.text, params.query);
        return {
          path: params.relPath,
          startLine: line.line,
          endLine: line.line,
          score,
          snippet: line.text,
        };
      })
      .filter((entry) => entry.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, params.limit));
  }
}
