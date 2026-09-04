/**
 * dsh-plugin-session-import
 * 导入其他 AI 工具的聊天记录（claude-code / codex / reasonix / zcode）。
 * 用法：/import <tool> <path>（传目录批量）；UI：侧边栏"导入会话"按钮
 * 自动测试：DSH_IMPORT_AUTOTEST='<tool>|<path>' 启动时自动导入
 */
import { existsSync, readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseClaudeCode } from './parsers/claude-code.js'
import { parseCodex } from './parsers/codex.js'
import { parseReasonix } from './parsers/reasonix.js'
import { parseZcode } from './parsers/zcode.js'
import { toSessionEvents } from './to-session-events.js'

export const name = 'dsh-plugin-session-import'

export const inject = ['commands', 'agents', 'workspaceRegistry', 'webServer', 'agentDefaultModel', 'llm', 'agentPresets']

const PARSERS = {
  'claude-code': parseClaudeCode,
  'claude': parseClaudeCode,
  'codex': parseCodex,
  'reasonix': parseReasonix,
  'zcode': parseZcode,
}

/** 在 ~/.claude/projects 下按 cliSessionId 找消息 jsonl */
function findJsonlBySessionId(cliSessionId) {
  const root = join(process.env.USERPROFILE || '', '.claude', 'projects')
  if (!existsSync(root)) return undefined
  let found
  const walk = (d) => {
    if (found) return
    let entries
    try { entries = readdirSync(d) } catch { return }
    for (const entry of entries) {
      const full = join(d, entry)
      try {
        if (statSync(full).isDirectory()) walk(full)
        else if (full.endsWith('.jsonl') && full.includes(cliSessionId)) { found = full; return }
      } catch { /* 忽略 */ }
    }
  }
  walk(root)
  return found
}

/** 从文件提取标题（找第一条用户文本消息） */
/** 从会话文件路径提取项目短名（用于列表区分） */
function extractProject(tool, path) {
  const parts = path.replaceAll("\\", "/").split("/")
  const name = parts[parts.length - 1]
  if (tool === 'codex') {
    // sessions/2026/08/13/rollout-xxx → 2026-08（兼容 \ 与 / 分隔符）
    const m = path.match(/sessions[\\\/](\d{4})[\\\/](\d{2})/)
    return m ? m[1] + '-' + m[2] : name.slice(0, 16)
  }
  if (tool === 'reasonix') {
    if (path.includes('projects')) {
      const m = path.match(/projects[\\\/]([^\\\/]+)[\\\/]sessions/)
      return m ? m[1].replace(/-/g, ' ').slice(0, 20) : name.slice(0, 16)
    }
    return name.replace(/\.jsonl$/, '').slice(0, 20)
  }
  if (tool === 'zcode') {
    const m = path.match(/agents[\\\/](sess_[a-z0-9-]+)[\\\/]/)
    return m ? m[1].slice(0, 20) : name.slice(0, 16)
  }
  if (tool === 'claude-code') {
    const m = path.match(/projects[\\\/]([^\\\/]+)[\\\/]/)
    return m ? m[1].replace(/-/g, ' ').slice(0, 24) : name.slice(0, 16)
  }
  return name.slice(0, 16)
}

