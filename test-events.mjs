/**
 * toSessionEvents 单元测试：验证 seed 事件序列合法（工具配对/孤儿丢弃/回合闭合）
 */
import { toSessionEvents } from './src/to-session-events.js'

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}

// 辅助：造消息
const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistantText = (text, model = 'test') => ({ role: 'assistant', content: [{ type: 'text', text }], model })
const assistantCall = (id, name = 'read', args = '{}', model = 'test') => ({
  role: 'assistant', content: [{ type: 'tool-call', id, name, arguments: args }], model,
})
const userToolResult = (callId, content = 'ok') => ({
  role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content }],
})
const userMixed = (callId, content, text) => ({
  role: 'user', content: [
    { type: 'tool-result', toolCallId: callId, content },
    { type: 'text', text },
  ],
})

// 1. 纯文本一轮
{
  const ev = toSessionEvents([userMsg('你好'), assistantText('你好！')])
  const types = ev.map(e => e.type)
  check('纯文本：事件数合理', ev.length >= 6, `len=${ev.length}`)
  check('纯文本：turn/start 开头', types[0] === 'turn/start')
  check('纯文本：含 user/message', types.includes('user/message'))
  check('纯文本：含 assistant/message', types.includes('assistant/message'))
  check('纯文本：turn/end 结尾', types[types.length - 1] === 'turn/end')
  check('纯文本：seq 连续', ev.every((e, i) => e.seq === i))
}

// 2. 工具调用配对：assistant(callA) + user(resultA)
{
  const ev = toSessionEvents([userMsg('读文件'), assistantCall('call-1', 'read', '{"file":"a.txt"}'), userToolResult('call-1')])
  const types = ev.map(e => e.type)
  check('工具：有 assistant/message', types.includes('assistant/message'))
  check('工具：有 tool/call', types.includes('tool/call'))
  check('工具：有 tool/result', types.includes('tool/result'))
  const asst = ev.find(e => e.type === 'assistant/message')
  const call = ev.find(e => e.type === 'tool/call')
  const result = ev.find(e => e.type === 'tool/result')
  check('工具：assistant 携带 tool-call 块', asst?.data?.message?.content?.some(b => b.type === 'tool-call'))
  check('工具：tool/call 的 callId 正确', call?.data?.callId === 'call-1')
  check('工具：tool/result 配对 callId', result?.data?.message?.source?.callId === 'call-1')
  const msgTypes = types.filter(t => !t.startsWith('step/') && !t.startsWith('turn/'))
  check('工具：result 前一个消息类事件是 tool/call', msgTypes[msgTypes.indexOf('tool/result') - 1] === 'tool/call')
}

// 3. 连续 assistant 调用 + 后置结果（claude 风格）：assistant(callA) assistant(callB) user(resultA) user(resultB)
{
  const ev = toSessionEvents([
    userMsg('并行读两个文件'),
    assistantCall('a', 'read', '{"file":"a"}'),
    assistantCall('b', 'read', '{"file":"b"}'),
    userToolResult('a', 'A内容'),
    userToolResult('b', 'B内容'),
  ])
  const types = ev.map(e => e.type)
  const calls = ev.filter(e => e.type === 'tool/call').map(e => e.data.callId)
  const results = ev.filter(e => e.type === 'tool/result').map(e => e.data.message.source.callId)
  check('多调用：两个 tool/call', calls.length === 2 && calls.includes('a') && calls.includes('b'))
  check('多调用：两个 tool/result', results.length === 2 && results.includes('a') && results.includes('b'))
  // 配对顺序：a 的 assistant+call+result 先于 b 的
  const aCall = types.indexOf('tool/call')
  const aResult = types.indexOf('tool/result')
  const msgTypes2 = types.filter(t => !t.startsWith('step/') && !t.startsWith('turn/'))
  const firstResultIdx = msgTypes2.indexOf('tool/result')
  check('多调用：result 前一个消息类事件是 tool/call', msgTypes2[firstResultIdx - 1] === 'tool/call')
  check('多调用：两个 result 连续输出', msgTypes2[firstResultIdx + 1] === 'tool/result')
}

// 4. 孤儿 tool result 丢弃
{
  const ev = toSessionEvents([userMsg('正常对话'), userToolResult('ghost-call', '没有对应的调用')])
  const results = ev.filter(e => e.type === 'tool/result')
  check('孤儿：tool/result 被丢弃', results.length === 0)
}

// 5. 混合消息：user(tool-result + text) —— 工具结果 + 文本同一条 user
{
  const ev = toSessionEvents([userMsg('执行'), assistantCall('c1'), userMixed('c1', '结果', '顺带说一句')])
  const types = ev.map(e => e.type)
  check('混合：有 tool/result', types.includes('tool/result'))
  check('混合：有 user/message（文本部分）', types.includes('user/message'))
}

// 6. 系统提醒过滤（纯 <system-reminder> 不产生 user/message）
{
  const ev = toSessionEvents([userMsg('<system-reminder></system-reminder>'), userMsg('真实问题')])
  const users = ev.filter(e => e.type === 'user/message')
  check('系统提醒：纯 reminder 被过滤', users.length === 1, `users=${users.length}`)
}

// 7. 重放不变量（token meter 同款校验）：任意消息流产出的序列必须 turn/step 严格闭合
{
  const streams = [
    // claude 风格：连续 assistant + 后置结果
    [userMsg('并行读'), assistantCall('a'), assistantCall('b'), userToolResult('a', 'A'), userToolResult('b', 'B')],
    // 结果缺失（悬挂 call）：必须补合成结果收步
    [userMsg('读文件'), assistantCall('x'), userMsg('下一个问题'), assistantText('好的')],
    // zcode 风格：assistant 自带结果
    [{ role: 'assistant', content: [{ type: 'tool-call', id: 'z1', name: 'read', arguments: '{}' }, { type: 'tool-result', toolCallId: 'z1', content: 'ok' }], model: 't' }],
    // 混合：结果+文本同条 user，随后再来一轮工具调用
    [userMsg('执行'), assistantCall('m1'), userMixed('m1', '结果', '顺带说一句'), assistantCall('m2'), userToolResult('m2')],
  ]
  let allBalanced = true
  for (const stream of streams) {
    const ev = toSessionEvents(stream)
    let open = null
    for (const e of ev) {
      if (e.type === 'step/start') {
        if (open) { allBalanced = false; console.log('  违规:', JSON.stringify(e)) }
        open = e.data
      } else if (e.type === 'step/end' || e.type === 'turn/end') {
        open = null
      }
    }
    if (open) { allBalanced = false; console.log('  尾部未闭合:', JSON.stringify(open)) }
    // 每个 tool/call 都必须有同 step 的 tool/result
    const callSteps = new Map(ev.filter(e => e.type === 'tool/call').map(e => [e.data.callId, e.data.step]))
    for (const r of ev.filter(e => e.type === 'tool/result')) {
      if (callSteps.get(r.data.message.source.callId) !== r.data.step) {
        allBalanced = false
        console.log('  result 与 call 不同 step:', r.data.message.source.callId)
      }
    }
  }
  check('重放不变量：turn/step 闭合且 call/result 同 step', allBalanced)
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
