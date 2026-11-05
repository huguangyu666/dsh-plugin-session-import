/**
 * claude code 会话 JSONL 解析器。
 * 输入：~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * 输出：结构化消息列表 [{ role, content: [{type, text|id|name|arguments|toolCallId|...}], usage?, model? }]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decodeSlugPath } from '../path-decoding.js'

/** 把 claude 的 content block 转成 dsh 风格 block（text/image/tool-call/tool-result） */
function mapBlock(block) {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text ?? '' }
    case 'image': {
      // 图片附件：迁移为真实 image block（mediaType 限 png/jpeg/webp/gif）
      const src = block.source ?? {}
      const mediaType = src.media_type ?? src.mediaType ?? ''
      if (mediaType && /^image\/(png|jpeg|webp|gif)$/.test(mediaType) && typeof src.data === 'string' && src.data.length > 0) {
        return { type: 'image', mediaType, data: src.data }
      }
      // 非支持类型或无数据：降级占位文本
      return { type: 'text', text: '[image attachment]' }
    }
    case 'tool_use':
      return {
        type: 'tool-call',
        id: block.id,
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
      }
    case 'tool_result':
      return {
        type: 'tool-result',
        toolCallId: block.tool_use_id,
        content: Array.isArray(block.content)
          ? block.content.map(mapBlock)
          : [{ type: 'text', text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '') }],
        isError: block.is_error === true,
      }
    case 'thinking':
      return { type: 'reasoning', text: block.thinking ?? '' }
    default:
      // 未知块（如 citations）降级为 JSON 摘要，保证不丢信息
      return { type: 'text', text: `[${block.type}] ` + JSON.stringify(block) }
  }
}

/** 从 claude code 的 projects 目录名解码 cwd（C--Users-www13 → C:Userswww13） */
/** claude 项目目录名 → 真实路径 的映射（读 ~/.claude.json 的 projects 键，权威） */
let cwdMapCache = null
function loadCwdMap() {
  if (cwdMapCache) return cwdMapCache
  const map = {}
  try {
    const cfg = JSON.parse(readFileSync(join(process.env.USERPROFILE || process.env.HOME || homedir(), '.claude.json'), 'utf8'))
    for (const realPath of Object.keys(cfg.projects ?? {})) {
      map[realPath] = realPath
      for (const slug of new Set([realPath.replace(/[\\/._]/g, '-'), realPath.replace(/[^a-zA-Z0-9]/g, '-')])) {
        map[slug] = slug in map && map[slug] !== realPath ? null : realPath
      }
    }
  } catch { /* 无 .claude.json 则回退解码 */ }
  cwdMapCache = map
  return map
}

function decodeCwd(filePath) {
  // 兼容 \ 与 / 分隔符（Windows 路径用反斜杠）
  const m = filePath.match(/projects[\\\/]([^\\\/]+)[\\\/]/)
  if (!m) return undefined
  const dir = m[1]
  // 优先查 .claude.json 中的完整项目路径映射。
  const map = loadCwdMap()
  if (map[dir]) return map[dir]
  // slug 无法唯一还原时只接受磁盘上存在的路径。
  return decodeSlugPath(dir)
}

/** 解析一个 JSONL 文件，返回 { messages, cwd } */
export function parseClaudeCode(filePath) {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter((l) => l.trim())
  const messages = []
  let recordCwd
  for (const line of lines) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.isSidechain === true) continue
    if (!recordCwd && typeof record.cwd === 'string' && record.cwd) recordCwd = record.cwd
    const type = record.type
    const msg = record.message
    if (!msg || typeof msg !== 'object') continue

    if (type === 'user' && msg.role === 'user') {
      // content 可能是数组（block 列表）或纯字符串（简短用户输入）或缺失
      const content = Array.isArray(msg.content)
        ? msg.content.map(mapBlock)
        : [{ type: 'text', text: typeof msg.content === 'string' ? msg.content : '' }]
      // claude 的 tool_result 也是 user 角色消息——保留 block 原样
      messages.push({ role: 'user', content })
    } else if (type === 'assistant' && msg.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: Array.isArray(msg.content)
          ? msg.content.map(mapBlock)
          : [{ type: 'text', text: typeof msg.content === 'string' ? msg.content : '' }],
        usage: msg.usage ?? undefined,
        model: msg.model ?? undefined,
      })
    }
    // system / mode / permission-mode 等元数据事件跳过
  }
  return { messages: reorderToolPairs(messages), cwd: recordCwd || decodeCwd(filePath) }
}

/**
 * 按 callId 全局重排工具调用对。
 * claude 源文件里 tool_use 与其 tool_result 可能跨多条消息分散
 * （assistant[callA] assistant[callB] user[resultB] ... user[resultA] 中间插其他轮次），
 * 违反 OpenAI/DeepSeek API 的「tool 结果必须紧跟其 tool_calls」规则。
 * 两阶段处理：
 *  1. 收集所有含 tool-call 的 assistant 消息（保留原顺序）
 *  2. 遍历所有含 tool-result 的 user 消息，把每个 result 插入到对应 call 的 assistant 之后
 * 无对应 call 的 result（孤儿）与无 result 的 call（dangling）原样保留。
 */
function reorderToolPairs(messages) {
  const result = []
  // 阶段 1：切分消息——纯文本消息原位保留，工具消息提取
  const plan = [] // 有序计划项：{ kind: 'text', msg } | { kind: 'calls', msg } | { kind: 'results', msg }
  for (const msg of messages) {
    const calls = msg.content.filter((b) => b.type === 'tool-call')
    const results = msg.content.filter((b) => b.type === 'tool-result')
    if (msg.role === 'assistant' && calls.length > 0) {
      plan.push({ kind: 'calls', msg, calls })
    } else if (msg.role === 'user' && results.length > 0) {
      plan.push({ kind: 'results', msg, results })
    } else {
      plan.push({ kind: 'text', msg })
    }
  }
  // 阶段 2：把每个 result 挂到对应 calls 项之后（按 callId）
  const callIndex = new Map() // callId → { item, pendingResults: [] }
  for (const item of plan) {
    if (item.kind === 'calls') {
      for (const c of item.calls) callIndex.set(c.id, { item, pendingResults: [] })
    }
  }
  for (const item of plan) {
    if (item.kind !== 'results') continue
    const unmatched = []
    for (const r of item.results) {
      const target = callIndex.get(r.toolCallId)
      if (target) target.pendingResults.push(r)
      else unmatched.push(r)
    }
    if (unmatched.length > 0) {
      // 未匹配的 result：作为普通 user 消息保留（孤儿）
      const rest = item.msg.content.filter((b) => b.type !== 'tool-result')
      result.push({ role: 'user', content: [...rest, ...unmatched.map((r) => ({ type: 'tool-result', ...r }))] })
    }
    // 匹配的部分已挂到 callIndex，不在此输出
  }
  // 阶段 3：按计划顺序输出，calls 项后紧跟其全部结果
  for (const item of plan) {
    if (item.kind === 'text') {
      result.push(item.msg)
    } else if (item.kind === 'calls') {
      result.push(item.msg)
      // 该 assistant 全部 call 的结果，按 callId 顺序输出
      for (const c of item.calls) {
        for (const r of callIndex.get(c.id)?.pendingResults ?? []) {
          result.push({ role: 'user', content: [{ type: 'tool-result', ...r }] })
        }
      }
    }
    // results 项已在阶段 2 输出（仅孤儿部分）
  }
  return result
}