function extractTitle(path) {
  try {
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(262144)
    const n = readSync(fd, buf, 0, 262144, 0)
    closeSync(fd)
    const lines = buf.toString('utf8', 0, n).split(/\r?\n/).filter((l) => l.trim())
    for (const line of lines) {
      try {
        const d = JSON.parse(line)
        if (d.payload?.role === 'developer') continue
        // reasonix 桌面版：{type:'replace', messages:[{role, content}]} 事件格式
        if (Array.isArray(d.messages)) {
          const firstUser = d.messages.find((m) => (m.role === 'user' || m.role === 'human') && typeof m.content === 'string')
          if (firstUser) {
            const clean = firstUser.content.replace(/<[^>]+>/g, '').trim()
            if (clean && clean.length > 3) return clean.slice(0, 60)
          }
          continue
        }
        // 只取 user 角色的文本（跳过 system/assistant/思考内容）
        const role = d.role ?? d.payload?.role ?? d.message?.role
        if (role === 'assistant' || role === 'system' || role === 'developer') continue
        if (d.type === 'assistant') continue
        if (d.type === 'model_request' && d.payload?.role === 'assistant') continue
        const content = d.message?.content ?? d.payload?.messages ?? d.payload?.content ?? d.content
        const text = typeof content === 'string' ? content
          : Array.isArray(content) ? content.map((b) => b.text ?? '').join(' ')
          : Array.isArray(d.payload?.messages) ? d.payload.messages.map((m) => typeof m.content === 'string' ? m.content : (m.content ?? []).map((b) => b.text ?? '').join(' ')).join(' ')
          : ''
        // 过滤工具注入的上下文（codex environment_context / 系统提醒 / 引用文本）
        if (text.includes('<environment_context>') || text.includes('<system-reminder>')) continue
        if (text.includes('# Files mentioned by the user')) continue
        if (text.includes('The user is asking about')) continue
        const clean = text.replace(/<[^>]+>/g, '').trim()
        if (clean && clean.length > 3) return clean.slice(0, 60)
      } catch { /* 忽略坏行 */ }
    }
  } catch { /* 忽略 */ }
  return ''
}

/**
 * reasonix 项目 slug → 真实路径（贪心解码）。
 * slug 是路径的 `-` 编码（`c--users` → `c:\users`），但目录名本身的 `-`
 * 无法与分隔符区分，因此用磁盘存在性贪心匹配：
 *  1. 剩余所有段整段作为目录名（处理含 `-` 的目录名如 global-workspace）
 *  2. 当前单段
 *  3. 合并后续段（最多 3 段）
 * 返回规范化的绝对路径，或 undefined。
 */
export function decodeSlugPath(slug) {
  try {
    const bs = '\\'
    let rest = slug
    let path = ''
    if (rest.startsWith('c--')) { path = 'c:' + bs; rest = rest.slice(3) }
    else if (rest.startsWith('d--')) { path = 'd:' + bs; rest = rest.slice(3) }
    const parts = rest.split('-')
    let i = 0
    while (i < parts.length) {
      const part = parts[i]
      if (!part) { i++; continue }
      // 1. 剩余所有段整段作为目录名
      const remaining = parts.slice(i).join('-')
      if (existsSync(path + remaining)) { path += remaining + bs; break }
      // 2. 当前单段
      if (existsSync(path + part)) { path += part + bs; i++; continue }
      // 3. 合并后续段（最多 3 段）
      let merged = part
      let j = i + 1
      let found = false
      while (j < parts.length && j - i <= 3) {
        merged += '-' + parts[j]
        if (existsSync(path + merged)) { path += merged + bs; i = j + 1; found = true; break }
        j++
      }
      if (!found) return undefined // 段在文件系统不存在 → 解码失败，不拼垃圾路径
    }
    return path.replace(/[\\/]+$/, '') || undefined
  } catch { return undefined }
}

