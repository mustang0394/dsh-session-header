/**
 * Tests for the tools/execute injection phase (issue #1) plus regression
 * coverage for the existing llm/stream behavior.
 *
 * Run with: node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config } from '../index.js'

/** Record every fetch the plugin (and the code under test) performs. */
function installFetchRecorder() {
  const calls = []
  const original = globalThis.fetch
  const fn = async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers !== undefined) {
      for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
    }
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
    calls.push({ url, headers })
    return new Response('ok', { status: 200 })
  }
  globalThis.fetch = fn
  return {
    fn,
    original,
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

/**
 * Cordis-like context stub: captures on() handlers, runs effect() setup.
 *
 * `llm` a provider directory as `listConfigurableProviders()` would return it,
 * `settings` a live Settings document as `describe()` would return it. Leave
 * either out to model a host where endpoint resolution is impossible.
 */
function makeContext({ llm, settings } = {}) {
  const handlers = new Map()
  const disposers = []
  const warnings = []
  const ctx = {
    logger: {
      warn(message) {
        warnings.push(String(message))
      },
    },
    on(event, handler) {
      handlers.set(event, handler)
    },
    effect(fn) {
      disposers.push(fn())
    },
    get(name) {
      return name === 'settings' && settings !== undefined ? { describe: () => settings } : undefined
    },
    ...(llm === undefined ? {} : { llm }),
  }
  return { ctx, handlers, disposers, warnings }
}

/**
 * Install recorder, apply plugin, and wire automatic cleanup.
 *
 * `host` carries the optional `llm` / `settings` seams, kept separate from the
 * plugin config so tests read as "configure the plugin, arrange the host".
 */
function boot(t, config = {}, host = {}) {
  const recorder = installFetchRecorder()
  const { ctx, handlers, disposers, warnings } = makeContext(host)
  // Go through the Schema, the way the harness loads the plugin: defaults for
  // toolEndpoints/overwriteHeaders/header come from Config, not from apply().
  apply(ctx, Config(config))
  t.after(() => {
    for (const dispose of disposers) dispose?.()
    recorder.restore()
  })
  return { ctx, handlers, recorder, warnings }
}

test('tools/execute: injects header when URL matches a configured endpoint prefix', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  const headers = recorder.calls[0].headers
  assert.equal(headers.get('x-opencode-session'), 'uuid-123')
  assert.equal(headers.get('content-type'), 'application/json')
})

test('tools/execute: leaves third-party tool URLs untouched', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://web.example.org/page', { headers: { a: 'b' } })
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 2)
  assert.equal(recorder.calls[0].url, 'https://web.example.org/page')
  assert.equal(recorder.calls[0].headers.has('x-opencode-session'), false)
  assert.equal(recorder.calls[1].url, 'https://gateway.example.com/messages')
  assert.equal(recorder.calls[1].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: default (no toolEndpoints) keeps upstream behavior — no injection', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-opencode-session' })
  const exec = { agent: { id: 'session-uuid-123' } }
  let ran = false
  const next = async () => {
    ran = true
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(ran, true)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.has('x-opencode-session'), false)
})

test('tools/execute: no agent session id means no injection even when matched', async (t) => {
  const { handlers, recorder } = boot(t, { toolEndpoints: ['https://gateway.example.com/'] })
  const exec = { agent: {} }
  const next = async () => {
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.has('x-session-id'), false)
})

test('tools/execute: fixed config.value wins over the agent session id', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    value: 'fixed-value',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'fixed-value')
})

test('tools/execute: URL object input is matched by prefix', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch(new URL('https://gateway.example.com/v1/messages'))
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'uuid-123')
})

// --- overwriteHeaders: replace placeholder values hard-coded by official plugins ---

test('tools/execute: overwriteHeaders replaces an existing placeholder header value', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['x-opencode-session'],
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    // Simulates dsh-web-search-deepseek's hard-coded placeholder header.
    await fetch('https://gateway.example.com/messages', {
      headers: { 'x-opencode-session': 'dsh-web-search' },
    })
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: header NOT listed in overwriteHeaders stays untouched', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['another-header'],
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages', {
      headers: { 'x-opencode-session': 'dsh-web-search' },
    })
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'dsh-web-search')
})

