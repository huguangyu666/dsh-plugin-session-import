// src/index.js
import { existsSync as existsSync3, readdirSync as readdirSync2, statSync, readFileSync as readFileSync5, openSync, readSync, closeSync } from "node:fs";
import { join as join4, dirname } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { homedir as homedir2 } from "node:os";

// src/path-decoding.js
import { readdirSync } from "node:fs";
import { join } from "node:path";
function decodeSlugPath(slug) {
  const drive = slug.match(/^([a-z])--/i);
  const root = drive ? `${drive[1]}:\\` : slug.startsWith("-") ? "/" : void 0;
  if (!root || drive && process.platform !== "win32") return void 0;
  const rest = slug.slice(drive ? 3 : 1);
  const ambiguous = /* @__PURE__ */ Symbol("ambiguous");
  const visit = (dir, remaining) => {
    if (!remaining) return dir;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return void 0;
    }
    const candidates = /* @__PURE__ */ new Set();
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      for (const encoded of /* @__PURE__ */ new Set([entry.name.replace(/[._]/g, "-"), entry.name.replace(/[^a-zA-Z0-9]/g, "-")])) {
        const matches = process.platform === "win32" ? remaining.toLowerCase().startsWith(encoded.toLowerCase()) : remaining.startsWith(encoded);
        if (!matches || remaining.length > encoded.length && remaining[encoded.length] !== "-") continue;
        const next = remaining.slice(encoded.length);
        const found = visit(join(dir, entry.name), next ? next.slice(1) : "");
        if (found === ambiguous) return ambiguous;
        if (found) candidates.add(found);
        if (candidates.size > 1) return ambiguous;
      }
    }
    return candidates.size === 1 ? [...candidates][0] : void 0;
  };
  const resolved = visit(root, rest);
  return resolved === ambiguous ? void 0 : resolved;
}

// src/parsers/claude-code.js
import { readFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir } from "node:os";
function mapBlock(block) {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text ?? "" };
    case "image": {
      const src = block.source ?? {};
      const mediaType = src.media_type ?? src.mediaType ?? "";
      if (mediaType && /^image\/(png|jpeg|webp|gif)$/.test(mediaType) && typeof src.data === "string" && src.data.length > 0) {
        return { type: "image", mediaType, data: src.data };
      }
      return { type: "text", text: "[image attachment]" };
    }
    case "tool_use":
      return {
        type: "tool-call",
        id: block.id,
        name: block.name,
        arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {})
      };
    case "tool_result":
      return {
        type: "tool-result",
        toolCallId: block.tool_use_id,
        content: Array.isArray(block.content) ? block.content.map(mapBlock) : [{ type: "text", text: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "") }],
        isError: block.is_error === true
      };
    case "thinking":
      return { type: "reasoning", text: block.thinking ?? "" };
    default:
      return { type: "text", text: `[${block.type}] ` + JSON.stringify(block) };
  }
}
var cwdMapCache = null;
function loadCwdMap() {
  if (cwdMapCache) return cwdMapCache;
  const map = {};
  try {
    const cfg = JSON.parse(readFileSync(join2(process.env.USERPROFILE || process.env.HOME || homedir(), ".claude.json"), "utf8"));
    for (const realPath of Object.keys(cfg.projects ?? {})) {
      map[realPath] = realPath;
      for (const slug of /* @__PURE__ */ new Set([realPath.replace(/[\\/._]/g, "-"), realPath.replace(/[^a-zA-Z0-9]/g, "-")])) {
        map[slug] = slug in map && map[slug] !== realPath ? null : realPath;
      }
    }
  } catch {
  }
  cwdMapCache = map;
  return map;
}
function decodeCwd(filePath) {
  const m = filePath.match(/projects[\\\/]([^\\\/]+)[\\\/]/);
  if (!m) return void 0;
  const dir = m[1];
  const map = loadCwdMap();
  if (map[dir]) return map[dir];
  return decodeSlugPath(dir);
}
function parseClaudeCode(filePath) {
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const messages = [];
  let recordCwd;
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.isSidechain === true) continue;
    if (!recordCwd && typeof record.cwd === "string" && record.cwd) recordCwd = record.cwd;
    const type = record.type;
    const msg = record.message;
    if (!msg || typeof msg !== "object") continue;
    if (type === "user" && msg.role === "user") {
      const content = Array.isArray(msg.content) ? msg.content.map(mapBlock) : [{ type: "text", text: typeof msg.content === "string" ? msg.content : "" }];
      messages.push({ role: "user", content });
    } else if (type === "assistant" && msg.role === "assistant") {
      messages.push({
        role: "assistant",
        content: Array.isArray(msg.content) ? msg.content.map(mapBlock) : [{ type: "text", text: typeof msg.content === "string" ? msg.content : "" }],
        usage: msg.usage ?? void 0,
        model: msg.model ?? void 0
      });
    }
  }
  return { messages: reorderToolPairs(messages), cwd: recordCwd || decodeCwd(filePath) };
}
function reorderToolPairs(messages) {
  const result = [];
  const plan = [];
  for (const msg of messages) {
    const calls = msg.content.filter((b) => b.type === "tool-call");
    const results = msg.content.filter((b) => b.type === "tool-result");
    if (msg.role === "assistant" && calls.length > 0) {
      plan.push({ kind: "calls", msg, calls });
    } else if (msg.role === "user" && results.length > 0) {
      plan.push({ kind: "results", msg, results });
    } else {
      plan.push({ kind: "text", msg });
    }
  }
  const callIndex = /* @__PURE__ */ new Map();
  for (const item of plan) {
    if (item.kind === "calls") {
      for (const c of item.calls) callIndex.set(c.id, { item, pendingResults: [] });
    }
  }
  for (const item of plan) {
    if (item.kind !== "results") continue;
    const unmatched = [];
    for (const r of item.results) {
      const target = callIndex.get(r.toolCallId);
      if (target) target.pendingResults.push(r);
      else unmatched.push(r);
    }
    if (unmatched.length > 0) {
      const rest = item.msg.content.filter((b) => b.type !== "tool-result");
      result.push({ role: "user", content: [...rest, ...unmatched.map((r) => ({ type: "tool-result", ...r }))] });
    }
  }
  for (const item of plan) {
    if (item.kind === "text") {
      result.push(item.msg);
    } else if (item.kind === "calls") {
      result.push(item.msg);
      for (const c of item.calls) {
        for (const r of callIndex.get(c.id)?.pendingResults ?? []) {
          result.push({ role: "user", content: [{ type: "tool-result", ...r }] });
        }
      }
    }
  }
  return result;
}