/** 全量扫描（缓存用）：返回排序后的条目列表 */
function scanAllSessions(tool) {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const roots = {
    'claude-code': [join(home, '.claude', 'projects')],
    'codex': [join(home, '.codex', 'sessions')],
    'reasonix': [
      join(home, '.reasonix', 'sessions'),
      join(home, 'AppData', 'Roaming', 'reasonix', 'sessions'),
    ],
    'zcode': [join(home, '.zcode', 'cli', 'agents')],
  }
  const claude3pRoot = join(home, 'AppData', 'Local', 'Claude-3p', 'claude-code-sessions')
  const reasonixNewRoot = join(home, 'AppData', 'Roaming', 'reasonix')
  const files = []
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d) } catch { return }
    for (const entry of entries) {
      const full = join(d, entry)
      try {
        if (statSync(full).isDirectory()) walk(full)
        else if (full.endsWith('.jsonl') && !full.endsWith('.meta.json')) files.push(full)
      } catch { /* 跳过 */ }
    }
  }
  for (const root of (roots[tool] ?? [])) {
    if (existsSync(root)) walk(root)
  }
  let filtered = tool === 'zcode' ? [] // zcode 完全走 db 索引（下方填充）
    : tool === 'reasonix' ? files.filter((f) => f.includes('code-'))
    : tool === 'codex' ? files.filter((f) => f.includes('rollout-'))
    : files

  // zcode：db.sqlite 是权威索引（主会话标题/目录/时间齐全），优先使用
  if (tool === 'zcode') {
    const dbPath = join(home, '.zcode', 'cli', 'db', 'db.sqlite')
    if (existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true })
        try {
          const rows = db.prepare(`SELECT id, title, directory, time_updated FROM session WHERE parent_id IS NULL OR parent_id = ''`).all()
          const counts = new Map()
          try {
            for (const r of db.prepare(`SELECT session_id, COUNT(*) AS n FROM message WHERE json_extract(data, '$.role') = 'user' GROUP BY session_id`).all()) {
              counts.set(r.session_id, r.n)
            }
          } catch { /* 统计失败不影响列表 */ }
          for (const r of rows) {
            filtered.push({
              path: 'zcode://' + r.id,
              title: r.title || '(无标题)',
              updatedAt: r.time_updated || 0,
              project: (r.directory || '').replaceAll('\\', '/').split('/').pop() || '',
              messageCount: counts.get(r.id) ?? 0,
            })
          }
        } finally { db.close() }
      } catch (e) {
        console.error('[session-import] zcode db 读取失败，回退文件扫描:', e.message)
        filtered = files.filter((f) => f.endsWith('transcript.jsonl') && !f.includes('sess_subagent'))
      }
    } else {
      filtered = files.filter((f) => f.endsWith('transcript.jsonl') && !f.includes('sess_subagent'))
    }
  }

  // claude 新端：从 claude-code-sessions 读标题元数据（去重：msgPath 已在 filtered 的跳过）
  if (tool === 'claude-code' && existsSync(claude3pRoot)) {
    const seen = new Set(filtered)
    const walk3p = (d) => {
      let entries
      try { entries = readdirSync(d) } catch { return }
      for (const entry of entries) {
        const full = join(d, entry)
        try {
          if (statSync(full).isDirectory()) walk3p(full)
          else if (full.endsWith('.json')) {
            try {
              const meta = JSON.parse(readFileSync(full, 'utf8'))
              if (meta.sessionId && meta.cwd) {
                const cliId = meta.cliSessionId
                const msgPath = cliId ? findJsonlBySessionId(cliId) : undefined
                const path = msgPath ?? full
                if (seen.has(path)) continue
                seen.add(path)
                filtered.push({
                  path,
                  title: meta.title || '(无标题)',
                  updatedAt: meta.lastActivityAt || meta.createdAt || 0,
                  project: (meta.cwd || '').replaceAll("\\", "/").split("/").pop() || '',
                })
              }
            } catch { /* 忽略坏 json */ }
          }
        } catch { /* 忽略 */ }
      }
    }
    walk3p(claude3pRoot)
  }

  // reasonix 桌面版：projects/<slug>/sessions 的真实会话 + 标题映射
  if (tool === 'reasonix' && existsSync(join(reasonixNewRoot, 'projects'))) {
    try {
      // 标题映射（按文件名精确查）：每个项目 sessions 目录的 .titles.json 是权威索引
      // 回退：全局 desktop-topic-titles.json（topic 时间戳前缀 → 标题）
      const topicTitles = {}
      try {
        const t = JSON.parse(readFileSync(join(reasonixNewRoot, 'global', 'desktop-topic-titles.json'), 'utf8'))
        for (const [id, title] of Object.entries(t)) {
          // topic_20260715-073343_xxx / legacy_desktop-202606071232-5_xxx
          const m = id.match(/(?:topic_|desktop-)(\d{8})-(\d{6}|\d{4})/)
          if (m) {
            const key = m[2].length === 6 ? `${m[1]}-${m[2]}` : `${m[1]}${m[2]}`
            topicTitles[key] = title
            topicTitles[m[1] + m[2]] = title
          }
        }
      } catch { /* 无标题映射 */ }
      // 每个项目目录的 sessions 扫描
      for (const slug of readdirSync(join(reasonixNewRoot, 'projects'))) {
        const sessDir = join(reasonixNewRoot, 'projects', slug, 'sessions')
        if (!existsSync(sessDir)) continue
        let localTitles = {}
        try { localTitles = JSON.parse(readFileSync(join(sessDir, '.titles.json'), 'utf8')) } catch { /* 无本地标题 */ }
        const entries = readdirSync(sessDir)
        // 同一次会话会产生 .events.jsonl / .conflicts.jsonl / .recovery-*.jsonl 变体，
        // 每个基名只保留一个代表：优先基名本体，否则 .events.jsonl（conflicts/recovery 不单独列）
        const byBase = new Map()
        for (const entry of entries) {
          if (!entry.endsWith('.jsonl') || entry.includes('.goal-state')) continue
          const base = entry
            .replace(/\.recovery-[^.]+\.jsonl$/, '.jsonl')
            .replace(/\.(events|conflicts)\.jsonl$/, '.jsonl')
          if (entry === base) byBase.set(base, { entry, rank: 0 })
          else if (!byBase.has(base) || (entry.endsWith('.events.jsonl') && byBase.get(base).entry.endsWith('.conflicts.jsonl'))) {
            byBase.set(base, { entry, rank: 1 })
          }
        }
        for (const { entry } of byBase.values()) {
          const path = join(sessDir, entry)
          // 标题：本地 .titles.json 精确匹配优先，其次 topic 时间戳回退
          let title = typeof localTitles[entry] === 'string' ? localTitles[entry] : ''
          if (!title) {
            // desktop-202606071232-5.jsonl → 202606071232；20260715-073343.xxx.jsonl → 20260715-073343
            const m = entry.match(/desktop-(\d{12})/) ?? entry.match(/^(\d{8}-\d{6})/)
            if (m) title = topicTitles[m[1]] ?? ''
          }
          const ts = entry.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/) ?? entry.match(/desktop-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/)
          const updatedAt = ts ? Date.UTC(+ts[1], +ts[2]-1, +ts[3], +ts[4], +ts[5], +(ts[6] ?? 0)) : 0
          // project：slug（如 c--users-www13-pycharmprojects-测试区）还原为可读短名
          const dirName = slug.replace(/^c--/, '').split('-').pop()
          filtered.push({ path, title, updatedAt, project: dirName || slug.slice(0, 20), cwd: decodeSlugPath(slug) })
        }
      }
    } catch { /* 忽略 */ }
  }

  const sessions = filtered.map((entry) => {
    if (typeof entry === 'object' && entry !== null) {
      return { path: entry.path, title: entry.title || '(无标题)', updatedAt: entry.updatedAt || 0, project: entry.project || '', messageCount: entry.messageCount, cwd: entry.cwd }
    }
    let updatedAt = 0
    try { updatedAt = statSync(entry).mtimeMs } catch { /* 忽略 */ }
    return { path: entry, title: '', updatedAt: Math.round(updatedAt), project: extractProject(tool, entry) }
  })
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions
}

