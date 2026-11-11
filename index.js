/**
 * Inject one HTTP header (default `x-session-id`) onto every LLM provider
 * request the harness sends, carrying the harness session id of that exact
 * call — so turns, compaction/title helper calls, and in-process subagent
 * children each report their own session.
 *
 * The harness has no per-request header seam: `GenerateOptions` carries no
 * headers field, and each adapter builds its own wire headers inside
 * `stream()`. The two official interception points compose into one here:
 *
 * - the `llm/stream` waterfall names the calls that are LLM calls and carries
 *   `options.sessionId`, and
 * - a `globalThis.fetch` patch adds the header, so every fetch-based adapter
 *   (llm-deepseek, llm-pi-ai, and any SDK whose transport bottoms out in
 *   global fetch) is covered without touching adapter code.
 *
 * Context propagation uses AsyncLocalStorage: each `iterator.next()` resumes
 * the adapter's stream inside `als.run()`, so the adapter's internal `fetch`
 * lands in the store, while unrelated fetches (web RPC, telemetry, tools)
 * see no store and pass through untouched.
 *
 * A fixed value can be configured instead of the live session id (sent
 * verbatim); the live id's `session-` branding prefix is stripped so a plain
 * UUID goes on the wire. Calls with neither a configured value nor a session
 * id get no header. A header anyone else already set is never overwritten
 * (`Headers` matching is case-insensitive, the same rule the wire uses).
 * Unloading the plugin restores the original fetch.
 *
 * @module dsh-session-header
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-session-header'

// Hard dependency: nothing to do until the llm runtime exists.
export const inject = ['llm']

export const Config = Schema.object({
  /** Header name to inject; HTTP field names are case-insensitive on the wire. */
  header: Schema.string().default('x-session-id'),
  /**
   * Fixed header value. Unset means "use the harness session id of the call
   * in flight" (`GenerateOptions.sessionId`); calls with neither get no header.
   */
  value: Schema.string(),
  /**
   * URL prefixes matched during tool execution. When non-empty, fetches that
   * happen inside a `tools/execute` waterfall (tool calls such as a web-search
   * Messages API against your model gateway) get the header ONLY when their
   * URL starts with one of these prefixes. Third-party tool targets (web_fetch
   * of arbitrary pages, GitHub, MCP servers, ...) stay untouched. Empty (the
   * default) keeps the upstream single-scope behavior: only LLM provider
   * requests are injected.
   */
  toolEndpoints: Schema.array(Schema.string()).default([]),
  /**
   * Header names this plugin is allowed to OVERWRITE when they already carry a
   * value. Only entries naming the configured `header` have an effect: this
   * plugin injects exactly one header, so listing other names does nothing.
   * Some official providers hard-code placeholder values (e.g.
   * dsh-web-search-deepseek sends `x-opencode-session: dsh-web-search`), which
   * a gateway rejects as missing; listing the header here lets the live session
   * id replace that placeholder. Case-insensitive match, default empty = never
   * overwrite.
   */
  overwriteHeaders: Schema.array(Schema.string()).default([]),
})

/**
 * Plugin entry. `config.header` names the header, `config.value` optionally
 * fixes its value; per call, the AsyncLocalStorage store carries the resolved
 * value (plus the tool-phase gate), and a present store marks "this is an LLM
 * fetch".
 */