test('llm/stream: overwriteHeaders also applies in the LLM scope', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['x-opencode-session'],
  })
  async function* inner() {
    await fetch('https://llm.example.com/v1/messages', {
      headers: { 'x-opencode-session': 'placeholder' },
    })
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'abc')
})

// --- llm/stream regression (existing behavior must not change) ---

test('llm/stream: still injects unconditionally with the live session id', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
    yield 'chunk-2'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  const chunks = []
  for await (const chunk of gen) chunks.push(chunk)
  assert.deepEqual(chunks, ['chunk-1', 'chunk-2'])
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
})

test('llm/stream: never overwrites a header someone else already set', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat', { headers: { 'x-session-id': 'already-set' } })
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'already-set')
})

test('unloading restores the fetch that was installed before apply', async (t) => {
  const recorder = installFetchRecorder()
  const { ctx, disposers } = makeContext()
  apply(ctx, Config({}))
  const patched = globalThis.fetch
  assert.notEqual(patched, recorder.fn)
  for (const dispose of disposers) dispose?.()
  assert.equal(globalThis.fetch, recorder.fn)
  recorder.restore()
})

// --- review follow-ups: Request spelling, case-insensitive overwrite, boundary ---

test('tools/execute: Request input matching the whitelist is injected', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['x-opencode-session'],
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    const request = new Request('https://gateway.example.com/messages', {
      method: 'POST',
      headers: { 'x-opencode-session': 'dsh-web-search' },
    })
    await fetch(request)
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: Request input NOT matching the whitelist passes through untouched', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    const request = new Request('https://other.example.org/messages', {
      method: 'POST',
      headers: { 'x-opencode-session': 'dsh-web-search' },
    })
    await fetch(request)
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].url, 'https://other.example.org/messages')
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'dsh-web-search')
})

test('tools/execute: sibling domain never matches (host boundary)', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com'], // no trailing slash on purpose
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com.evil.io/messages')
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 2)
  assert.equal(recorder.calls[0].url, 'https://gateway.example.com.evil.io/messages')
  assert.equal(recorder.calls[0].headers.has('x-opencode-session'), false)
  assert.equal(recorder.calls[1].url, 'https://gateway.example.com/messages')
  assert.equal(recorder.calls[1].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: path prefix respects boundaries (/v1 not /v10)', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/zen/go/v1'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/zen/go/v10/messages')
    await fetch('https://gateway.example.com/zen/go/v1/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 2)
  assert.equal(recorder.calls[0].headers.has('x-opencode-session'), false)
  assert.equal(recorder.calls[1].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: case-insensitive overwrite of a placeholder header', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['X-OPENCODE-SESSION'], // deliberately different case
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages', {
      headers: { 'X-OPENCODE-SESSION': 'dsh-web-search' }, // different case on wire
    })
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'uuid-123')
})

// --- fetch slot re-claiming -------------------------------------------------
//
// `globalThis.fetch` is one process-wide mutable slot. Any component that takes
// it after this plugin loads pushes the injection out of the call chain, and
// every later request silently goes out without the header until the plugin is
// unloaded and re-applied. That is the "disable and re-enable the plugin" work-
// around reported on Windows, where a fetch-owning plugin happens to load
// later. These tests pin the fix: the slot is re-claimed on demand.

/** Take the fetch slot the way a later plugin would, recording what reaches it. */
function takeFetchSlot({ forwards }) {
  const previous = globalThis.fetch
  const seen = []
  const replacement = async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers !== undefined) {
      for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
    }
    seen.push({ url: String(input), headers })
    return forwards ? previous(input, init) : new Response('ok', { status: 200 })
  }
  globalThis.fetch = replacement
  return { seen, replacement }
}