const _scanCache = {}

/** 分页查询（30s 缓存扫描；标题提取只对当前页做；query 过滤标题/项目/路径） */
export function discoverSessions(tool, offset = 0, limit = 20, query = '') {
  const now = Date.now()
  if (!_scanCache[tool] || now - _scanCache[tool].at > 30000) {
    const start = Date.now()
    _scanCache[tool] = { at: now, sessions: scanAllSessions(tool) }
    console.log(`[session-import] 扫描 ${tool}: ${_scanCache[tool].sessions.length} 个（${Date.now() - start}ms）`)
  }
  const all = _scanCache[tool].sessions
  const q = query.trim().toLowerCase()
  const matched = q
    ? all.filter((s) =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.project || '').toLowerCase().includes(q) ||
        (s.path || '').toLowerCase().includes(q))
    : all
  const page = matched.slice(offset, offset + limit)
  return page.map((s) => {
    if (s.title && s.title !== '(无标题)') return s
    return { ...s, title: extractTitle(s.path) || '(无标题)' }
  })
}

/**
 * 粗略估算文本 token 数。
 * 实测校准：provider 实际计数约为本估算的 1.5~2 倍（ASCII 代码/JSON 密度高，
 * 工具输出（exec 结果）尤其密集），因此内部按估算值 *2.0 折算成
 * "等效实际 token"，预算比较与模型窗口直接对应。
 * 分类：CJK 约 1 token/字；ASCII 字母数字约 1 token/4 字符；
 * 标点/空白约 1 token/8 字符（低估 ASCII 时由 2.0 系数兜底）。
 */
