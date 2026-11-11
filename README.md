# dsh-session-header

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that injects an `x-session-id` HTTP header onto **every LLM provider request** the harness sends, carrying the **harness session id of that exact call**.

## Why

The harness has no per-request header seam — `GenerateOptions` has no headers field and every adapter builds its own wire headers internally. If your model gateway (or an intermediary proxy) keys routing, caching, or auditing on a session header, the harness cannot send one by itself.

This plugin closes that gap with the two official interception points composed together:

- the **`llm/stream` waterfall** names the calls that are LLM calls and carries `options.sessionId`;
- a **`globalThis.fetch` patch** adds the header, so every fetch-based adapter (`llm-deepseek`, `llm-pi-ai`, and any SDK whose transport bottoms out in global fetch) is covered without touching adapter code.

Context propagation uses `AsyncLocalStorage`: only fetches that happen inside an LLM call's stream are touched; unrelated fetches (web RPC, telemetry, tool traffic) pass through untouched. A header anyone else already set is never overwritten (case-insensitive, per HTTP semantics). Unloading the plugin restores the original `fetch`.

Semantics of the value:

- default: `GenerateOptions.sessionId` of the call in flight, with the harness branding removed: `session-<uuid>` and `<agent>-session-<uuid>` send the bare UUID, while any other id has only its leading `session-` removed — main-session turns, compaction/title helper calls, and in-process subagent children each report **their own** session id (subagents get their own child session ids);
- `value` config: a fixed value for every call instead (sent verbatim, no prefix stripping);
- calls with neither get no header.

## Install

Requires the `dsh` CLI and Node ≥ 22.

### As a bundle (recommended)

```sh
dsh plugin --profile <name> add github:homily707/dsh-session-header
```

This package is plain JavaScript with no build scripts, so the pnpm ≥ 10 build allowance is not needed. Verify the layer and boot:

```sh
dsh --profile <name> --dump-config   # look for the "# == dsh-session-header" layer
dsh --profile <name>
```

### As a `--patch` overlay from a local checkout

```yaml
# my-overlay.yml — plugin rows need an absolute module path here
- insert:
    - id: session-header
      name: /absolute/path/to/dsh-session-header/index.js
      config:
        header: x-session-id
        # value: my-fixed-session-id
```

```sh
dsh --patch ./my-overlay.yml
```

## Configuration

| field | type | default | meaning |
| --- | --- | --- | --- |
| `header` | string | `x-session-id` | header name to inject; case-insensitive on the wire |
| `value` | string | — | fixed value; unset = the harness session id of the call in flight |
| `toolEndpoints` | string[] | `[]` | URL prefixes matched during tool execution. When non-empty, fetches inside a `tools/execute` waterfall — e.g. a gateway web-search Messages API called from a tool — get the header only when their URL starts with one of these prefixes; third-party tool targets (web_fetch of arbitrary pages, GitHub, MCP servers) stay untouched. Empty (default) keeps the upstream LLM-only injection. |
| `overwriteHeaders` | string[] | `[]` | Header names this plugin may overwrite when they already carry a value. Only entries naming the configured `header` have an effect. Everything else keeps the "never overwrite" rule. Some official providers hard-code placeholder values (e.g. `dsh-web-search-deepseek` sends `x-opencode-session: dsh-web-search`), which gateways reject as missing; list the header here (`overwriteHeaders: [x-opencode-session]`) so the live session id replaces that placeholder. Case-insensitive. |

## Verify it

Point a provider's `baseURL` at a logging gateway (or any endpoint that echoes request headers) and start a session:

```
x-session-id: ba104306-a748-4052-a6e3-ab60be2e4c1f
```

Every request of the same conversation carries the same id; a spawned subagent's requests carry the child session id.

## Notes

- The `llm-deepseek` adapter already sends its own `x-deepseek-harness-session-id` on every request; this plugin is provider-neutral and intentional about not overwriting existing headers.
- `attributionHeaders()` (the harness User-Agent attribution contract) is never touched.
- Concurrent sessions are handled correctly: the header value is resolved per call through AsyncLocalStorage, not through shared mutable state.
- A model call's scope is narrowed to the **endpoint(s) of the route being called**: only fetches to one of them receive the header, so unrelated traffic running inside the same promise chain (telemetry, another plugin's network work) never carries the session id. The endpoint is resolved from the provider directory: the live `baseURL` from the Settings document (the value the adapter actually calls) is preferred, and the catalog `defaultBaseURL` is kept as an additional match so a route that still serves some models from the catalog endpoint also matches. When a route is not in the directory, the historical unrestricted behaviour is kept (one `warn` per provider) rather than silently dropping the header; when every endpoint value known for the route is unusable (not parseable as http(s), e.g. a configured `baseURL` with a missing scheme and no catalog default), the scope fails **closed**, so a typo can never widen injection to unrelated hosts. Resolutions are memoized briefly and invalidated on `settings/document-updated` / `llm/adapters-updated`; a route that could not be resolved, or whose Settings value was not readable yet, is retried on the next call instead of being cached. Tool-phase injection is unaffected and still uses `toolEndpoints`.
- An invalid `header` name or fixed `value` (empty name, whitespace, control characters) is detected at load: the plugin logs one `warn` and stays disabled instead of throwing a `TypeError` on every model request.
- `globalThis.fetch` is a single process-wide slot. A component that takes it **after** this plugin loads would otherwise push the injection out of the call chain and silently disable it for every later request — the symptom being requests that arrive without the header until the plugin is disabled and re-enabled. The plugin therefore re-claims the outermost position on each streamed step and each tool dispatch, re-wrapping whatever transport it finds (with a `warn`), and keeps the previous implementation as its inner transport. Unloading restores that inner transport rather than clobbering a later plugin's patch.
- Re-entry is recognised across async boundaries: a component that captures `globalThis.fetch`, awaits, then delegates back to it no longer loops, and a wrapper that **rebuilds the request before retrying** still receives the header. The dispatch chain is capped, so a chain that never reaches a transport fails closed with a diagnostic error instead of exhausting the host heap. One known limit remains: a wrapper that hands the request to a scheduler created outside the call — a pre-existing interval, queue or worker — loses that mark.

## License

[MIT](LICENSE)