async function drain(iterable) {
  for await (const _ of iterable) {
    /* consume every chunk so the adapter's fetch has run */
  }
}

test('fetch replaced after load: llm/stream re-claims the slot and still injects', async (t) => {
  const { handlers } = boot(t, { header: 'x-session-id' })
  // A later plugin overwrites the slot without delegating: our patch is now
  // out of the chain, which is exactly the reported failure.
  const { seen } = takeFetchSlot({ forwards: false })

  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  await drain(handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner()))

  assert.equal(seen.length, 1)
  assert.equal(seen[0].headers.get('x-session-id'), 'abc')
})

test('fetch replaced after load: a delegating wrapper is re-wrapped, not replaced', async (t) => {
  const { handlers } = boot(t, { header: 'x-session-id' })
  const { seen } = takeFetchSlot({ forwards: true })
  const replacement = globalThis.fetch

  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  await drain(handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner()))

  assert.equal(seen.length, 1)
  assert.equal(seen[0].headers.get('x-session-id'), 'abc')
  // The other plugin's implementation must stay underneath ours.
  const wrapped = globalThis.fetch
  assert.notEqual(wrapped, replacement)
  assert.ok(typeof wrapped === 'function')
})

test('fetch replaced after load: tools/execute re-claims the slot too', async (t) => {
  const { handlers } = boot(t, {
    header: 'x-session-id',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const { seen } = takeFetchSlot({ forwards: false })

  await handlers.get('tools/execute')({ agent: { id: 'session-uuid-123' } }, async () => {
    await fetch('https://gateway.example.com/messages')
  })

  assert.equal(seen.length, 1)
  assert.equal(seen[0].headers.get('x-session-id'), 'uuid-123')
})

test('a replacement that forwards through globalThis.fetch does not recurse forever', async (t) => {
  const { handlers } = boot(t, { header: 'x-session-id' })
  // Worst case: the replacement reads the slot again instead of the transport
  // it captured, so re-wrapping it would bounce between the two functions.
  let hops = 0
  globalThis.fetch = async (input, init) => {
    if (++hops > 50) throw new Error('fetch dispatch recursed')
    return globalThis.fetch(input, init)
  }

  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  // Must settle rather than overflow the stack; the guard falls back to the
  // transport underneath, which is what actually reaches the network.
  await drain(handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner()))
  assert.ok(hops >= 1)
})

test('a replacement that awaits before forwarding does not recurse forever', { timeout: 5000 }, async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  // The natural shape of an async network helper: capture the current fetch,
  // await something (proxy lookup, telemetry, a lock), then delegate. A
  // synchronous re-entrancy flag is already reset by then, so this re-entry
  // used to allocate until the host process ran out of heap. The failure mode
  // was a hang rather than an assertion failure, hence the timeout.
  const previous = globalThis.fetch
  let forwards = 0
  globalThis.fetch = async (input, init) => {
    forwards += 1
    await Promise.resolve()
    return previous(input, init)
  }

  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  await drain(handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner()))

  // The wrapper ran exactly once, and so did the request it forwards.
  assert.equal(forwards, 1)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
})

test('a wrapper that rebuilds the request before retrying keeps the header', async (t) => {
  // Downstream wrappers retry by rebuilding the Request instead of reusing the
  // args they were handed. The retry belongs to the same model call, so it must
  // still carry the header — gateways key on it.
  const calls = []
  let real = 0
  const realFetch = async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers !== undefined) {
      for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
    }
    calls.push({ headers })
    real += 1
    return new Response('ok', { status: real === 1 ? 429 : 200 })
  }
  const baseline = globalThis.fetch
  const { ctx, handlers, disposers } = makeContext()
  globalThis.fetch = realFetch
  apply(ctx, Config({ header: 'x-session-id' }))
  t.after(() => {
    for (const dispose of disposers) dispose?.()
    globalThis.fetch = baseline
  })

  const previous = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const first = await previous(input, init)
    if (first.status !== 429) return first
    await Promise.resolve()
    return previous(new Request('https://llm.example.com/v1/chat', { method: 'POST', body: '{}' }))
  }

  async function* inner() {
    const response = await fetch('https://llm.example.com/v1/chat', { method: 'POST', body: '{}' })
    yield response.status
  }
  const statuses = []
  for await (const status of handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())) {
    statuses.push(status)
  }

  assert.deepEqual(statuses, [200])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].headers.get('x-session-id'), 'abc')
  assert.equal(calls[1].headers.get('x-session-id'), 'abc', 'the rebuilt retry keeps the header')
})