function estimateTokens(text) {
  let cjk = 0, ascii = 0, other = 0
  for (const ch of String(text)) {
    const code = ch.codePointAt(0)
    if (code > 0x2e80) cjk++ // CJK 及全角
    else if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) ascii++
    else if (code > 0x20 && code < 0x7f) other++ // 标点/符号
  }
  return (cjk + ascii / 4 + other / 8) * 2.0
}

/** 估算一条消息的 token 数（文本 + 工具参数/结果，已含 2.0 实测系数） */
function messageTokens(msg) {
  let total = 0
  for (const b of msg.content ?? []) {
    if (b.type === 'text') total += estimateTokens(b.text)
    else if (b.type === 'reasoning') total += estimateTokens(b.text)
    else if (b.type === 'tool-call') total += estimateTokens(String(b.arguments ?? ''))
    else if (b.type === 'tool-result') total += estimateTokens(JSON.stringify(b.content ?? ''))
    else if (b.type === 'image') total += estimateTokens(String(b.data ?? '')) // base64 图片按文本估算
  }
  return total
}

/**
 * 目标模型上下文窗口的 messages 预算（等效实际 token）。
 * 请求开销结构：messages + 模型 defaultMaxTokens 输出预算（Console Go 为 384k）
 * + dsh system prompt/tools（数万）。
 * 默认按 1M 窗口模型保守取值 55 万（等效实际），可被：
 *  1. DSH_IMPORT_CONTEXT_BUDGET 环境变量覆盖（换小窗口模型时设小值）
 *  2. importOne 动态解析：读取 agentDefaultModel + llm.resolveModelInfo，
 *     按实际模型的 contextWindow − defaultMaxTokens − 余量计算
 */
const CONTEXT_BUDGET = Number(process.env.DSH_IMPORT_CONTEXT_BUDGET) || 550000

/** 解析目标模型的上下文窗口与输出预算（失败返回 undefined，不阻塞导入） */
async function resolveModelBudget(ctx) {
  try {
    const sel = ctx.agentDefaultModel?.currentSelection?.()
    if (!sel?.provider || !sel?.model || !ctx.llm?.resolveModelInfo) return undefined
    const info = await ctx.llm.resolveModelInfo(sel.provider, sel.model, undefined)
    const window = info?.context?.contextWindow
    if (!window || window <= 0) return undefined
    // 余量：system prompt/tools 定义 + 输出预算（defaultMaxTokens）+ 安全边际（窗口的 25% 或 40k，取大者）
    const headroom = Math.max(Math.floor(window * 0.25), 40000)
    const budget = window - (info.defaultMaxTokens ?? Math.floor(window * 0.3)) - headroom
    return { budget: Math.max(budget, 50000), provider: sel.provider, model: sel.model }
  } catch { return undefined }
}

/** 单条文本块的最大字符数（约 4000 token），超出裁剪保留头尾 */
const MAX_TEXT_CHARS = 16000
/** 单条工具结果（tool-result）的最大字符数，超出裁剪保留头尾 */
const MAX_TOOL_RESULT_CHARS = 40000

/** 裁剪超长字符串：保留头 + 尾，中间用省略标记 */
function cropText(text, maxChars, headRatio = 0.75) {
  if (typeof text !== 'string' || text.length <= maxChars) return text
  const head = Math.floor(maxChars * headRatio)
  const tail = maxChars - head
  return text.slice(0, head) + `\n…[已截断 ${text.length - maxChars} 字符]…\n` + text.slice(-tail)
}

/** 递归裁剪一个 content 块（text / tool-result 内嵌），限制单条消息体积 */
function cropBlock(block) {
  if (block.type === 'text') {
    return { ...block, text: cropText(block.text, MAX_TEXT_CHARS) }
  }
  if (block.type === 'reasoning') {
    return { ...block, text: cropText(block.text, MAX_TEXT_CHARS) }
  }
  if (block.type === 'tool-result') {
    return { ...block, content: Array.isArray(block.content) ? block.content.map(cropBlock) : cropText(block.content, MAX_TOOL_RESULT_CHARS) }
  }
  if (block.type === 'tool-call') {
    // 工具参数一般不大，但也防一手
    return { ...block, arguments: cropText(block.arguments, MAX_TEXT_CHARS) }
  }
  return block
}

