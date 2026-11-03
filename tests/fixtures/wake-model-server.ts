import { createServer } from 'node:http'

/** Deterministic protocol fixture, NOT a real model and NOT evidence of authenticated E2E. */
export async function startWakeModelFixture() {
  let requests = 0
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { res.writeHead(404); res.end(); return }
    let bytes = 0
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk as Buffer)
      if (bytes > 2 * 1024 * 1024) { res.writeHead(413); res.end(); return }
    }
    const sequence = ++requests
    let seq = 0
    const text = 'FIXTURE-ONLY: protocol response, no real model inference.'
    const item = { type: 'message', role: 'assistant', id: `msg_fixture_${sequence}`, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    const response = { id: `resp_fixture_${sequence}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const emit = (type: string, fields: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...fields })}\n\n`)
    emit('response.created', { response: { ...response, status: 'in_progress', output: [] } })
    emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text, logprobs: [] })
    await new Promise(resolve => setTimeout(resolve, 150))
    emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text, logprobs: [] })
    emit('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] })
    emit('response.output_item.done', { output_index: 0, item })
    emit('response.completed', { response })
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture listen failed')
  return { url: `http://127.0.0.1:${address.port}/v1`, count: () => requests,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
