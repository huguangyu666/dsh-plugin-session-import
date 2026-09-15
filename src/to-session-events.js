/**
 * 结构化消息列表 → dsh SessionEvent[]（seed 格式，从 seq 0 连续、turn/step 闭合）。
 *
 * 事件序列模型（每轮合法结构）：
 *   turn/start → step/start → user/message → step/end
 *             → step/start → assistant/message(含 tool-call 块) → tool/call
 *             → tool/result* → step/end
 *             → turn/end
 *
 * 关键不变量（token meter / session invariant 重放均校验）：
 *   - step/start 与 step/end 严格配对：一个 step 关闭后才能开下一个；
 *     tool/result 必须落在【发起调用的同一个 step】内——绝不能在旧 step
 *     关闭后再为新结果开一个不闭合的新 step（否则 token meter 抛
 *     "step/start arrived before turn/step ended"）。
 *   - 因此 assistant 载体 + tool/call 输出后 step 保持打开，等结果到齐
 *     （或确认悬挂）才 closeStep；悬挂的 call 在强制收步时补一条 isError
 *     的合成 tool/result（与 dsh-session 崩溃修复 interruptedTurnClosers 同语义），
 *     保证 provider transcript 无 dangling assistant tool-call。
 *
 * 关键约束（OpenAI/DeepSeek chat-completions wire 规则）：
 *   - assistant 消息的 content 必须承载 tool-call 块（转成 API 的 tool_calls 字段）
 *   - 每条 role='tool' 消息必须紧邻其对应的 tool_calls 消息（中间不能插入其他 assistant）
 *   - 解析器可能把多个 tool-call 的 assistant 消息连续输出、结果后置
 *     （claude 格式：assistant[callA] assistant[callB] user[resultA] user[resultB]），
 *     必须按 callId 配对输出。
 */

let seq = 0
let turn = 0
let step = 0
let turnOpen = false
let stepOpen = false
let baseTime = 0
/** 当前已打开 step 内等待结果的 callId 集合 */
let outstanding = new Set()

function reset() {
  seq = 0; turn = 0; step = 0; turnOpen = false; stepOpen = false
  outstanding = new Set()
  baseTime = Date.now()
}

/** 追加一个事件，自动分配 seq/time */
function push(type, data, extra) {
  return { type, seq: seq++, time: baseTime + seq, data, ...(extra ?? {}) }
}

function openTurn() {
  turn += 1
  step = 0
  turnOpen = true
  return push('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
}

function closeTurn() {
  if (!turnOpen) return []
  turnOpen = false
  return [push('turn/end', { turn, reason: { kind: 'completed' } })]
}

function openStep() {
  step += 1
  stepOpen = true
  return push('step/start', { turn, step })
}

function closeStep() {
  if (!stepOpen) return []
  stepOpen = false
  return [push('step/end', { turn, step })]
}

/** 为悬挂的 tool/call 合成一条 isError 结果（同 dsh-session 崩溃修复语义），然后关闭 step。 */
function finalizeStep() {
  const out = []
  for (const callId of outstanding) {
    out.push(push('tool/result', {
      turn, step,
      message: {
        id: `import-tool-${seq}`,
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError: true,
          content: [{ type: 'text', text: 'The tool call was interrupted in the source transcript and no result was recorded. Retry it if it is still needed.' }],
        }],
        source: { kind: 'tool', callId },
      },
    }, { surfaceOp: 'append' }))
  }
  outstanding.clear()
  out.push(...closeStep())
  return out
}

/**
 * 转换器：把消息流重排为「assistant 载体紧跟其 tool 结果」的合法序列。
 * 实现：遍历消息，assistant 消息先缓存（不立即输出其 tool-call），
 * 遇到 tool-result 时把对应 assistant 载体 + tool/call + tool/result 在同一 step
 * 内一起输出；结果未到齐前 step 保持打开；强制移动边界（新用户文本/换轮/结尾）
 * 时为悬挂 call 补合成结果再收步。
 */