// src/parsers/codex.js
import { readFileSync as readFileSync2 } from "node:fs";
function mapBlock2(block) {
  switch (block.type) {
    case "input_text":
    case "output_text":
    case "text":
    case "summary_text":
      return { type: "text", text: block.text ?? "" };
    case "tool_call":
      return { type: "tool-call", id: block.id, name: block.name ?? "tool", arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {}) };
    case "tool_use":
      return { type: "tool-call", id: block.id, name: block.name, arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}) };
    case "function_call":
      return { type: "tool-call", id: block.call_id ?? block.id, name: block.name, arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {}) };
    case "function_call_output":
      return { type: "tool-result", toolCallId: block.call_id, content: mapBlocks(block.output) };
    case "reasoning":
      return { type: "reasoning", text: block.summary ?? block.text ?? "" };
    default:
      return { type: "text", text: `[${block.type}] ` + JSON.stringify(block) };
  }
}
function mapBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: JSON.stringify(content ?? "") }];
  return content.map(mapBlock2);
}
function extractToolArguments(p) {
  const raw = typeof p.arguments === "string" ? p.arguments : typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {});
  if (typeof raw !== "string") return raw;
  if (!raw.includes("exec_command(")) {
    return JSON.stringify({ note: "codex \u5185\u90E8\u5DE5\u5177\u8C03\u7528\uFF08\u53C2\u6570\u4E3A JS \u4EE3\u7801\uFF0C\u672A\u8F6C\u6362\uFF09" });
  }
  let start = raw.indexOf("exec_command(");
  start = raw.indexOf("{", start);
  if (start === -1) return JSON.stringify({ note: "codex \u5185\u90E8\u5DE5\u5177\u8C03\u7528\uFF08\u53C2\u6570\u4E3A JS \u4EE3\u7801\uFF0C\u672A\u8F6C\u6362\uFF09" });
  let depth = 0, end = -1;
  let inStr = false, strCh = "";
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = true;
      strCh = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return raw;
  const objText = raw.slice(start, end + 1);
  try {
    const jsonText = objText.replace(/`/g, '"').replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"').replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/,\s*}/g, "}");
    const parsed = JSON.parse(jsonText);
    return JSON.stringify(parsed);
  } catch {
    try {
      return JSON.stringify(JSON.parse(objText));
    } catch {
      return JSON.stringify({ note: "codex \u5185\u90E8\u5DE5\u5177\u8C03\u7528\uFF08\u53C2\u6570\u4E3A JS \u4EE3\u7801\uFF0C\u672A\u8F6C\u6362\uFF09" });
    }
  }
}
function parseCodex(filePath) {
  const lines = readFileSync2(filePath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const messages = [];
  let cwd;
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const t = record.type;
    const p = record.payload ?? {};
    if (t === "session_meta" || t === "turn_context") {
      if (!cwd && p.cwd) cwd = p.cwd;
      continue;
    }
    if (t !== "response_item") continue;
    const itemType = p.type;
    const role = p.role;
    const content = mapBlocks(p.content);
    if (itemType === "message") {
      if (role === "developer") {
        continue;
      }
      if (role === "user") {
        const text = content.map((b) => b.text ?? "").join("");
        if (text.includes("<environment_context>")) continue;
        messages.push({ role: "user", content });
      } else if (role === "assistant") {
        messages.push({ role: "assistant", content, model: p.model ?? "codex" });
      }
    } else if (itemType === "function_call" || itemType === "tool_call" || itemType === "custom_tool_call") {
      const callId = p.call_id ?? p.id;
      messages.push({
        role: "assistant",
        content: [{
          type: "tool-call",
          id: callId,
          name: p.name ?? "tool",
          arguments: extractToolArguments(p)
        }]
      });
    } else if (itemType === "function_call_output" || itemType === "tool_call_output" || itemType === "custom_tool_call_output") {
      messages.push({
        role: "user",
        content: [{ type: "tool-result", toolCallId: p.call_id ?? p.id, content: mapBlocks(p.output) }]
      });
    }
  }
  return { messages, cwd };
}

// src/parsers/reasonix.js
import { readFileSync as readFileSync3, existsSync } from "node:fs";
function parseReasonix(filePath) {
  const lines = readFileSync3(filePath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const messages = [];
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const role = record.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = [];
    if (record.content) content.push({ type: "text", text: typeof record.content === "string" ? record.content : JSON.stringify(record.content) });
    if (record.reasoning_content) content.push({ type: "reasoning", text: typeof record.reasoning_content === "string" ? record.reasoning_content : JSON.stringify(record.reasoning_content) });
    if (Array.isArray(record.tool_calls)) {
      for (const tc of record.tool_calls) {
        content.push({ type: "tool-call", id: tc.id ?? `t-${Math.random().toString(36).slice(2, 8)}`, name: tc.function?.name ?? "tool", arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}) });
      }
    }
    let cwd2;
    if (!cwd2) {
      const metaPath = filePath.replace(/\.jsonl$/, ".meta.json");
      if (existsSync(metaPath)) {
        try {
          cwd2 = JSON.parse(readFileSync3(metaPath, "utf8")).workspace;
        } catch {
        }
      }
    }
    messages.push({ role, content, cwd: cwd2 });
  }
  const cwd = messages.find((m) => m.cwd)?.cwd;
  for (const m of messages) delete m.cwd;
  return { messages, cwd };
}

// src/parsers/zcode.js
import { readFileSync as readFileSync4, existsSync as existsSync2 } from "node:fs";
import { join as join3 } from "node:path";
import { DatabaseSync } from "node:sqlite";
function zcodeDbPath() {
  return join3(process.env.USERPROFILE || process.env.HOME || "", ".zcode", "cli", "db", "db.sqlite");
}
function openDb() {
  try {
    return new DatabaseSync(zcodeDbPath(), { readOnly: true });
  } catch {
    return void 0;
  }
}
function mapContent(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [{ type: "text", text: JSON.stringify(content ?? "") }];
  const blocks = [];
  for (const block of content) {
    if (typeof block === "string") {
      blocks.push({ type: "text", text: block });
    } else if (block.type === "text") {
      blocks.push({ type: "text", text: block.text ?? "" });
    } else if (block.type === "tool_result" || block.type === "tool-result") {
      blocks.push({ type: "tool-result", toolCallId: block.tool_call_id ?? block.toolCallId, content: mapContent(block.content ?? block.output ?? ""), isError: block.is_error === true });
    } else if (block.type === "image") {
      blocks.push({ type: "text", text: "[image attachment]" });
    } else {
      blocks.push({ type: "text", text: `[${block.type}] ` + JSON.stringify(block) });
    }
  }
  return blocks;
}
function parseFromDb(sessionId) {
  const db = openDb();
  if (!db) throw new Error("\u65E0\u6CD5\u6253\u5F00 zcode \u6570\u636E\u5E93: " + zcodeDbPath());
  try {
    const sess = db.prepare("SELECT id, directory, title FROM session WHERE id = ?").get(sessionId);
    if (!sess) throw new Error("zcode \u4F1A\u8BDD\u4E0D\u5B58\u5728: " + sessionId);
    const msgRows = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY sequence").all(sessionId);
    const partStmt = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY sequence");
    const messages = [];
    for (const m of msgRows) {
      let msg;
      try {
        msg = JSON.parse(m.data);
      } catch {
        continue;
      }
      const role = msg.role;
      if (role !== "user" && role !== "assistant") continue;
      const parts = [];
      let compactInfo = null;
      for (const p of partStmt.all(m.id)) {
        let part;
        try {
          part = JSON.parse(p.data);
        } catch {
          continue;
        }
        if (part.type === "text") {
          parts.push({ type: "text", text: part.text ?? "" });
        } else if (part.type === "tool") {
          const callId = part.callID ?? `t-${Math.random().toString(36).slice(2, 8)}`;
          const state = part.state ?? {};
          const isError = state.status === "failed" || state.status === "error";
          parts.push({ type: "tool-call", id: callId, name: part.tool ?? "tool", arguments: JSON.stringify(state.input ?? {}) });
          const output = state.output ?? "";
          if (output || isError) {
            parts.push({ type: "tool-result", toolCallId: callId, content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }], isError });
          }
        } else if (part.type === "compaction") {
          const b = part.compactBoundary ?? {};
          compactInfo = {
            summarized: b.summarizedMessageCount ?? part.summarizedMessageCount,
            kept: b.keptMessageCount ?? part.keptMessageCount,
            pre: part.preCompactTokenCount ?? b.preCompactTokenCount,
            post: part.truePostCompactTokenCount ?? b.truePostCompactTokenCount
          };
        }
      }
      if (msg.summary && typeof msg.summary.body === "string" && msg.summary.body.trim()) {
        const c = compactInfo ?? {};
        const meta = c.summarized ? `\uFF08zcode \u5DF2\u81EA\u52A8\u538B\u7F29\u6B64\u524D ${c.summarized} \u6761\u6D88\u606F\uFF0Ctoken ${c.pre ?? "?"} \u2192 ${c.post ?? "?"}\uFF09
` : "\uFF08zcode \u5DF2\u81EA\u52A8\u538B\u7F29\u6B64\u524D\u7684\u5BF9\u8BDD\uFF09\n";
        parts.push({ type: "text", text: meta + msg.summary.body.trim() });
      }
      if (parts.length === 0) continue;
      const text = parts.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (role === "user" && text.includes("<system-reminder>")) continue;
      messages.push({ role, content: parts, model: msg.modelID });
    }
    return { messages, cwd: sess.directory, title: sess.title };
  } finally {
    try {
      db.close();
    } catch {
    }
  }
}
function parseFromFile(transcriptPath) {
  const metaPath = transcriptPath.replace(/transcript\.jsonl$/, "metadata.json");
  let cwd;
  let title;
  if (existsSync2(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync4(metaPath, "utf8"));
      cwd = meta.cwd;
      title = meta.title;
    } catch {
    }
  }
  const lines = readFileSync4(transcriptPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  let lastMessages = [];
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "model_request" && Array.isArray(record.payload?.messages)) {
      lastMessages = record.payload.messages;
    }
  }
  const messages = [];
  for (const msg of lastMessages) {
    const role = msg.role;
    if (role === "system") continue;
    if (role === "user" || role === "assistant") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      if (role === "user" && text.includes("<system-reminder>")) continue;
      const content = mapContent(msg.content);
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: "tool-call",
            id: tc.id ?? `t-${Math.random().toString(36).slice(2, 8)}`,
            name: tc.function?.name ?? "tool",
            arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {})
          });
        }
      }
      messages.push({ role, content, model: msg.model });
    } else if (role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool-result", toolCallId: msg.tool_call_id ?? `t-${Math.random().toString(36).slice(2, 8)}`, content: mapContent(msg.content) }]
      });
    }
  }
  return { messages, cwd, title };
}
function parseZcode(path) {
  if (typeof path === "string" && path.startsWith("zcode://")) {
    return parseFromDb(path.slice("zcode://".length));
  }
  if (typeof path === "string") {
    const db = openDb();
    if (db) {
      try {
        const exists = db.prepare("SELECT id FROM session WHERE id = ?").get(path);
        if (exists) {
          const r = parseFromDb(path);
          if (r.messages.length > 0) return r;
        }
      } catch {
      } finally {
        try {
          db.close();
        } catch {
        }
      }
    }
  }
  return parseFromFile(path);
}

// src/to-session-events.js
var seq = 0;
var turn = 0;
var step = 0;
var turnOpen = false;
var stepOpen = false;
var baseTime = 0;
var outstanding = /* @__PURE__ */ new Set();
function reset() {
  seq = 0;
  turn = 0;
  step = 0;
  turnOpen = false;
  stepOpen = false;
  outstanding = /* @__PURE__ */ new Set();
  baseTime = Date.now();
}
function push(type, data, extra) {
  return { type, seq: seq++, time: baseTime + seq, data, ...extra ?? {} };
}
function openTurn() {
  turn += 1;
  step = 0;
  turnOpen = true;
  return push("turn/start", { turn, trigger: { kind: "message", source: { kind: "user" } } });
}
function closeTurn() {
  if (!turnOpen) return [];
  turnOpen = false;
  return [push("turn/end", { turn, reason: { kind: "completed" } })];
}
function openStep() {
  step += 1;
  stepOpen = true;
  return push("step/start", { turn, step });
}
function closeStep() {
  if (!stepOpen) return [];
  stepOpen = false;
  return [push("step/end", { turn, step })];
}
function finalizeStep() {
  const out = [];
  for (const callId of outstanding) {
    out.push(push("tool/result", {
      turn,
      step,
      message: {
        id: `import-tool-${seq}`,
        role: "tool",
        toolCallId: callId,
        isError: true,
        content: [{ type: "text", text: "The tool call was interrupted in the source transcript and no result was recorded. Retry it if it is still needed." }],
        source: { kind: "tool", callId }
      }
    }, { surfaceOp: "append" }));
  }
  outstanding.clear();
  out.push(...closeStep());
  return out;
}
function toSessionEvents(messages, sessionTitle) {
  reset();
  const events = [];
  if (sessionTitle && typeof sessionTitle === "string" && sessionTitle.trim()) {
    events.push(push("session/title", {
      title: sessionTitle.trim(),
      messageSeqs: [],
      source: { kind: "user" }
    }));
  }
  let pending = null;
  const flushPending = () => {
    if (!pending) return;
    if (stepOpen) events.push(...finalizeStep());
    if (!turnOpen) events.push(openTurn());
    events.push(openStep());
    const content = [...pending.textBlocks, ...pending.calls];
    if (content.length > 0) {
      events.push(push("assistant/message", {
        turn,
        step,
        stream: [],
        message: {
          id: `import-assistant-${seq}`,
          role: "assistant",
          content,
          source: { kind: "model", provider: "imported", model: pending.model ?? "imported" }
        },
        ...pending.usage ? { usage: {
          inputTokens: Number(pending.usage.input_tokens ?? 0) || 0,
          outputTokens: Number(pending.usage.output_tokens ?? 0) || 0,
          ...Number(pending.usage.cache_read_input_tokens ?? 0) ? { cacheReadTokens: Number(pending.usage.cache_read_input_tokens) } : {},
          ...Number(pending.usage.cache_creation_input_tokens ?? 0) ? { cacheWriteTokens: Number(pending.usage.cache_creation_input_tokens) } : {},
          ...Number(pending.usage.reasoning_tokens ?? 0) ? { reasoningTokens: Number(pending.usage.reasoning_tokens) } : {}
        } } : {}
      }, { surfaceOp: "append" }));
    }
    for (const block of pending.calls) {
      events.push(push("tool/call", {
        turn,
        step,
        callId: block.id,
        name: block.name,
        arguments: block.arguments
      }));
      outstanding.add(block.id);
    }
    if (pending.calls.length === 0) events.push(...closeStep());
    pending = null;
  };
  const emitToolResult = (block) => {
    if (!turnOpen) events.push(openTurn());
    if (!stepOpen) events.push(openStep());
    events.push(push("tool/result", {
      turn,
      step,
      message: {
        id: `import-tool-${seq}`,
        role: "tool",
        toolCallId: block.toolCallId,
        content: Array.isArray(block.content) ? block.content : [{ type: "text", text: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "") }],
        ...block.isError === true ? { isError: true } : {},
        source: { kind: "tool", callId: block.toolCallId }
      }
    }, { surfaceOp: "append" }));
    outstanding.delete(block.toolCallId);
    if (outstanding.size === 0 && stepOpen) events.push(...closeStep());
  };
  for (const message of messages) {
    const tools = message.content.filter((b) => b.type === "tool-call" || b.type === "tool-result");
    const textBlocks = message.content.filter((b) => b.type === "text" || b.type === "reasoning" || b.type === "image");
    const calls = tools.filter((b) => b.type === "tool-call");
    const results = tools.filter((b) => b.type === "tool-result");
    if (message.role === "assistant") {
      if (!pending) {
        pending = { textBlocks: [], calls: [], model: void 0, usage: void 0 };
      }
      pending.textBlocks.push(...textBlocks);
      for (const c of calls) pending.calls.push(c);
      if (!pending.model && message.model) pending.model = message.model;
      if (!pending.usage && message.usage) pending.usage = message.usage;
      if (results.length > 0 && pending.calls.length > 0) {
        flushPending();
        for (const r of results) emitToolResult(r);
      }
      continue;
    }
    if (message.role === "user") {
      if (results.length > 0) {
        const pendingCallIds = new Set((pending?.calls ?? []).map((c) => c.id));
        const matched = [];
        const orphans = [];
        for (const r of results) {
          if (pendingCallIds.has(r.toolCallId) || outstanding.has(r.toolCallId)) matched.push(r);
          else orphans.push(r);
        }
        if (orphans.length > 0) {
          console.log(`[session-import] \u4E22\u5F03 ${orphans.length} \u4E2A\u5B64\u513F\u5DE5\u5177\u7ED3\u679C\uFF08\u65E0\u5BF9\u5E94\u8C03\u7528\uFF09`);
        }
        if (matched.length > 0) {
          if (pending && pending.calls.length > 0) flushPending();
          for (const r of matched) emitToolResult(r);
        }
        const realText = textBlocks.filter((b) => b.type === "text" && b.text.trim());
        if (realText.length > 0) {
          if (stepOpen) events.push(...finalizeStep());
          if (!turnOpen) events.push(openTurn());
          if (!stepOpen) events.push(openStep());
          events.push(push("user/message", {
            id: `import-user-${seq}`,
            role: "user",
            content: textBlocks,
            source: { kind: "user" }
          }, { surfaceOp: "append" }));
          events.push(...closeStep());
        }
        continue;
      }
      if (pending && pending.calls.length > 0) flushPending();
      if (stepOpen) events.push(...finalizeStep());
      outstanding.clear();
      const text = textBlocks.map((b) => b.text ?? "").join("");
      if (text.includes("<system-reminder>") && !text.replace(/<[^>]+>/g, "").trim()) continue;
      events.push(...closeTurn(), openTurn(), openStep());
      events.push(push("user/message", {
        id: `import-user-${seq}`,
        role: "user",
        content: textBlocks,
        source: { kind: "user" }
      }, { surfaceOp: "append" }));
      events.push(...closeStep());
    }
  }
  flushPending();
  if (stepOpen) events.push(...finalizeStep());
  events.push(...closeTurn());
  validateLifecycle(events);
  return events;
}
function validateLifecycle(events) {
  let activeTurn = null;
  let activeStep = null;
  const calls = /* @__PURE__ */ new Set();
  for (const event of events) {
    const { type, data } = event;
    if (type === "turn/start") {
      if (activeTurn !== null) throw new Error("\u5BFC\u5165\u4F1A\u8BDD\u7684 turn \u672A\u95ED\u5408");
      activeTurn = data.turn;
    } else if (type === "step/start") {
      if (activeTurn !== data.turn || activeStep !== null) throw new Error("\u5BFC\u5165\u4F1A\u8BDD\u7684 step \u987A\u5E8F\u65E0\u6548");
      activeStep = data.step;
    } else if (type === "tool/call") {
      if (activeTurn !== data.turn || activeStep !== data.step || calls.has(data.callId)) throw new Error("\u5BFC\u5165\u4F1A\u8BDD\u7684\u5DE5\u5177\u8C03\u7528\u65E0\u6548");
      calls.add(data.callId);
    } else if (type === "tool/result") {
      const callId = data.message?.toolCallId;
      if (activeTurn !== data.turn || activeStep !== data.step || !calls.delete(callId)) throw new Error("\u5BFC\u5165\u4F1A\u8BDD\u7684\u5DE5\u5177\u7ED3\u679C\u6CA1\u6709\u5BF9\u5E94\u8C03\u7528");
    } else if (type === "step/end") {
      if (activeTurn !== data.turn || activeStep !== data.step || calls.size) throw new Error("\u5BFC\u5165\u4F1A\u8BDD\u7684 step \u6216\u5DE5\u5177\u8C03\u7528\u672A\u95ED\u5408");
      activeStep = null;
    } else if (type === "turn/end") {
      if (activeTurn !== data.turn || activeStep !== null) throw new Error("\u5BFC\u5165\u4F1A\u8BDD\u7684 turn \u6216 step \u672A\u95ED\u5408");
      activeTurn = null;
    }
  }
  if (activeTurn !== null || activeStep !== null || calls.size) throw new Error("\u5BFC\u5165\u4F1A\u8BDD\u7684\u4E8B\u4EF6\u672A\u95ED\u5408");
}

// src/index.js
var name = "dsh-plugin-session-import";
var inject = ["commands", "agents", "workspaceRegistry", "webServer", "agentDefaultModel", "llm", "agentPresets"];
var PARSERS = {
  "claude-code": parseClaudeCode,
  "claude": parseClaudeCode,
  "codex": parseCodex,
  "reasonix": parseReasonix,
  "zcode": parseZcode
};
function findJsonlBySessionId(cliSessionId) {
  const root = join4(process.env.USERPROFILE || process.env.HOME || homedir2(), ".claude", "projects");
  if (!existsSync3(root)) return void 0;
  let found;
  const walk = (d) => {
    if (found) return;
    let entries;
    try {
      entries = readdirSync2(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join4(d, entry);
      if (isClaudeSubagent(full)) continue;
      try {
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".jsonl") && full.includes(cliSessionId)) {
          found = full;
          return;
        }
      } catch {
      }
    }
  };
  walk(root);
  return found;
}
function extractProject(tool, path) {
  const parts = path.replaceAll("\\", "/").split("/");
  const name2 = parts[parts.length - 1];
  if (tool === "codex") {
    const m = path.match(/sessions[\\\/](\d{4})[\\\/](\d{2})/);
    return m ? m[1] + "-" + m[2] : name2.slice(0, 16);
  }
  if (tool === "reasonix") {
    if (path.includes("projects")) {
      const m = path.match(/projects[\\\/]([^\\\/]+)[\\\/]sessions/);
      return m ? m[1].replace(/-/g, " ").slice(0, 20) : name2.slice(0, 16);
    }
    return name2.replace(/\.jsonl$/, "").slice(0, 20);
  }
  if (tool === "zcode") {
    const m = path.match(/agents[\\\/](sess_[a-z0-9-]+)[\\\/]/);
    return m ? m[1].slice(0, 20) : name2.slice(0, 16);
  }
  if (tool === "claude-code") {
    const m = path.match(/projects[\\\/]([^\\\/]+)[\\\/]/);
    return m ? m[1].replace(/-/g, " ").slice(0, 24) : name2.slice(0, 16);
  }
  return name2.slice(0, 16);
}
function extractTitle(path) {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(262144);
    const n = readSync(fd, buf, 0, 262144, 0);
    closeSync(fd);
    const lines = buf.toString("utf8", 0, n).split(/\r?\n/).filter((l) => l.trim());
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (d.isSidechain === true || d.payload?.role === "developer") continue;
        if (Array.isArray(d.messages)) {
          const firstUser = d.messages.find((m) => (m.role === "user" || m.role === "human") && typeof m.content === "string");
          if (firstUser) {
            const clean2 = firstUser.content.replace(/<[^>]+>/g, "").trim();
            if (clean2 && clean2.length > 3) return clean2.slice(0, 60);
          }
          continue;
        }
        const role = d.role ?? d.payload?.role ?? d.message?.role;
        if (role === "assistant" || role === "system" || role === "developer") continue;
        if (d.type === "assistant") continue;
        if (d.type === "model_request" && d.payload?.role === "assistant") continue;
        const content = d.message?.content ?? d.payload?.messages ?? d.payload?.content ?? d.content;
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b.text ?? "").join(" ") : Array.isArray(d.payload?.messages) ? d.payload.messages.map((m) => typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => b.text ?? "").join(" ")).join(" ") : "";
        if (text.includes("<environment_context>") || text.includes("<system-reminder>")) continue;
        if (text.includes("# Files mentioned by the user")) continue;
        if (text.includes("The user is asking about")) continue;
        const clean = text.replace(/<[^>]+>/g, "").trim();
        if (clean && clean.length > 3) return clean.slice(0, 60);
      } catch {
      }
    }
  } catch {
  }
  return "";
}
function isClaudeSubagent(path) {
  return /(?:^|[\\/])subagents(?:[\\/]|$)/i.test(path) || /(?:^|[\\/])agent-[^\\/]+\.jsonl$/i.test(path);
}
function scanAllSessions(tool) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const roots = {
    "claude-code": [join4(home, ".claude", "projects")],
    "codex": [join4(home, ".codex", "sessions")],
    "reasonix": [
      join4(home, ".reasonix", "sessions"),
      join4(home, "AppData", "Roaming", "reasonix", "sessions")
    ],
    "zcode": [join4(home, ".zcode", "cli", "agents")]
  };
  const claude3pRoot = join4(home, "AppData", "Local", "Claude-3p", "claude-code-sessions");
  const reasonixNewRoot = join4(home, "AppData", "Roaming", "reasonix");
  const files = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync2(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join4(d, entry);
      if (tool === "claude-code" && isClaudeSubagent(full)) continue;
      try {
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".jsonl") && !full.endsWith(".meta.json")) files.push(full);
      } catch {
      }
    }
  };
  for (const root of roots[tool] ?? []) {
    if (existsSync3(root)) walk(root);
  }
  let filtered = tool === "zcode" ? [] : tool === "reasonix" ? files.filter((f) => f.includes("code-")) : tool === "codex" ? files.filter((f) => f.includes("rollout-")) : files;
  if (tool === "zcode") {
    const dbPath = join4(home, ".zcode", "cli", "db", "db.sqlite");
    if (existsSync3(dbPath)) {
      try {
        const db = new DatabaseSync2(dbPath, { readOnly: true });
        try {
          const rows = db.prepare(`SELECT id, title, directory, time_updated FROM session WHERE parent_id IS NULL OR parent_id = ''`).all();
          const counts = /* @__PURE__ */ new Map();
          try {
            for (const r of db.prepare(`SELECT session_id, COUNT(*) AS n FROM message WHERE json_extract(data, '$.role') = 'user' GROUP BY session_id`).all()) {
              counts.set(r.session_id, r.n);
            }
          } catch {
          }
          for (const r of rows) {
            filtered.push({
              path: "zcode://" + r.id,
              title: r.title || "(\u65E0\u6807\u9898)",
              updatedAt: r.time_updated || 0,
              project: (r.directory || "").replaceAll("\\", "/").split("/").pop() || "",
              messageCount: counts.get(r.id) ?? 0
            });
          }
        } finally {
          db.close();
        }
      } catch (e) {
        console.error("[session-import] zcode db \u8BFB\u53D6\u5931\u8D25\uFF0C\u56DE\u9000\u6587\u4EF6\u626B\u63CF:", e.message);
        filtered = files.filter((f) => f.endsWith("transcript.jsonl") && !f.includes("sess_subagent"));
      }
    } else {
      filtered = files.filter((f) => f.endsWith("transcript.jsonl") && !f.includes("sess_subagent"));
    }
  }
  if (tool === "claude-code" && existsSync3(claude3pRoot)) {
    const seen = new Set(filtered);
    const walk3p = (d) => {
      let entries;
      try {
        entries = readdirSync2(d);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join4(d, entry);
        try {
          if (statSync(full).isDirectory()) walk3p(full);
          else if (full.endsWith(".json")) {
            try {
              const meta = JSON.parse(readFileSync5(full, "utf8"));
              if (meta.sessionId && meta.cwd) {
                const cliId = meta.cliSessionId;
                const msgPath = cliId ? findJsonlBySessionId(cliId) : void 0;
                const path = msgPath ?? full;
                if (seen.has(path)) continue;
                seen.add(path);
                filtered.push({
                  path,
                  title: meta.title || "(\u65E0\u6807\u9898)",
                  updatedAt: meta.lastActivityAt || meta.createdAt || 0,
                  project: (meta.cwd || "").replaceAll("\\", "/").split("/").pop() || ""
                });
              }
            } catch {
            }
          }
        } catch {
        }
      }
    };
    walk3p(claude3pRoot);
  }
  if (tool === "reasonix" && existsSync3(join4(reasonixNewRoot, "projects"))) {
    try {
      const topicTitles = {};
      try {
        const t = JSON.parse(readFileSync5(join4(reasonixNewRoot, "global", "desktop-topic-titles.json"), "utf8"));
        for (const [id, title] of Object.entries(t)) {
          const m = id.match(/(?:topic_|desktop-)(\d{8})-(\d{6}|\d{4})/);
          if (m) {
            const key = m[2].length === 6 ? `${m[1]}-${m[2]}` : `${m[1]}${m[2]}`;
            topicTitles[key] = title;
            topicTitles[m[1] + m[2]] = title;
          }
        }
      } catch {
      }
      for (const slug of readdirSync2(join4(reasonixNewRoot, "projects"))) {
        const sessDir = join4(reasonixNewRoot, "projects", slug, "sessions");
        if (!existsSync3(sessDir)) continue;
        let localTitles = {};
        try {
          localTitles = JSON.parse(readFileSync5(join4(sessDir, ".titles.json"), "utf8"));
        } catch {
        }
        const entries = readdirSync2(sessDir);
        const byBase = /* @__PURE__ */ new Map();
        for (const entry of entries) {
          if (!entry.endsWith(".jsonl") || entry.includes(".goal-state")) continue;
          const base = entry.replace(/\.recovery-[^.]+\.jsonl$/, ".jsonl").replace(/\.(events|conflicts)\.jsonl$/, ".jsonl");
          if (entry === base) byBase.set(base, { entry, rank: 0 });
          else if (!byBase.has(base) || entry.endsWith(".events.jsonl") && byBase.get(base).entry.endsWith(".conflicts.jsonl")) {
            byBase.set(base, { entry, rank: 1 });
          }
        }
        for (const { entry } of byBase.values()) {
          const path = join4(sessDir, entry);
          let title = typeof localTitles[entry] === "string" ? localTitles[entry] : "";
          if (!title) {
            const m = entry.match(/desktop-(\d{12})/) ?? entry.match(/^(\d{8}-\d{6})/);
            if (m) title = topicTitles[m[1]] ?? "";
          }
          const ts = entry.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/) ?? entry.match(/desktop-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
          const updatedAt = ts ? Date.UTC(+ts[1], +ts[2] - 1, +ts[3], +ts[4], +ts[5], +(ts[6] ?? 0)) : 0;
          const dirName = slug.replace(/^c--/, "").split("-").pop();
          filtered.push({ path, title, updatedAt, project: dirName || slug.slice(0, 20), cwd: decodeSlugPath(slug) });
        }
      }
    } catch {
    }
  }
  const sessions = filtered.map((entry) => {
    if (typeof entry === "object" && entry !== null) {
      return { path: entry.path, title: entry.title || "(\u65E0\u6807\u9898)", updatedAt: entry.updatedAt || 0, project: entry.project || "", messageCount: entry.messageCount, cwd: entry.cwd };
    }
    let updatedAt = 0;
    try {
      updatedAt = statSync(entry).mtimeMs;
    } catch {
    }
    return { path: entry, title: "", updatedAt: Math.round(updatedAt), project: extractProject(tool, entry) };
  });
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}
var _scanCache = {};
function discoverSessions(tool, offset = 0, limit = 20, query = "") {
  const now = Date.now();
  if (!_scanCache[tool] || now - _scanCache[tool].at > 3e4) {
    const start = Date.now();
    _scanCache[tool] = { at: now, sessions: scanAllSessions(tool) };
    console.log(`[session-import] \u626B\u63CF ${tool}: ${_scanCache[tool].sessions.length} \u4E2A\uFF08${Date.now() - start}ms\uFF09`);
  }
  const all = _scanCache[tool].sessions;
  const q = query.trim().toLowerCase();
  const matched = q ? all.filter((s) => (s.title || "").toLowerCase().includes(q) || (s.project || "").toLowerCase().includes(q) || (s.path || "").toLowerCase().includes(q)) : all;
  const page = matched.slice(offset, offset + limit);
  return page.map((s) => {
    if (s.title && s.title !== "(\u65E0\u6807\u9898)") return s;
    return { ...s, title: extractTitle(s.path) || "(\u65E0\u6807\u9898)" };
  });
}
function estimateTokens(text) {
  let cjk = 0, ascii = 0, other = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code > 11904) cjk++;
    else if (code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122) ascii++;
    else if (code > 32 && code < 127) other++;
  }
  return (cjk + ascii / 4 + other / 8) * 2;
}
function messageTokens(msg) {
  let total = 0;
  for (const b of msg.content ?? []) {
    if (b.type === "text") total += estimateTokens(b.text);
    else if (b.type === "reasoning") total += estimateTokens(b.text);
    else if (b.type === "tool-call") total += estimateTokens(String(b.arguments ?? ""));
    else if (b.type === "tool-result") total += estimateTokens(JSON.stringify(b.content ?? ""));
    else if (b.type === "image") total += estimateTokens(String(b.data ?? ""));
  }
  return total;
}
var CONTEXT_BUDGET = Number(process.env.DSH_IMPORT_CONTEXT_BUDGET) || 55e4;
async function resolveModelBudget(ctx) {
  try {
    const sel = ctx.agentDefaultModel?.currentSelection?.();
    if (!sel?.provider || !sel?.model || !ctx.llm?.resolveModelInfo) return void 0;
    const info = await ctx.llm.resolveModelInfo(sel.provider, sel.model, void 0);
    const window = info?.context?.contextWindow;
    if (!window || window <= 0) return void 0;
    const headroom = Math.max(Math.floor(window * 0.25), 4e4);
    const budget = window - (info.defaultMaxTokens ?? Math.floor(window * 0.3)) - headroom;
    return { budget: Math.max(budget, 5e4), provider: sel.provider, model: sel.model };
  } catch {
    return void 0;
  }
}
var MAX_TEXT_CHARS = 16e3;
var MAX_TOOL_RESULT_CHARS = 4e4;
function cropText(text, maxChars, headRatio = 0.75) {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  const head = Math.floor(maxChars * headRatio);
  const tail = maxChars - head;
  return text.slice(0, head) + `
\u2026[\u5DF2\u622A\u65AD ${text.length - maxChars} \u5B57\u7B26]\u2026
` + text.slice(-tail);
}
function cropBlock(block) {
  if (block.type === "text") {
    return { ...block, text: cropText(block.text, MAX_TEXT_CHARS) };
  }
  if (block.type === "reasoning") {
    return { ...block, text: cropText(block.text, MAX_TEXT_CHARS) };
  }
  if (block.type === "tool-result") {
    return { ...block, content: Array.isArray(block.content) ? block.content.map(cropBlock) : cropText(block.content, MAX_TOOL_RESULT_CHARS) };
  }
  if (block.type === "tool-call") {
    return { ...block, arguments: cropText(block.arguments, MAX_TEXT_CHARS) };
  }
  return block;
}
function trimOversized(messages, budget = CONTEXT_BUDGET) {
  const cropped = messages.map((m) => ({ ...m, content: (m.content ?? []).map(cropBlock) }));
  let total = 0;
  for (const m of cropped) total += messageTokens(m);
  if (total <= budget) return { messages: cropped, trimmed: 0 };
  const isSummary = (m) => m.content?.some((b) => b.type === "text" && String(b.text).includes("zcode \u5DF2\u81EA\u52A8\u538B\u7F29"));
  const anchors = [];
  for (const m of cropped) {
    if (m.role !== "user") continue;
    if (m.content?.some((b) => b.type === "text" && b.text.trim())) anchors.push(m);
    if (anchors.length >= 3) break;
  }
  const kept = new Set(anchors.map((m) => m));
  const keptArr = [];
  let keptTokens = 0;
  for (const m of anchors) keptTokens += messageTokens(m);
  for (let i = cropped.length - 1; i >= 0; i--) {
    const m = cropped[i];
    if (kept.has(m)) continue;
    const tokens = messageTokens(m);
    if (tokens > budget / 2 && !isSummary(m)) continue;
    if (keptTokens + tokens > budget && keptArr.length > 0 && !isSummary(m)) {
      continue;
    }
    keptArr.push(m);
    keptTokens += tokens;
    if (keptTokens >= budget) break;
  }
  const keptSet = new Set(keptArr);
  const result = cropped.filter((m) => kept.has(m) || keptSet.has(m));
  return { messages: result, trimmed: messages.length - result.length };
}
async function importOne(ctx, tool, path, agentOptions, hintCwd, hintTitle) {
  const parse = PARSERS[tool];
  if (!parse) throw new Error("\u672A\u77E5\u5DE5\u5177: " + tool);
  const { messages: rawMessages, cwd: parsedCwd, title: parsedTitle } = parse(path);
  const cwd = parsedCwd || hintCwd;
  if (!rawMessages || rawMessages.length === 0) throw new Error("\u6CA1\u6709\u53EF\u5BFC\u5165\u7684\u6D88\u606F");
  const cachedTitle = _scanCache[tool]?.sessions?.find((s) => s.path === path)?.title;
  let sessionTitle = hintTitle || parsedTitle || cachedTitle || (typeof path === "string" && !path.startsWith("zcode://") ? extractTitle(path) : "") || "";
  if (!sessionTitle && rawMessages?.length) {
    const firstUser = rawMessages.find((m) => m.role === "user");
    if (firstUser) {
      const text = firstUser.content?.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
      if (text) sessionTitle = text.replace(/<[^>]+>/g, "").trim().slice(0, 60);
    }
  }
  const modelBudget = await resolveModelBudget(ctx);
  const budget = modelBudget?.budget ?? CONTEXT_BUDGET;
  const { messages, trimmed } = trimOversized(rawMessages, budget);
  if (trimmed > 0) console.log(`[session-import] \u4F1A\u8BDD\u8D85\u957F\uFF0C\u622A\u65AD ${trimmed} \u6761\u5386\u53F2\u6D88\u606F\uFF08\u4FDD\u7559 ${messages.length} \u6761\uFF0C\u9884\u7B97 ${budget}\uFF09`);
  const events = toSessionEvents(messages, sessionTitle);
  const sessionId = `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const homeDir = (process.env.USERPROFILE || process.env.HOME || "").replace(/[\\/]+$/, "");
  const isHome = (p) => homeDir && p && p.replace(/[\\/]+$/, "").toLowerCase() === homeDir.toLowerCase();
  let sessionCwd = cwd && existsSync3(cwd) && !isHome(cwd) ? cwd : void 0;
  if (!sessionCwd && (tool === "claude-code" || tool === "claude")) {
    throw new Error("\u65E0\u6CD5\u786E\u5B9A Claude \u4F1A\u8BDD\u7684\u6709\u6548\u5DE5\u4F5C\u533A\uFF0C\u8BF7\u5148\u6062\u590D\u539F\u9879\u76EE\u76EE\u5F55");
  }
  if (!sessionCwd) {
    let srcDir;
    try {
      srcDir = typeof path === "string" && !path.startsWith("zcode://") ? dirname(path) : void 0;
    } catch {
    }
    if (srcDir && existsSync3(srcDir) && !isHome(srcDir)) sessionCwd = srcDir;
    else sessionCwd = homeDir || process.cwd();
  }
  await ctx.agents.create({
    sessionId,
    meta: {
      cwd: sessionCwd,
      seedLength: events.length
    },
    seed: events,
    agentOptions: {
      ...agentOptions ?? {},
      ...modelBudget ? { provider: modelBudget.provider, model: modelBudget.model } : {}
    },
    // setup 钩子：把 agent 加入默认 preset 的 scope——否则 preset 注册的工具
    //（read/edit/glob/grep 等全部工具）对导入会话不可见，模型收到 0 工具，
    // 只能输出 XML 文本而不是标准 JSON tool_calls
    setup: (agentCtx) => {
      if (ctx.agentPresets?.mount) {
        return ctx.agentPresets.mount(agentCtx).then(() => {
        });
      }
      return void 0;
    }
  });
  let workspaceId;
  if (cwd && existsSync3(cwd)) {
    try {
      const ws = await ctx.workspaceRegistry.create(cwd);
      workspaceId = ws.id ?? ws.workspaceId;
      try {
        await ws.attachSession(sessionId);
      } catch (e) {
        console.error("[session-import] attachSession \u5931\u8D25:", e.message);
      }
    } catch (e) {
      console.error("[session-import] \u5DE5\u4F5C\u533A\u6CE8\u518C\u5931\u8D25:", e.message);
    }
  }
  return { sessionId, messages, events, cwd, workspaceId, trimmed, title: sessionTitle };
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function apply(ctx) {
  const autoTest = process.env.DSH_IMPORT_AUTOTEST;
  if (autoTest) {
    const [tool, ...rest] = autoTest.split("|");
    const path = rest.join("|");
    setTimeout(async () => {
      try {
        const r = await importOne(ctx, tool, path, {});
        console.log("[autotest] \u5BFC\u5165\u6210\u529F:", r.sessionId, r.messages.length, "\u6761\u6D88\u606F");
      } catch (e) {
        console.error("[autotest] \u5BFC\u5165\u5931\u8D25:", e.message);
      }
    }, 3e3);
  }
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api-import/list",
    handler: async (req, res) => {
      try {
        const body = await readBody(req);
        const offset = Number(body.offset ?? 0) || 0;
        const limit = Number(body.limit ?? 20) || 20;
        const sessions = discoverSessions(body.tool ?? "", offset, limit, String(body.query ?? ""));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessions }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
  }), "webserver /api-import/list");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api-import/batch",
    handler: async (req, res) => {
      try {
        const body = await readBody(req);
        const { tool, paths } = body ?? {};
        if (!tool || !Array.isArray(paths) || paths.length === 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "\u7F3A\u5C11 tool \u6216 paths" }));
          return;
        }
        const imported = [];
        const failed = [];
        const cached = _scanCache[tool]?.sessions ?? [];
        const cwdHint = new Map(cached.filter((s) => s.cwd).map((s) => [s.path, s.cwd]));
        const titleHint = new Map(cached.filter((s) => s.title).map((s) => [s.path, s.title]));
        for (const path of paths) {
          try {
            const r = await importOne(ctx, tool, path, {}, cwdHint.get(path), titleHint.get(path));
            imported.push({ path, sessionId: r.sessionId, messages: r.messages.length, events: r.events.length, cwd: r.cwd, trimmed: r.trimmed, title: r.title });
          } catch (e) {
            failed.push({ path, error: e.message });
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, imported, failed }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
  }), "webserver /api-import/batch");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api-import",
    handler: async (req, res) => {
      try {
        const body = await readBody(req);
        const { tool, path, title } = body ?? {};
        if (!tool || !path) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "\u7F3A\u5C11 tool \u6216 path" }));
          return;
        }
        const r = await importOne(ctx, tool, path, {}, void 0, title);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionId: r.sessionId, messages: r.messages.length, events: r.events.length, cwd: r.cwd, title: r.title }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
  }), "webserver /api-import");
  ctx.effect(() => ctx.commands.register({
    name: "import",
    description: "\u5BFC\u5165\u5176\u4ED6\u5DE5\u5177\u7684\u804A\u5929\u8BB0\u5F55\uFF08claude-code / codex / reasonix / zcode\uFF1B\u4F20\u76EE\u5F55\u53EF\u6279\u91CF\uFF09",
    input: { hint: "<claude-code|codex|reasonix|zcode> <\u6587\u4EF6\u6216\u76EE\u5F55\u8DEF\u5F84>" },
    handler: async (invocation) => {
      const { rawInput } = invocation;
      const [tool, ...rest] = String(rawInput ?? "").trim().split(/\s+/);
      const path = rest.join(" ").trim();
      if (!tool || !path) {
        return { kind: "error", text: "\u7528\u6CD5\uFF1A/import <claude-code|codex|reasonix|zcode> <\u6587\u4EF6\u6216\u76EE\u5F55\u8DEF\u5F84>" };
      }
      if (!PARSERS[tool]) {
        return { kind: "error", text: `\u6682\u4E0D\u652F\u6301\u5DE5\u5177 "${tool}"\uFF08\u652F\u6301\uFF1A${Object.keys(PARSERS).join(" / ")}\uFF09` };
      }
      if (!existsSync3(path)) {
        return { kind: "error", text: `\u8DEF\u5F84\u4E0D\u5B58\u5728\uFF1A${path}` };
      }
      try {
        const currentOptions = invocation.agent.options;
        const agentOptions = {
          provider: currentOptions.provider,
          model: currentOptions.model,
          maxTokens: currentOptions.maxTokens
        };
        if (statSync(path).isDirectory()) {
          const all = [];
          const walkDir = (d) => {
            for (const entry of readdirSync2(d)) {
              const full = join4(d, entry);
              if ((tool === "claude-code" || tool === "claude") && isClaudeSubagent(full)) continue;
              try {
                if (statSync(full).isDirectory()) walkDir(full);
                else if (full.endsWith(".jsonl") && !full.endsWith(".meta.json")) all.push(full);
              } catch {
              }
            }
          };
          walkDir(path);
          if (all.length === 0) {
            return { kind: "error", text: `\u76EE\u5F55\u4E0B\u6CA1\u6709\u627E\u5230\u4F1A\u8BDD\u6587\u4EF6\uFF08${path}\uFF09` };
          }
          const imported = [];
          const failed = [];
          for (const file of all) {
            try {
              const r2 = await importOne(ctx, tool, file, agentOptions);
              imported.push(`${r2.sessionId}\uFF08${r2.messages.length} \u6761${r2.cwd ? "\uFF0C\u5DE5\u4F5C\u533A " + r2.cwd : ""}\uFF09`);
            } catch (e) {
              failed.push(`${file}: ${e.message}`);
            }
          }
          const text2 = `[session-import] ${tool} \u6279\u91CF\u5BFC\u5165\u5B8C\u6210\uFF1A\u6210\u529F ${imported.length}/${all.length}
` + imported.map((s) => `  \u2713 ${s}`).join("\n") + (failed.length > 0 ? `
\u5931\u8D25 ${failed.length} \u4E2A\uFF1A
` + failed.slice(0, 5).map((f) => `  \u2717 ${f}`).join("\n") : "");
          return { kind: "success", text: text2 };
        }
        const r = await importOne(ctx, tool, path, agentOptions);
        const users = r.messages.filter((m) => m.role === "user").length;
        const assistants = r.messages.filter((m) => m.role === "assistant").length;
        const text = `[session-import] ${tool}\uFF1A\u5BFC\u5165\u5B8C\u6210 \u2192 \u65B0\u4F1A\u8BDD ${r.sessionId}${r.title ? "\uFF08" + r.title + "\uFF09" : ""}
\uFF08${r.messages.length} \u6761\u6D88\u606F\uFF1A\u7528\u6237 ${users} / \u52A9\u624B ${assistants}\uFF1B${r.events.length} \u4E2A\u4E8B\u4EF6\uFF1B\u6A21\u578B ${currentOptions.model}\uFF09` + (r.cwd ? `
\u5DE5\u4F5C\u533A\uFF1A${r.cwd}` : "");
        return { kind: "success", text };
      } catch (error) {
        return { kind: "error", text: `[session-import] \u5BFC\u5165\u5931\u8D25\uFF1A${error.message}` };
      }
    }
  }), "command import");
}
export {
  apply,
  decodeSlugPath,
  discoverSessions,
  inject,
  name
};