export function apply(ctx, config) {
  const als = new AsyncLocalStorage()
  const originalFetch = globalThis.fetch
  // The transport this patch sits on top of. It is NOT pinned to the fetch we
  // saw at apply time: another plugin (or the runtime itself, on some
  // platforms) may replace `globalThis.fetch` after we load, which would drop
  // our patch out of the call chain entirely. `install()` below notices that
  // and re-wraps whatever is installed now, so the header keeps being injected
  // for the rest of the process lifetime without a plugin unload/reload.
  let innerFetch = originalFetch
  // Set by the disposer; a stream that is still in flight must not re-install the
  // patch after the plugin was unloaded.
  let disposed = false
  // Marks a call that is already on its way downstream. A synchronous boolean
  // cannot do this job: it is reset before a delegating wrapper ever comes
  // back, so a wrapper that awaits and then falls back to `globalThis.fetch`
  // would bounce between the two forever (and exhaust the host heap). The mark
  // instead rides in an AsyncLocalStorage child scope, which is inherited
  // across `await` and timers, so the re-entry is recognised however late it
  // arrives — and it is per call, so concurrent requests never see each
  // other's mark.
  const DISPATCH_DEPTH = Symbol('dsh-session-header.dispatch-depth')
  // A healthy chain is two hops: patch -> transport. Anything beyond this is a
  // component that keeps forwarding back to the global slot.
  const MAX_DISPATCH_DEPTH = 8
  // Shared immutable store for the pass-through case: a fetch outside any LLM
  // call still needs the downstream mark, but carries nothing else.
  const UNSCOPED_DISPATCH = Object.freeze({ [DISPATCH_DEPTH]: 1 })
  // Empty store used to shadow an enclosing scope: it carries no value, so the
  // fetch patch stays a pure pass-through even when an outer `tools/execute`
  // or stream scope is still active.
  const EMPTY_SCOPE = Object.freeze({})

  // The Schema above already filled the defaults (the harness validates plugin
  // config through it), so these are read once here rather than re-defaulted on
  // every injection.
  const { header, value: fixedValue, toolEndpoints, overwriteHeaders } = config

  // An unusable field name/value would make `Headers.has/set` throw on every
  // request inside a scope — one typo in the config would take down every model
  // call. Validate once at load (using the exact calls the injection path
  // makes) and disable this instance instead of failing per request.
  const configProblem = (() => {
    if (typeof header !== 'string' || header.length === 0) {
      return 'header must be a non-empty HTTP header name'
    }
    try {
      const probe = new Headers()
      probe.has(header)
      probe.set(header, 'x')
    } catch {
      return `header ${JSON.stringify(header)} is not a valid HTTP header name`
    }
    if (fixedValue !== undefined) {
      try {
        new Headers().set('x-session-header-check', fixedValue)
      } catch {
        return 'value is not a valid HTTP header value'
      }
    }
    return undefined
  })()
  if (configProblem !== undefined) {
    ctx.logger.warn(`dsh-session-header: ${configProblem}; header injection is disabled for this instance`)
    return
  }

  // Only one question is ever asked of `overwriteHeaders`: may we replace OUR
  // header? Case-insensitive match, the same rule the wire uses.
  const mayOverwrite = overwriteHeaders.some((name) => name.toLowerCase() === header.toLowerCase())

  // Diagnostics are for an operator, not a per-request log: cap the warnings
  // that can repeat (unresolvable routes, ignored URL parts, fetch-slot
  // re-claims) so a pathological setup cannot flood the host log.
  const warnedOnce = new Set()
  const WARNED_ONCE_MAX = 64
  const warnOnce = (key, message) => {
    if (warnedOnce.has(key) || warnedOnce.size >= WARNED_ONCE_MAX) return
    warnedOnce.add(key)
    ctx.logger.warn(message)
  }
  let rewrapWarnings = 0
  const REWRAP_WARNING_MAX = 5
  const warnRewrap = (message) => {
    if (rewrapWarnings >= REWRAP_WARNING_MAX) return
    rewrapWarnings += 1
    ctx.logger.warn(message)
  }

  // Without a callable transport there is nothing to patch, and wrapping a
  // non-function would only turn "no header" into a TypeError on every request.
  if (typeof originalFetch !== 'function') {
    ctx.logger.warn('dsh-session-header: global fetch is unavailable; header injection is disabled')
    return
  }

  // Compile one URL prefix into an origin-anchored matcher so a whitelist can
  // never match a sibling domain: `https://gateway.example.com` must not match
  // `https://gateway.example.com.evil.io/x`. The URL parser normalizes host
  // casing and default ports; the path comparison then enforces a boundary
  // character so `/zen/go/v1` matches `/zen/go/v1/messages` but not
  // `/zen/go/v10`. Unparseable or non-http(s) prefixes are dropped (fail
  // closed: a broken prefix simply never matches, so no header is sent).
  const compileEndpoint = (prefix, label) => {
    let parsed
    try {
      parsed = new URL(prefix)
    } catch {
      ctx.logger.warn(`dsh-session-header: ignoring unparseable ${label} ${JSON.stringify(prefix)}`)
      return undefined
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.logger.warn(`dsh-session-header: ignoring non-http(s) ${label} ${JSON.stringify(prefix)}`)
      return undefined
    }
    if (parsed.search !== '' || parsed.hash !== '') {
      warnOnce(
        `query:${prefix}`,
        `dsh-session-header: ${label} ${JSON.stringify(prefix)} carries a query or fragment; endpoints are matched by origin and path only`,
      )
    }
    return { origin: parsed.origin, path: parsed.pathname }
  }

  // Pre-compile the configured tool whitelist.
  const endpointMatchers = toolEndpoints
    .map((prefix) => compileEndpoint(prefix, 'toolEndpoint'))
    .filter((entry) => entry !== undefined)

  const matchesMatchers = (input, matchers) => {
    let target
    try {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
      if (typeof raw !== 'string') return false
      target = new URL(raw)
    } catch {
      return false
    }
    return matchers.some(({ origin, path }) => {
      if (target.origin !== origin) return false
      if (path === '/') return true
      const pathname = target.pathname
      return (
        pathname === path ||
        (pathname.startsWith(path) && (path.endsWith('/') || pathname[path.length] === '/'))
      )
    })
  }

  const urlMatchesEndpoint = (input) => matchesMatchers(input, endpointMatchers)

  // Read one dotted path out of a settings value; any missing hop yields
  // undefined so a partial (or renamed) profile shape degrades to "unknown"
  // instead of throwing on every request.
  const readPath = (value, path) => {
    let node = value
    for (const key of path) {
      if (node === null || typeof node !== 'object') return undefined
      node = node[key]
    }
    return node
  }

  // The endpoint(s) a route may use, so the LLM scope can be narrowed instead
  // of trusting every fetch that happens to run inside the stream. Resolution
  // is three-state:
  //   matched  - at least one usable http(s) endpoint was found
  //   invalid  - the route/config is known but every endpoint value is unusable
  //   unknown  - the route is not in the directory (nothing to narrow against)
  // `unknown` keeps the historical unrestricted behaviour; `invalid` fails
  // CLOSED, so a typo in a configured baseURL can never widen header injection
  // to unrelated hosts. The profile value (`settingsPath`) is preferred over
  // the catalog default because that is the endpoint the adapter actually
  // calls (`request.baseURL ?? catalog default`); both are accepted so a route
  // that still serves some models from the catalog endpoint also matches.
  // Resolutions are cached per provider for a short TTL because `describe()`
  // projects every plugin's schema. A resolution that depends on unavailable
  // state is not cached, and settings / adapter-topology changes clear the
  // cache; an unusable configured endpoint is cached like a match because it
  // can only change through those events.
  const UNKNOWN_ENDPOINT = Object.freeze({ status: 'unknown' })
  const INVALID_ENDPOINT = Object.freeze({ status: 'invalid' })
  const endpointCache = new Map()
  const ENDPOINT_CACHE_TTL_MS = 30_000
  const ENDPOINT_CACHE_MAX = 256

  const describeSettings = () => {
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.describe !== 'function') return undefined
    try {
      return settings.describe({ redactSecrets: true })
    } catch (error) {
      ctx.logger.warn(`dsh-session-header: could not read settings for endpoint resolution: ${error}`)
      return undefined
    }
  }

  // The live value the adapter will use: the profile's
  // `providers.<route>.baseURL`. Falls back to a shape-identical descriptor
  // when the loader names the entry differently from the route's namespace.
  // `settled` is false when the Settings document could not be read (the
  // service is absent or `describe()` threw), which means an unset value says
  // nothing about the profile: it may simply not have loaded yet.
  const configuredBaseURL = (entry) => {
    const settingsPath = [...(entry.settingsPath ?? []), 'baseURL']
    const descriptors = describeSettings()
    if (descriptors === undefined) return { value: undefined, settled: false }
    const read = (descriptor) => {
      const value = readPath(descriptor?.value, settingsPath)
      return typeof value === 'string' && value.length > 0 ? value : undefined
    }
    const byNamespace = read(descriptors.find((item) => item.ns === entry.settingsNs))
    if (byNamespace !== undefined) return { value: byNamespace, settled: true }
    for (const descriptor of descriptors) {
      const value = read(descriptor)
      if (value !== undefined) return { value, settled: true }
    }
    return { value: undefined, settled: true }
  }

  const resolveProviderEndpoint = (provider) => {
    if (typeof provider !== 'string' || provider.length === 0) return UNKNOWN_ENDPOINT
    const now = Date.now()
    const hit = endpointCache.get(provider)
    if (hit !== undefined && now - hit.at < ENDPOINT_CACHE_TTL_MS) return hit.resolution

    let resolution = UNKNOWN_ENDPOINT
    let cacheable = true
    try {
      const entry = ctx.llm
        .listConfigurableProviders()
        .find((candidate) => candidate.provider === provider)
      if (entry !== undefined) {
        const configured = configuredBaseURL(entry)
        // A match built only from the catalog default is cacheable only when
        // the Settings document was actually readable; otherwise the profile
        // baseURL may simply not have loaded yet.
        cacheable = configured.value !== undefined || configured.settled
        const candidates = [
          configured.value,
          typeof entry.defaultBaseURL === 'string' ? entry.defaultBaseURL : undefined,
        ].filter((value) => typeof value === 'string' && value.length > 0)
        const matchers = []
        for (const candidate of candidates) {
          const matcher = compileEndpoint(candidate, `baseURL for provider ${provider}`)
          if (matcher !== undefined) matchers.push(matcher)
        }
        if (matchers.length > 0) resolution = { status: 'matched', matchers }
        else if (candidates.length > 0) resolution = INVALID_ENDPOINT
      }
    } catch (error) {
      ctx.logger.warn(`dsh-session-header: could not resolve an endpoint for provider "${provider}": ${error}`)
    }
    // A route that could not be resolved at all is never cached: the directory
    // or Settings document may become available on the next call, and a cached
    // miss would keep the header unrestricted (privacy) or withheld
    // (functionality) for the whole TTL. The same holds for a default-only
    // match built while Settings were unreadable. An `invalid` resolution is
    // cached like a match: it can only change through the invalidation events.
    if (resolution !== UNKNOWN_ENDPOINT && cacheable) {
      if (endpointCache.size >= ENDPOINT_CACHE_MAX) {
        const oldest = endpointCache.keys().next().value
        if (oldest !== undefined) endpointCache.delete(oldest)
      }
      endpointCache.set(provider, { at: now, resolution })
    }
    return resolution
  }

  // `unknown` means "do not narrow" (historical behaviour); `invalid` means
  // "the configured endpoint is unusable", which fails closed.
  const llmEndpointAllows = (input, resolution) => {
    if (resolution === undefined || resolution.status === 'unknown') return true
    if (resolution.status === 'invalid') return false
    return matchesMatchers(input, resolution.matchers)
  }

  // Provider topology and Settings writes are the two ways an endpoint can
  // change; both events are cheap to observe, so drop the memoized resolutions
  // instead of waiting for the TTL.
  const clearEndpointCache = () => endpointCache.clear()
  ctx.on('llm/adapters-updated', clearEndpointCache)
  ctx.on('settings/document-updated', clearEndpointCache)

  // Harness session ids are branded: `session-<uuid>` for UI-created sessions
  // and `<agent>-session-<uuid>` for configured agents and helper calls. Strip
  // the brand only when the remainder is a plain UUID, so a gateway keyed on
  // UUID keeps working while an operator-supplied custom id is left verbatim. A
  // configured `value` is sent verbatim as documented.
  const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const stripSessionBrand = (raw) => {
    const branded = /^(?:[A-Za-z0-9_.-]+-)?session-(.+)$/.exec(raw)
    if (branded !== null && SESSION_UUID.test(branded[1])) return branded[1]
    return raw.replace(/^session-/, '')
  }
  const resolveValue = (id) => {
    if (fixedValue !== undefined) return fixedValue
    if (id === undefined) return undefined
    const value = stripSessionBrand(String(id))
    return value.length === 0 ? undefined : value
  }

  // One dispatch hop: the request goes to whatever occupied
  // `globalThis.fetch` when `install()` last re-wrapped. The child store marks
  // "this call is downstream now", so a wrapper that forwards back through the
  // global slot is recognised on the far side of an `await`.
  const transport = (input, init) => {
    // `install()` only ever records a non-`patchedFetch` function, so the
    // self-reference branch is gone; the guard still keeps the last usable
    // transport when something clobbered the slot with a non-function.
    const next = typeof innerFetch === 'function' ? innerFetch : originalFetch
    const parent = als.getStore()
    const scoped =
      parent === undefined
        ? UNSCOPED_DISPATCH
        : { ...parent, [DISPATCH_DEPTH]: (parent[DISPATCH_DEPTH] ?? 0) + 1 }
    return als.run(scoped, () => next(input, init))
  }

  // The only destination a re-entry may use: the transport captured at apply
  // time. It cannot route back into `patchedFetch` through `innerFetch`, which
  // is what makes a wrapper's async delegation finite. A host where even that
  // transport reads the global slot again would still recurse, so the chain is
  // capped and fails closed with a diagnosable error instead of exhausting the
  // process heap.
  const dispatchTerminal = (input, init) => {
    const store = als.getStore()
    const depth = store[DISPATCH_DEPTH]
    if (depth >= MAX_DISPATCH_DEPTH) {
      throw new Error(
        `dsh-session-header: fetch dispatch did not reach a transport after ${depth} hops; ` +
          'a component in the fetch chain keeps forwarding back to globalThis.fetch',
      )
    }
    return als.run({ ...store, [DISPATCH_DEPTH]: depth + 1 }, () => originalFetch(input, init))
  }

  const patchedFetch = (input, init) => {
    // Inert after unload: a wrapper that captured this function (or restored it
    // into the global slot later) must not inject for a plugin instance that is
    // gone. It still participates in dispatch bookkeeping so such a wrapper
    // keeps reaching a real transport instead of recursing through us.
    if (disposed) {
      const mark = als.getStore()
      return (mark !== undefined && mark[DISPATCH_DEPTH] !== undefined ? dispatchTerminal : transport)(input, init)
    }
    const injection = als.getStore()
    // A marked store means this call came out of the transport we just handed
    // the request to. It still gets the header — a wrapper that rebuilds the
    // request before retrying must not lose it — but it is dispatched straight
    // to the terminal transport and never through `innerFetch` again.
    const reentry = injection !== undefined && injection[DISPATCH_DEPTH] !== undefined
    const dispatch = reentry ? dispatchTerminal : transport
    if (injection === undefined || injection.value === undefined) {
      return dispatch(input, init)
    }
    // Tool-phase scopes carry the whitelist gate; skip fetches that do not
    // target one of the configured endpoints so the session id never leaks to
    // third-party hosts the tools talk to.
    if (injection.toolPhase === true && !urlMatchesEndpoint(input)) {
      return dispatch(input, init)
    }
    // LLM-phase scopes are narrowed to the route being called: the stream may
    // run unrelated plugin traffic (telemetry, other network work) in its
    // promise chain, and those requests must not receive the session id.
    // `llmEndpoint === undefined` means the route's endpoint is unknown, and
    // the historical unrestricted behaviour is kept.
    if (injection.toolPhase !== true && !llmEndpointAllows(input, injection.llmEndpoint)) {
      return dispatch(input, init)
    }
    // Collect headers from both fetch() spellings: a Request object carries
    // its own, and init.headers overrides them per the fetch standard.
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers !== undefined) {
      for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
    }
    // Inject only when absent — unless `overwriteHeaders` lists our header, in
    // which case the live session id replaces whatever placeholder value
    // another layer (an official provider) hard-coded.
    if (headers.has(header) && !mayOverwrite) {
      return dispatch(input, init)
    }
    headers.set(header, injection.value)
    // A bare Request input owns its headers; rebuild it so the original —
    // which may be reused by the caller — keeps arriving providers without us.
    if (input instanceof Request && init === undefined) {
      return dispatch(new Request(input, { headers }))
    }
    return dispatch(input, { ...init, headers })
  }

  // `globalThis.fetch` is a single mutable slot shared by the whole process, so
  // any component that assigns it after we load silently disables injection for
  // every later request. Re-claim the outermost position on demand: whatever is
  // installed now becomes our transport, and we put our patch back on top.
  const install = () => {
    if (disposed) return
    const current = globalThis.fetch
    if (current === patchedFetch) return
    // Keep the last usable transport when the slot was cleared or set to a
    // non-callable: wrapping that would only trade a missing header for a
    // TypeError on every request.
    if (typeof current === 'function') innerFetch = current
    globalThis.fetch = patchedFetch
    warnRewrap(
      typeof current === 'function'
        ? 'dsh-session-header: global fetch was replaced; re-wrapped the new transport to keep injecting'
        : 'dsh-session-header: global fetch was not a function; restored the transport to keep injecting',
    )
  }

  globalThis.fetch = patchedFetch
  // cordis `ctx.effect`: the callback runs IMMEDIATELY (setup); its RETURN
  // VALUE is the disposer collected for fiber unload. v0.1.0 ran the restore
  // in the callback body — undoing the patch in the same tick — so the fix
  // returns the restore as the disposer.
  ctx.effect(() => () => {
    disposed = true
    // The memoized endpoints and the warning bookkeeping belong to this
    // instance; drop them so a long-lived wrapper that still references this
    // closure does not keep Settings-derived data alive.
    endpointCache.clear()
    warnedOnce.clear()
    if (globalThis.fetch === patchedFetch) {
      // Restore the transport we are sitting on, not necessarily the one we saw
      // at load: it may be a replacement we re-wrapped in the meantime.
      globalThis.fetch = typeof innerFetch === 'function' ? innerFetch : originalFetch
    } else {
      // Someone else replaced fetch after we loaded; their patch fronts ours,
      // so restoring ours would silently drop theirs. `patchedFetch` is inert
      // from now on, so their chain keeps working without injecting.
      ctx.logger.warn('dsh-session-header: global fetch was replaced after load; not restoring (the patch is now inert)')
    }
  })

  ctx.on('llm/stream', async function* (options, next) {
    const inner = next()
    const iterator = inner[Symbol.asyncIterator]()
    // Narrow the scope to this route's endpoint. Resolved once per call (not
    // per fetch). `unknown` keeps the historical unrestricted behaviour;
    // `invalid` withholds the header so a broken configured endpoint can never
    // widen injection to unrelated hosts.
    const llmEndpoint = resolveProviderEndpoint(options.provider)
    if (typeof options.provider === 'string') {
      if (llmEndpoint.status === 'unknown') {
        warnOnce(
          `endpoint:unknown:${options.provider}`,
          `dsh-session-header: could not resolve a baseURL for provider "${options.provider}"; ` +
            'the header is sent to every fetch inside a model call for this route',
        )
      } else if (llmEndpoint.status === 'invalid') {
        warnOnce(
          `endpoint:invalid:${options.provider}`,
          `dsh-session-header: the configured baseURL for provider "${options.provider}" is not a usable http(s) URL; ` +
            'the header is withheld from this route (it is never sent to unrelated hosts)',
        )
      }
    }
    const scope = { value: resolveValue(options.sessionId), llmEndpoint }
    let exhausted = false
    let failure
    try {
      while (true) {
        // Re-claim the fetch slot per step: a replacement installed while this
        // stream is in flight (or before this step) would otherwise make the
        // rest of the turn arrive without the header.
        install()
        // Each adapter step runs inside the store, so its internal fetch
        // (whenever in the call it happens) sees this call's injection facts.
        const result = await als.run(scope, () => iterator.next())
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error) {
      failure = error
      throw error
    } finally {
      if (!exhausted) {
        try {
          await iterator.return?.()
        } catch (closeError) {
          // IteratorClose must not mask the error already propagating out of
          // the stream. A consumer-driven close is the only case where the
          // close error itself is the failure worth surfacing.
          if (failure === undefined) throw closeError
          ctx.logger.warn(
            `dsh-session-header: closing the model stream failed while reporting another error: ${closeError}`,
          )
        }
      }
    }
  })

  // Tool execution happens BETWEEN two streamed turns — outside any
  // `llm/stream` scope — so gateway calls made from inside a tool (e.g. an
  // Anthropic-compatible web-search Messages API against the same baseURL)
  // used to miss the header entirely. The `tools/execute` waterfall carries
  // `exec.agent.id` = the harness session id of the agent running the tool
  // (main session, compaction/title helpers, and in-process subagents each
  // report their own). Cover the whole promise chain in a scope so every
  // fetch the tool awaits is a candidate — then let the whitelist decide.
  ctx.on('tools/execute', async (exec, next) => {
    const agentId = exec?.agent?.id
    // Empty agent id (not just missing) also means "no session to report"; a
    // configured fixed `value` still applies, because it needs no session.
    const value = typeof agentId === 'string' && agentId.length > 0 ? resolveValue(agentId) : resolveValue(undefined)
    if (toolEndpoints.length === 0 || value === undefined) {
      // Nothing to inject here. Still shadow an enclosing scope: a nested
      // dispatch (a tool calling `ctx.tools.execute()` itself, a scheduled
      // post-result dispatch) must not inherit the outer session id, which
      // would attribute its whitelisted gateway calls to the wrong agent.
      if (als.getStore() === undefined) return next()
      return als.run(EMPTY_SCOPE, () => next())
    }
    // `toolPhase` turns on the whitelist gate for every fetch in this chain.
    install()
    return als.run({ value, toolPhase: true }, () => next())
  })
}