export function toSessionEvents(messages, sessionTitle) {
  reset()
  const events = []
  if (sessionTitle && typeof sessionTitle === 'string' && sessionTitle.trim()) {
    events.push(push('session/title', {
      title: sessionTitle.trim(),
      messageSeqs: [],
      source: { kind: 'user' },
    }))
  }
  /** pending assistant 载体：{ textBlocks, calls, model, usage } */
  let pending = null

  /**
   * 输出 pending 的 assistant 载体 + tool/call（不关 step——等结果）。
   * 若此前有未收尾的打开 step（上一批 call 结果没到齐），先合成结果收掉它。
   */
  const flushPending = () => {
    if (!pending) return
    if (stepOpen) events.push(...finalizeStep())
    if (!turnOpen) events.push(openTurn())
    events.push(openStep())
    const content = [...pending.textBlocks, ...pending.calls]
    if (content.length > 0) {
      events.push(push('assistant/message', {
        turn, step,
        stream: [],
        message: {
          id: `import-assistant-${seq}`,
          role: 'assistant',
          content,
          source: { kind: 'model', provider: 'imported', model: pending.model ?? 'imported' },
        },
        ...(pending.usage
          ? { usage: {
              inputTokens: Number(pending.usage.input_tokens ?? 0) || 0,
              outputTokens: Number(pending.usage.output_tokens ?? 0) || 0,
              ...(Number(pending.usage.cache_read_input_tokens ?? 0) ? { cacheReadTokens: Number(pending.usage.cache_read_input_tokens) } : {}),
              ...(Number(pending.usage.cache_creation_input_tokens ?? 0) ? { cacheWriteTokens: Number(pending.usage.cache_creation_input_tokens) } : {}),
              ...(Number(pending.usage.reasoning_tokens ?? 0) ? { reasoningTokens: Number(pending.usage.reasoning_tokens) } : {}),
            } }
          : {}),
      }, { surfaceOp: 'append' }))
    }
    for (const block of pending.calls) {
      events.push(push('tool/call', {
        turn, step,
        callId: block.id,
        name: block.name,
        arguments: block.arguments,
      }))
      outstanding.add(block.id)
    }
    // 全部 call 都在同一条消息里自带结果时由调用方继续 emitToolResult；
    // 纯文本载体（无 call）此处直接收步。
    if (pending.calls.length === 0) events.push(...closeStep())
    pending = null
  }

  /** 输出一个 tool/result（同 step）；当前 step 的 call 全部有结果后自动收步。 */
  const emitToolResult = (block) => {
    if (!turnOpen) events.push(openTurn())
    if (!stepOpen) events.push(openStep())
    events.push(push('tool/result', {
      turn, step,
      message: {
        id: `import-tool-${seq}`,
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: block.toolCallId, content: block.content, isError: block.isError === true }],
        source: { kind: 'tool', callId: block.toolCallId },
      },
    }, { surfaceOp: 'append' }))
    outstanding.delete(block.toolCallId)
    if (outstanding.size === 0 && stepOpen) events.push(...closeStep())
  }

  for (const message of messages) {
    const tools = message.content.filter((b) => b.type === 'tool-call' || b.type === 'tool-result')
    const textBlocks = message.content.filter((b) => b.type === 'text' || b.type === 'reasoning' || b.type === 'image')
    const calls = tools.filter((b) => b.type === 'tool-call')
    const results = tools.filter((b) => b.type === 'tool-result')

    if (message.role === 'assistant') {
      // 连续 assistant 消息合并到同一 pending（同一轮的工具调用序列，
      // 结果可能后置在后续 user 消息里——如 claude 的 tool_use 逐条输出）
      if (!pending) {
        pending = { textBlocks: [], calls: [], model: undefined, usage: undefined }
      }
      pending.textBlocks.push(...textBlocks)
      for (const c of calls) pending.calls.push(c)
      if (!pending.model && message.model) pending.model = message.model
      if (!pending.usage && message.usage) pending.usage = message.usage
      // 若该 assistant 消息自带 tool-result（如 zcode 的 call+result 成对），立即配对输出
      if (results.length > 0 && pending.calls.length > 0) {
        flushPending()
        for (const r of results) emitToolResult(r)
      }
      continue
    }

    if (message.role === 'user') {
      if (results.length > 0) {
        // 工具结果：匹配 pending 未输出的 call 或当前 step 已输出的 call；
        // 真孤儿（从未出现且不在等待中的 call）丢弃
        const pendingCallIds = new Set((pending?.calls ?? []).map((c) => c.id))
        const matched = []
        const orphans = []
        for (const r of results) {
          if (pendingCallIds.has(r.toolCallId) || outstanding.has(r.toolCallId)) matched.push(r)
          else orphans.push(r)
        }
        if (orphans.length > 0) {
          console.log(`[session-import] 丢弃 ${orphans.length} 个孤儿工具结果（无对应调用）`)
        }
        if (matched.length > 0) {
          if (pending && pending.calls.length > 0) flushPending()
          for (const r of matched) emitToolResult(r)
        }
        // 若该 user 消息还带文本（纯文本 + tool-result 混合），追加 user/message
        const realText = textBlocks.filter((b) => b.type === 'text' && b.text.trim())
        if (realText.length > 0) {
          if (!turnOpen) events.push(openTurn())
          if (!stepOpen) events.push(openStep())
          events.push(push('user/message', {
            id: `import-user-${seq}`,
            role: 'user',
            content: textBlocks,
            source: { kind: 'user' },
          }, { surfaceOp: 'append' }))
          events.push(...closeStep())
        }
        continue
      }
      // 纯用户文本消息：新开一轮（先收掉未闭合的 assistant 载体 step）
      if (pending && pending.calls.length > 0) flushPending()
      if (stepOpen) events.push(...finalizeStep()) // 悬挂 call 补合成结果
      outstanding.clear() // 跨 turn，旧 call 不再可匹配
      const text = textBlocks.map((b) => b.text ?? '').join('')
      if (text.includes('<system-reminder>') && !text.replace(/<[^>]+>/g, '').trim()) continue // 过滤纯系统注入
      events.push(...closeTurn(), openTurn(), openStep())
      events.push(push('user/message', {
        id: `import-user-${seq}`,
        role: 'user',
        content: textBlocks,
        source: { kind: 'user' },
      }, { surfaceOp: 'append' }))
      events.push(...closeStep())
    }
  }
  // 结尾：flush 未闭合的 assistant 载体并收尾所有边界（dangling tool-call 兜底，保证 seed 完整）
  flushPending()
  if (stepOpen) events.push(...finalizeStep())
  events.push(...closeTurn())
  return events
}