/**
 * 超长会话截断：保留「开头锚点 + 压缩摘要消息 + 尾部消息」，使 seed 在模型窗口内。
 * 三层保障，任何长度的会话都不会超限：
 *  1. 内容裁剪：单条文本/工具结果先裁剪（单条有上限）
 *  2. 消息裁剪：超过预算时从中间丢整条消息（摘要/锚点始终保留）
 *  3. 单条兜底：若某条消息裁剪后仍超预算，直接丢弃（宁可少一条，不可超限）
 * dsh 的自动压缩对无 provider 配置的导入会话不生效（routedTarget 解析失败），
 * 必须在导入时就控制规模，否则恢复对话会直接 400。
 * @param budget - 等效实际 token 预算（默认 CONTEXT_BUDGET）
 * @returns { messages, trimmed } trimmed = 被截掉的消息数
 */
function trimOversized(messages, budget = CONTEXT_BUDGET) {
  // 第 0 步：先对每条消息做内容级裁剪（控制单条体积）
  const cropped = messages.map((m) => ({ ...m, content: (m.content ?? []).map(cropBlock) }))

  let total = 0
  for (const m of cropped) total += messageTokens(m)
  if (total <= budget) return { messages: cropped, trimmed: 0 }

  const isSummary = (m) => m.content?.some((b) => b.type === 'text' && String(b.text).includes('zcode 已自动压缩'))

  // 开头锚点：最早的前 3 条 user 文本消息（保留任务起点上下文）
  const anchors = []
  for (const m of cropped) {
    if (m.role !== 'user') continue
    if (m.content?.some((b) => b.type === 'text' && b.text.trim())) anchors.push(m)
    if (anchors.length >= 3) break
  }

  // 尾部：从后往前收集直到预算；摘要消息和开头锚点始终保留
  const kept = new Set(anchors.map((m) => m))
  const keptArr = []
  let keptTokens = 0
  for (const m of anchors) keptTokens += messageTokens(m)
  for (let i = cropped.length - 1; i >= 0; i--) {
    const m = cropped[i]
    if (kept.has(m)) continue
    const tokens = messageTokens(m)
    // 单条兜底：裁剪后仍超预算一半的消息直接丢弃（极端巨消息，宁缺毋滥）
    if (tokens > budget / 2 && !isSummary(m)) continue
    if (keptTokens + tokens > budget && keptArr.length > 0 && !isSummary(m)) {
      continue // 超出预算且非摘要/锚点，跳过
    }
    keptArr.push(m)
    keptTokens += tokens
    if (keptTokens >= budget) break
  }
  // 合并：锚点 + 尾部（保持原始顺序）
  const keptSet = new Set(keptArr)
  const result = cropped.filter((m) => kept.has(m) || keptSet.has(m))
  return { messages: result, trimmed: messages.length - result.length }
}

