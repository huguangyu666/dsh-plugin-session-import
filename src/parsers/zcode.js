/**
 * zcode 会话解析器（db 驱动）。
 * 输入：zcode://<sessionId> —— 从 ~/.zcode/cli/db/db.sqlite 读取（权威索引）
 * 兼容回退：transcript.jsonl 文件路径（旧格式，仅当 db 不可用时使用）
 * 输出：{ messages: [...], cwd: string | undefined }
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** zcode 的会话数据库路径 */
export function zcodeDbPath() {
  return join(process.env.USERPROFILE || process.env.HOME || '', '.zcode', 'cli', 'db', 'db.sqlite')
}

/** 只读打开 zcode 数据库（失败返回 undefined，不抛异常） */
function openDb() {
  try {
    return new DatabaseSync(zcodeDbPath(), { readOnly: true })
  } catch { return undefined }
}

function mapContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (!Array.isArray(content)) return [{ type: 'text', text: JSON.stringify(content ?? '') }]
  const blocks = []
  for (const block of content) {
    if (typeof block === 'string') {
      blocks.push({ type: 'text', text: block })
    } else if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text ?? '' })
    } else if (block.type === 'tool_result' || block.type === 'tool-result') {
      blocks.push({ type: 'tool-result', toolCallId: block.tool_call_id ?? block.toolCallId, content: mapContent(block.content ?? block.output ?? ''), isError: block.is_error === true })
    } else if (block.type === 'image') {
      blocks.push({ type: 'text', text: '[image attachment]' })
    } else {
      blocks.push({ type: 'text', text: `[${block.type}] ` + JSON.stringify(block) })
    }
  }
  return blocks
}

/** 从 db 按 sessionId 重建消息流（message + part 表） */
function parseFromDb(sessionId) {
  const db = openDb()
  if (!db) throw new Error('无法打开 zcode 数据库: ' + zcodeDbPath())
  try {
    const sess = db.prepare('SELECT id, directory, title FROM session WHERE id = ?').get(sessionId)
    if (!sess) throw new Error('zcode 会话不存在: ' + sessionId)

    const msgRows = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY sequence').all(sessionId)
    const partStmt = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY sequence')
    const messages = []
    for (const m of msgRows) {
      let msg
      try { msg = JSON.parse(m.data) } catch { continue }
      const role = msg.role
      if (role !== 'user' && role !== 'assistant') continue

      const parts = []
      let compactInfo = null // 压缩标记：{ summarized, kept, pre, post }
      for (const p of partStmt.all(m.id)) {
        let part
        try { part = JSON.parse(p.data) } catch { continue }
        if (part.type === 'text') {
          parts.push({ type: 'text', text: part.text ?? '' })
        } else if (part.type === 'tool') {
          // 工具调用：调用 + 结果成对输出
          const callId = part.callID ?? `t-${Math.random().toString(36).slice(2, 8)}`
          const state = part.state ?? {}
          const isError = state.status === 'failed' || state.status === 'error'
          parts.push({ type: 'tool-call', id: callId, name: part.tool ?? 'tool', arguments: JSON.stringify(state.input ?? {}) })
          const output = state.output ?? ''
          if (output || isError) {
            parts.push({ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }], isError })
          }
        } else if (part.type === 'compaction') {
          // zcode 自动压缩标记：记录压缩统计，供摘要消息展示
          const b = part.compactBoundary ?? {}
          compactInfo = {
            summarized: b.summarizedMessageCount ?? part.summarizedMessageCount,
            kept: b.keptMessageCount ?? part.keptMessageCount,
            pre: part.preCompactTokenCount ?? b.preCompactTokenCount,
            post: part.truePostCompactTokenCount ?? b.truePostCompactTokenCount,
          }
        }
        // reasoning / step-start / step-finish / timeline / file 均跳过
      }
      // 压缩摘要消息：data.summary.body 是 zcode 压缩出的上下文摘要，必须保留
      // （其 text part 只是 "This session is being continued..." 引导语）
      if (msg.summary && typeof msg.summary.body === 'string' && msg.summary.body.trim()) {
        const c = compactInfo ?? {}
        const meta = c.summarized
          ? `（zcode 已自动压缩此前 ${c.summarized} 条消息，token ${c.pre ?? '?'} → ${c.post ?? '?'}）\n`
          : '（zcode 已自动压缩此前的对话）\n'
        parts.push({ type: 'text', text: meta + msg.summary.body.trim() })
      }
      if (parts.length === 0) continue

      const text = parts.filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (role === 'user' && text.includes('<system-reminder>')) continue // 过滤系统注入提醒
      messages.push({ role, content: parts, model: msg.modelID })
    }
    return { messages, cwd: sess.directory, title: sess.title }
  } finally {
    try { db.close() } catch { /* 忽略 */ }
  }
}

/** 兼容回退：旧 transcript.jsonl 文件解析（仅当 db 不可用） */
function parseFromFile(transcriptPath) {
  const metaPath = transcriptPath.replace(/transcript\.jsonl$/, 'metadata.json')
  let cwd
  let title
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      cwd = meta.cwd
      title = meta.title
    } catch { /* 忽略 */ }
  }

  const lines = readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter((l) => l.trim())
  let lastMessages = []
  for (const line of lines) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.type === 'model_request' && Array.isArray(record.payload?.messages)) {
      lastMessages = record.payload.messages
    }
  }

  const messages = []
  for (const msg of lastMessages) {
    const role = msg.role
    if (role === 'system') continue // 跳过系统提示词

    if (role === 'user' || role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')
      if (role === 'user' && text.includes('<system-reminder>')) continue // 过滤系统注入提醒
      const content = mapContent(msg.content)
      // assistant 的 tool_calls（OpenAI 风格）
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool-call',
            id: tc.id ?? `t-${Math.random().toString(36).slice(2, 8)}`,
            name: tc.function?.name ?? 'tool',
            arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
          })
        }
      }
      messages.push({ role, content, model: msg.model })
    } else if (role === 'tool') {
      // 工具结果消息
      messages.push({
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: msg.tool_call_id ?? `t-${Math.random().toString(36).slice(2, 8)}`, content: mapContent(msg.content) }],
      })
    }
  }
  return { messages, cwd, title }
}

export function parseZcode(path) {
  if (typeof path === 'string' && path.startsWith('zcode://')) {
    return parseFromDb(path.slice('zcode://'.length))
  }
  // 兼容：db 可打开时也尝试按 sessionId 解析（目录名即 id）
  if (typeof path === 'string') {
    const db = openDb()
    if (db) {
      try {
        const exists = db.prepare('SELECT id FROM session WHERE id = ?').get(path)
        if (exists) {
          const r = parseFromDb(path)
          if (r.messages.length > 0) return r
        }
      } catch { /* 忽略，走文件回退 */ } finally {
        try { db.close() } catch { /* 忽略 */ }
      }
    }
  }
  return parseFromFile(path)
}
