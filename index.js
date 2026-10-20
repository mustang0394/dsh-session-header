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
   * value. Everything else keeps the "never overwrite" rule. Some official
   * providers hard-code placeholder values (e.g. dsh-web-search-deepseek sends
   * `x-opencode-session: dsh-web-search`), which a gateway rejects as missing;
   * listing the header here lets the live session id replace that placeholder.
   * Case-insensitive match, default empty = never overwrite.
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
  // Guards a wrapper that forwards by reading `globalThis.fetch` instead of
  // keeping the previous implementation: re-wrapping such a wrapper would
  // otherwise bounce between the two functions forever.
  let dispatching = false

  // The Schema above already filled the defaults (the harness validates plugin
  // config through it), so these are read once here rather than re-defaulted on
  // every injection.
  const { header, value: fixedValue, toolEndpoints, overwriteHeaders } = config
  // Only one question is ever asked of `overwriteHeaders`: may we replace OUR
  // header? Case-insensitive match, the same rule the wire uses.
  const mayOverwrite = overwriteHeaders.some((name) => name.toLowerCase() === header.toLowerCase())

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

  // The baseURL of the route this call is going to, so the LLM scope can be
  // narrowed to that endpoint instead of trusting every fetch that happens to
  // run inside the stream. Returns undefined when the route's endpoint cannot
  // be established, and the caller then keeps the historical unrestricted
  // behaviour rather than silently dropping the header.
  //
  // The endpoint comes from the provider directory (`listConfigurableProviders`)
  // in two steps: a built-in catalog route carries `defaultBaseURL` directly,
  // while a route declared in the profile carries only `settingsNs` +
  // `settingsPath`, so the value is read back out of the live Settings document.
  // Descriptors are cached per provider for a short TTL because `describe()`
  // projects every plugin's schema and a turn may issue several model calls.
  const endpointCache = new Map()
  const ENDPOINT_CACHE_TTL_MS = 30_000
  let warnedNoEndpoint = false

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

  const resolveProviderEndpoint = (provider) => {
    if (typeof provider !== 'string' || provider.length === 0) return undefined
    const now = Date.now()
    const hit = endpointCache.get(provider)
    if (hit !== undefined && now - hit.at < ENDPOINT_CACHE_TTL_MS) return hit.matcher

    let matcher
    try {
      const entry = ctx.llm
        .listConfigurableProviders()
        .find((candidate) => candidate.provider === provider)
      if (entry !== undefined) {
        let baseURL = typeof entry.defaultBaseURL === 'string' ? entry.defaultBaseURL : undefined
        if (baseURL === undefined) {
          const settingsPath = [...(entry.settingsPath ?? []), 'baseURL']
          const descriptors = describeSettings()
          // Prefer the namespace the route names. Fall back to shape identity:
          // the loader may hand out a namespaced entry id that no longer equals
          // `settingsNs`, and the provider path itself is unambiguous.
          const descriptor =
            descriptors?.find((item) => item.ns === entry.settingsNs) ??
            descriptors?.find((item) => typeof readPath(item.value, settingsPath) === 'string')
          const configured = readPath(descriptor?.value, settingsPath)
          if (typeof configured === 'string' && configured.length > 0) baseURL = configured
        }
        if (baseURL !== undefined) matcher = compileEndpoint(baseURL, `baseURL for provider ${provider}`)
      }
    } catch (error) {
      ctx.logger.warn(`dsh-session-header: could not resolve an endpoint for provider "${provider}": ${error}`)
    }
    endpointCache.set(provider, { at: now, matcher })
    return matcher
  }

  // `matcher === undefined` means the endpoint is unknown, not "matches
  // nothing": callers must fall back to the unrestricted behaviour.
  const llmEndpointAllows = (input, matcher) => matcher === undefined || matchesMatchers(input, [matcher])

  // Shared by both scopes: a configured value is sent verbatim, a live id
  // loses the `session-` branding prefix, and no id at all means "no header".
  const resolveValue = (id) =>
    fixedValue ?? (id === undefined ? undefined : String(id).replace(/^session-/, ''))

  // One call to the transport currently underneath us. The re-entrancy guard
  // covers a wrapper that forwards through `globalThis.fetch` instead of the
  // implementation it captured: after re-wrapping we would call it, it would
  // call us, and the request would never reach the network.
  const transport = (input, init) => {
    const next = innerFetch === patchedFetch ? originalFetch : innerFetch
    if (dispatching) return originalFetch(input, init)
    dispatching = true
    try {
      return next(input, init)
    } finally {
      dispatching = false
    }
  }

  const patchedFetch = (input, init) => {
    const injection = als.getStore()
    if (injection === undefined || injection.value === undefined) {
      return transport(input, init)
    }
    // Tool-phase scopes carry the whitelist gate; skip fetches that do not
    // target one of the configured endpoints so the session id never leaks to
    // third-party hosts the tools talk to.
    if (injection.toolPhase === true && !urlMatchesEndpoint(input)) {
      return transport(input, init)
    }
    // LLM-phase scopes are narrowed to the route being called: the stream may
    // run unrelated plugin traffic (telemetry, other network work) in its
    // promise chain, and those requests must not receive the session id.
    // `llmEndpoint === undefined` means the route's endpoint is unknown, and
    // the historical unrestricted behaviour is kept.
    if (injection.toolPhase !== true && !llmEndpointAllows(input, injection.llmEndpoint)) {
      return transport(input, init)
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
      return transport(input, init)
    }
    headers.set(header, injection.value)
    // A bare Request input owns its headers; rebuild it so the original —
    // which may be reused by the caller — keeps arriving providers without us.
    if (input instanceof Request && init === undefined) {
      return transport(new Request(input, { headers }))
    }
    return transport(input, { ...init, headers })
  }

  // `globalThis.fetch` is a single mutable slot shared by the whole process, so
  // any component that assigns it after we load silently disables injection for
  // every later request. Re-claim the outermost position on demand: whatever is
  // installed now becomes our transport, and we put our patch back on top.
  const install = () => {
    const current = globalThis.fetch
    if (current === patchedFetch) return
    // Keep the last usable transport when the slot was cleared or set to a
    // non-callable: wrapping that would only trade a missing header for a
    // TypeError on every request.
    if (typeof current === 'function') innerFetch = current
    globalThis.fetch = patchedFetch
    ctx.logger.warn(
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
    if (globalThis.fetch === patchedFetch) {
      // Restore the transport we are sitting on, not necessarily the one we saw
      // at load: it may be a replacement we re-wrapped in the meantime.
      globalThis.fetch = innerFetch === patchedFetch ? originalFetch : innerFetch
    } else {
      // Someone else replaced fetch after we loaded; their patch fronts ours,
      // so restoring ours would silently drop theirs.
      ctx.logger.warn('dsh-session-header: global fetch was replaced after load; not restoring')
    }
  })

  ctx.on('llm/stream', async function* (options, next) {
    const inner = next()
    const iterator = inner[Symbol.asyncIterator]()
    // Narrow the scope to this route's endpoint. Resolved once per call (not
    // per fetch) and undefined for routes whose endpoint cannot be established,
    // which keeps the unrestricted behaviour for them.
    const llmEndpoint = resolveProviderEndpoint(options.provider)
    if (llmEndpoint === undefined && !warnedNoEndpoint) {
      warnedNoEndpoint = true
      ctx.logger.warn(
        `dsh-session-header: could not resolve a baseURL for provider "${options.provider}"; ` +
          'the header is sent to every fetch inside a model call for this route',
      )
    }
    const scope = { value: resolveValue(options.sessionId), llmEndpoint }
    let exhausted = false
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
    } finally {
      if (!exhausted) await iterator.return?.()
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
    const agentId = exec.agent?.id
    // Empty agent id (not just missing) also means "no session to report":
    // both scopes share the same no-value ⇒ no-header semantics.
    if (
      agentId === undefined ||
      typeof agentId !== 'string' ||
      agentId.length === 0 ||
      toolEndpoints.length === 0
    ) {
      return next()
    }
    // `toolPhase` turns on the whitelist gate for every fetch in this chain.
    install()
    return als.run({ value: resolveValue(agentId), toolPhase: true }, () => next())
  })
}