async function importOne(ctx, tool, path, agentOptions, hintCwd) {
  const parse = PARSERS[tool]
  if (!parse) throw new Error('未知工具: ' + tool)
  const { messages: rawMessages, cwd: parsedCwd } = parse(path)
  // cwd 优先级：解析器结果 > 扫描提示（reasonix 桌面版 slug 解码）> 兜底
  const cwd = parsedCwd || hintCwd
  if (!rawMessages || rawMessages.length === 0) throw new Error('没有可导入的消息')

  // 动态预算：按默认模型的真实窗口计算；拿不到则用保守默认值
  const modelBudget = await resolveModelBudget(ctx)
  const budget = modelBudget?.budget ?? CONTEXT_BUDGET
  const { messages, trimmed } = trimOversized(rawMessages, budget)
  if (trimmed > 0) console.log(`[session-import] 会话超长，截断 ${trimmed} 条历史消息（保留 ${messages.length} 条，预算 ${budget}）`)
  const events = toSessionEvents(messages)
  const sessionId = `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // 先创建会话（meta.cwd 写入 header），再绑定工作区。
  // agentOptions 绑定默认模型（provider/model）：使 dsh 的自动压缩能对导入会话生效
  //（routedTarget 可解析 → context-overflow 时 compact 重试，双保险兜底）
  // cwd 必须非空：preset 的 persona section 用 {{cwd}} 变量，缺失会报
  // "prompt variable {{cwd}} has no value"。
  // 注意：cwd 不能是用户主目录——workspace=主目录时 dsh 的沙箱 ACL 会拒绝
  //（temp 在 workspace 内），pwsh 等工具直接失败。
  const homeDir = (process.env.USERPROFILE || process.env.HOME || '').replace(/[\\/]+$/, '')
  const isHome = (p) => homeDir && p && p.replace(/[\\/]+$/, '').toLowerCase() === homeDir.toLowerCase()
  let sessionCwd = cwd && existsSync(cwd) && !isHome(cwd) ? cwd : undefined
  if (!sessionCwd) {
    // 回退：源文件目录（reasonix 旧 CLI 会话等无项目 cwd 的情况）；
    // 但源文件目录也是主目录时（~/.reasonix/sessions），用 reasonix 的全局 workspace 目录
    let srcDir
    try { srcDir = typeof path === 'string' && !path.startsWith('zcode://') ? dirname(path) : undefined } catch { /* 忽略 */ }
    if (srcDir && existsSync(srcDir) && !isHome(srcDir)) sessionCwd = srcDir
    else sessionCwd = homeDir || process.cwd()
  }
  await ctx.agents.create({
    sessionId,
    meta: {
      cwd: sessionCwd,
      seedLength: events.length,
    },
    seed: events,
    agentOptions: {
      ...(agentOptions ?? {}),
      ...(modelBudget ? { provider: modelBudget.provider, model: modelBudget.model } : {}),
    },
    // setup 钩子：把 agent 加入默认 preset 的 scope——否则 preset 注册的工具
    //（read/edit/glob/grep 等全部工具）对导入会话不可见，模型收到 0 工具，
    // 只能输出 XML 文本而不是标准 JSON tool_calls
    setup: (agentCtx) => {
      if (ctx.agentPresets?.mount) {
        return ctx.agentPresets.mount(agentCtx).then(() => {})
      }
      return undefined
    },
  })

  // 工作区归属：create 只注册目录，必须 attachSession 才会出现在工作区列表里
  let workspaceId
  if (cwd && existsSync(cwd)) {
    try {
      const ws = await ctx.workspaceRegistry.create(cwd)
      workspaceId = ws.id ?? ws.workspaceId
      try { await ws.attachSession(sessionId) } catch (e) { console.error('[session-import] attachSession 失败:', e.message) }
    } catch (e) { console.error('[session-import] 工作区注册失败:', e.message) }
  }
  return { sessionId, messages, events, cwd, workspaceId, trimmed }
}

/** 读取请求 body 的 JSON */
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

export function apply(ctx) {
  // 自动测试钩子：DSH_IMPORT_AUTOTEST='<tool>|<path>' 时启动即导入
  const autoTest = process.env.DSH_IMPORT_AUTOTEST
  if (autoTest) {
    const [tool, ...rest] = autoTest.split('|')
    const path = rest.join('|')
    setTimeout(async () => {
      try {
        const r = await importOne(ctx, tool, path, {})
        console.log('[autotest] 导入成功:', r.sessionId, r.messages.length, '条消息')
      } catch (e) {
        console.error('[autotest] 导入失败:', e.message)
      }
    }, 3000)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api-import/list',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const offset = Number(body.offset ?? 0) || 0
        const limit = Number(body.limit ?? 20) || 20
        const sessions = discoverSessions(body.tool ?? '', offset, limit, String(body.query ?? ''))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, sessions }))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      }
    },
  }), 'webserver /api-import/list')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api-import/batch',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const { tool, paths } = body ?? {}
        if (!tool || !Array.isArray(paths) || paths.length === 0) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '缺少 tool 或 paths' }))
          return
        }
        const imported = []
        const failed = []
        // 扫描缓存的 cwd 提示（reasonix 桌面版 slug 解码出的真实路径）
        const cached = _scanCache[tool]?.sessions ?? []
        const cwdHint = new Map(cached.filter((s) => s.cwd).map((s) => [s.path, s.cwd]))
        for (const path of paths) {
          try {
            const r = await importOne(ctx, tool, path, {}, cwdHint.get(path))
            imported.push({ path, sessionId: r.sessionId, messages: r.messages.length, events: r.events.length, cwd: r.cwd, trimmed: r.trimmed })
          } catch (e) {
            failed.push({ path, error: e.message })
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, imported, failed }))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      }
    },
  }), 'webserver /api-import/batch')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api-import',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const { tool, path } = body ?? {}
        if (!tool || !path) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '缺少 tool 或 path' }))
          return
        }
        const r = await importOne(ctx, tool, path, {})
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, sessionId: r.sessionId, messages: r.messages.length, events: r.events.length, cwd: r.cwd }))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      }
    },
  }), 'webserver /api-import')

  ctx.effect(() => ctx.commands.register({
    name: 'import',
    description: '导入其他工具的聊天记录（claude-code / codex / reasonix / zcode；传目录可批量）',
    input: { hint: '<claude-code|codex|reasonix|zcode> <文件或目录路径>' },
    handler: async (invocation) => {
      const { rawInput } = invocation
      const [tool, ...rest] = String(rawInput ?? '').trim().split(/\s+/)
      const path = rest.join(' ').trim()
      if (!tool || !path) {
        return { kind: 'error', text: '用法：/import <claude-code|codex|reasonix|zcode> <文件或目录路径>' }
      }
      if (!PARSERS[tool]) {
        return { kind: 'error', text: `暂不支持工具 "${tool}"（支持：${Object.keys(PARSERS).join(' / ')}）` }
      }
      if (!existsSync(path)) {
        return { kind: 'error', text: `路径不存在：${path}` }
      }
      try {
        const currentOptions = invocation.agent.options
        const agentOptions = {
          provider: currentOptions.provider,
          model: currentOptions.model,
          maxTokens: currentOptions.maxTokens,
        }
        if (statSync(path).isDirectory()) {
          const all = []
          const walkDir = (d) => {
            for (const entry of readdirSync(d)) {
              const full = join(d, entry)
              try {
                if (statSync(full).isDirectory()) walkDir(full)
                else if (full.endsWith('.jsonl') && !full.endsWith('.meta.json')) all.push(full)
              } catch { /* 跳过 */ }
            }
          }
          walkDir(path)
          if (all.length === 0) {
            return { kind: 'error', text: `目录下没有找到会话文件（${path}）` }
          }
          const imported = []
          const failed = []
          for (const file of all) {
            try {
              const r = await importOne(ctx, tool, file, agentOptions)
              imported.push(`${r.sessionId}（${r.messages.length} 条${r.cwd ? '，工作区 ' + r.cwd : ''}）`)
            } catch (e) {
              failed.push(`${file}: ${e.message}`)
            }
          }
          const text = `[session-import] ${tool} 批量导入完成：成功 ${imported.length}/${all.length}\n` +
            imported.map((s) => `  ✓ ${s}`).join('\n') +
            (failed.length > 0 ? `\n失败 ${failed.length} 个：\n` + failed.slice(0, 5).map((f) => `  ✗ ${f}`).join('\n') : '')
          return { kind: 'success', text }
        }

        const r = await importOne(ctx, tool, path, agentOptions)
        const users = r.messages.filter((m) => m.role === 'user').length
        const assistants = r.messages.filter((m) => m.role === 'assistant').length
        const text = `[session-import] ${tool}：导入完成 → 新会话 ${r.sessionId}\n` +
          `（${r.messages.length} 条消息：用户 ${users} / 助手 ${assistants}；${r.events.length} 个事件；模型 ${currentOptions.model}）` +
          (r.cwd ? `\n工作区：${r.cwd}` : '')
        return { kind: 'success', text }
      } catch (error) {
        return { kind: 'error', text: `[session-import] 导入失败：${error.message}` }
      }
    },
  }), 'command import')
}