test('tools/execute: an awaiting wrapper does not recurse and the whitelist still applies', { timeout: 5000 }, async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-session-id',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const previous = globalThis.fetch
  let forwards = 0
  globalThis.fetch = async (input, init) => {
    forwards += 1
    await Promise.resolve()
    return previous(input, init)
  }

  await handlers.get('tools/execute')({ agent: { id: 'session-uuid-123' } }, async () => {
    await fetch('https://gateway.example.com/messages')
    await fetch('https://web.example.org/page')
  })

  assert.equal(forwards, 2)
  assert.equal(recorder.calls.length, 2)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'uuid-123')
  assert.equal(recorder.calls[1].headers.has('x-session-id'), false)
})

test('a transport chain that never reaches fetch fails closed instead of exhausting the heap', { timeout: 5000 }, async (t) => {
  // The slot already forwards through itself when the plugin loads, so the
  // transport captured at apply time is not a network call either. A capped
  // chain with a diagnostic error beats a multi-gigabyte heap exhaustion.
  const baseline = globalThis.fetch
  globalThis.fetch = (input, init) => globalThis.fetch(input, init)
  const { ctx, handlers, disposers } = makeContext()
  apply(ctx, Config({ header: 'x-session-id' }))
  t.after(() => {
    for (const dispose of disposers) dispose?.()
    globalThis.fetch = baseline
  })

  async function* inner() {
    await fetch('https://llm.example.com/v1/chat')
    yield 'chunk-1'
  }
  await assert.rejects(
    drain(handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())),
    /did not reach a transport/,
  )
})

test('unloading after a re-wrap hands the slot back to the replacement', async (t) => {
  const recorder = installFetchRecorder()
  const { ctx, handlers, disposers } = makeContext()
  apply(ctx, Config({}))
  t.after(() => recorder.restore())

  // Someone replaces fetch, then a stream step re-wraps it.
  const replacement = async () => new Response('ok', { status: 200 })
  globalThis.fetch = replacement

  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  await drain(handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner()))
  assert.notEqual(globalThis.fetch, replacement, 'stream step claims the slot')

  // Unloading must not clobber the other plugin's transport.
  for (const dispose of disposers) dispose?.()
  assert.equal(globalThis.fetch, replacement)
})

test('a non-callable fetch in the slot does not poison later requests', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  // Something cleared or clobbered the slot with a non-function. Re-wrapping
  // that would turn every request into a TypeError, so the plugin must keep
  // the last usable transport instead.
  globalThis.fetch = undefined

  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  await drain(handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner()))

  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
})

// --- LLM-phase endpoint gate ------------------------------------------------
//
// The `llm/stream` scope used to trust every fetch that ran inside it, which
// let unrelated traffic in the same promise chain (telemetry, another plugin's
// network work) carry the session id. The scope is now narrowed to the baseURL
// of the route being called. A route whose endpoint cannot be established keeps
// the historical unrestricted behaviour, so an unknown adapter never silently
// loses the header.

/** A provider directory entry as `listConfigurableProviders()` returns it. */
function providerDirectory(entries) {
  return { listConfigurableProviders: () => entries }
}

/** A Settings document carrying configured providers, as `describe()` returns it. */
function settingsDocument(ns, providers) {
  return [{ ns, value: { providers } }]
}

