import test from 'node:test'
import assert from 'node:assert/strict'
import { toSessionEvents } from './src/to-session-events.js'

const user = { role: 'user', content: [{ type: 'text', text: 'hello' }] }
const assistant = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }

test('reserves a system head before imported messages', () => {
  for (const messages of [[user, assistant], [assistant], []]) {
    const events = toSessionEvents(messages, 'Imported session')
    const surface = events.filter(event => event.surfaceOp === 'append')
    assert.equal(surface[0]?.type, 'system/message')
    assert.deepEqual(surface[0].data.message, {
      id: surface[0].data.message.id,
      role: 'system', content: [], source: { kind: 'system-prompt' },
    })
    assert.ok(surface[0].data.message.id)
    const before = events[events.indexOf(surface[0]) - 1]
    assert.equal(before.type, 'step/start')
    assert.equal(surface[0].data.turn, before.data.turn)
    assert.equal(surface[0].data.step, before.data.step)
    assert.deepEqual(events.map(event => event.seq), events.map((_, i) => i))
    assert.equal(events.at(-1).type, 'turn/end')
    assert.equal(surface.filter(event => event.type === 'system/message').length, 1)
  }
})