test('llm/stream: a declared provider is narrowed to its configured baseURL', async (t) => {
  const { handlers, recorder } = boot(
    t,
    { header: 'x-session-id' },
    {
      llm: providerDirectory([
        { provider: 'new-api', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'new-api'] },
      ]),
      settings: settingsDocument('llm-pi-ai', {
        'new-api': { baseURL: 'https://gw.example.com/v1' },
      }),
    },
  )

  async function* inner() {
    await fetch('https://gw.example.com/v1/chat/completions')
    // Unrelated traffic inside the same stream must stay untouched.
    await fetch('https://telemetry.example.org/report')
    yield 'chunk-1'
  }
  for await (const _ of handlers.get('llm/stream')({ provider: 'new-api', sessionId: 'session-abc' }, () => inner())) {
    /* drain */
  }

  assert.equal(recorder.calls.length, 2)
  assert.equal(recorder.calls[0].url, 'https://gw.example.com/v1/chat/completions')
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
  assert.equal(recorder.calls[1].url, 'https://telemetry.example.org/report')
  assert.equal(recorder.calls[1].headers.has('x-session-id'), false)
})

test('llm/stream: a catalog provider is narrowed by defaultBaseURL', async (t) => {
  const { handlers, recorder } = boot(
    t,
    { header: 'x-session-id' },
    {
      llm: providerDirectory([{ provider: 'deepseek', defaultBaseURL: 'https://api.deepseek.com' }]),
    },
  )

  async function* inner() {
    await fetch('https://api.deepseek.com/anthropic/v1/messages')
    await fetch('https://telemetry.example.org/report')
    yield 'chunk-1'
  }
  for await (const _ of handlers.get('llm/stream')({ provider: 'deepseek', sessionId: 'session-abc' }, () => inner())) {
    /* drain */
  }

  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
  assert.equal(recorder.calls[1].headers.has('x-session-id'), false)
})

test('llm/stream: an unresolvable route keeps the unrestricted behaviour', async (t) => {
  // No provider directory at all: the endpoint is unknown, so the plugin must
  // not start dropping headers it used to send.
  const { handlers, recorder, warnings } = boot(t, { header: 'x-session-id' })

  async function* inner() {
    await fetch('https://api.deepseek.com/anthropic/v1/messages')
    yield 'chunk-1'
  }
  for await (const _ of handlers.get('llm/stream')({ provider: 'deepseek', sessionId: 'session-abc' }, () => inner())) {
    /* drain */
  }

  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
  assert.ok(warnings.some((line) => line.includes('could not resolve a baseURL')))
})

test('llm/stream: a provider missing from the directory is warned once, not per call', async (t) => {
  const { handlers, warnings } = boot(
    t,
    { header: 'x-session-id' },
    { llm: providerDirectory([]) },
  )

  async function* inner() {
    await fetch('https://gw.example.com/v1/chat/completions')
    yield 'chunk-1'
  }
  for (let call = 0; call < 3; call += 1) {
    for await (const _ of handlers.get('llm/stream')({ provider: 'unknown', sessionId: 'session-abc' }, () => inner())) {
      /* drain */
    }
  }

  assert.equal(warnings.filter((line) => line.includes('could not resolve a baseURL')).length, 1)
})

test('llm/stream: tool-phase whitelist is independent of the LLM endpoint gate', async (t) => {
  const { handlers, recorder } = boot(
    t,
    { header: 'x-session-id', toolEndpoints: ['https://gateway.example.com/'] },
    {
      llm: providerDirectory([
        { provider: 'new-api', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'new-api'] },
      ]),
      settings: settingsDocument('llm-pi-ai', { 'new-api': { baseURL: 'https://gw.example.com/v1' } }),
    },
  )

  // The LLM route baseURL must not widen the tool whitelist.
  await handlers.get('tools/execute')({ agent: { id: 'session-uuid-123' } }, async () => {
    await fetch('https://gw.example.com/v1/messages')
    await fetch('https://gateway.example.com/messages')
  })

  assert.equal(recorder.calls[0].headers.has('x-session-id'), false)
  assert.equal(recorder.calls[1].headers.get('x-session-id'), 'uuid-123')
})
