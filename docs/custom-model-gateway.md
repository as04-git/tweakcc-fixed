# Custom Model Gateway — Maintainer's Guide

How Codex (GPT-5.6) and Kimi (K3) subscriptions run **natively** inside Claude
Code alongside the Claude subscription: real `/model` picker entries, correct
context windows, per-provider 5h/7d quota in the statusline, subagent support —
without redefining what `opus`/`sonnet`/`haiku`/`fable` mean.

Built 2026-08-08, CC 2.1.220; re-anchored + live-verified on CC 2.1.226 (2026-08-10, see §3.2/§3.4/§3.5 and M13). Read this top-to-bottom once before tweaking
anything; the failure modes section will save you.

> **Scope.** This repo carries the _patch_ half — the tweakcc patches in §3 that
> make Claude Code accept custom models at all. They are generic: any model you
> put in `settings.customModels` works, against any gateway that speaks the
> Anthropic or OpenAI wire format. The _operational_ half — the proxy service
> unit, credential resync, and the statusline — is machine-specific and lives in
> a separate repository, so file paths referenced below may not exist here.

---

## 1. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Claude Code 2.1.226 (patched binary, native ELF)                 │
│   7 tweakcc patches → model catalog, picker, ctx window,          │
│   agent-tool enum, rate-limit gate, aliases, auto-swap           │
└──────────────┬───────────────────────────────────────────────────┘
               │ ANTHROPIC_BASE_URL=http://127.0.0.1:8317
               │ CC native OAuth bearer (no credential env vars)
               ▼
┌──────────────────────────────────────────────────────────────────┐
│ CLIProxyAPI (fork, systemd user service, Restart=always)          │
│   Anthropic /v1/messages in → provider executors out              │
│   + rate-limit header synthesis (Codex/Kimi)                      │
│   + quota-state.json for the statusline                           │
└───┬──────────────────┬──────────────────┬────────────────────────┘
    │ passthrough      │ ChatGPT OAuth    │ Kimi Coding OAuth
    ▼                  ▼                  ▼
 api.anthropic.com  chatgpt.com/        api.kimi.com/coding
 (Claude Max sub)   backend-api/codex   (Kimi Code plan)
```

**Two separate problems were solved; keep them separate in your head:**

- **Problem A — routing + auth** = the proxy. CC speaks Anthropic Messages
  format; the proxy translates/forwards to each provider with its own OAuth.
- **Problem B — native model awareness** = the binary patches. `/model`, the
  statusline context bar, `/effort` rungs, and subagent model resolution all
  live _inside the CC binary_, computed from an embedded model catalog. No
  proxy can touch them.

`claudish` (the old approach) only did A, by _substituting_ model ids — which
is why it lied about what model was running and capped context at 372k. This
system replaces it. `claudish` remains installed for spawning fully separate
isolated sessions (its `create_session`/`team` MCP tools), but as of
2026-08-10 it is no longer the credential source either — do not run CC
through it, and do not treat `~/.claudish/*-oauth.json` as a source of truth.

---

## 2. Component inventory

| Component                   | Location                                                                                                                                           | Owner           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Patched CC binary           | `~/.local/share/claude/versions/2.1.226`                                                                                                           | tweakcc         |
| Patch source + tests        | `~/tweakcc-fixed` (this repo)                                                                                                                      | git             |
| tweakcc config (model defs) | `~/.tweakcc/config.json` → `settings.customModels`                                                                                                 | you             |
| Proxy source (fork)         | `~/src/CLIProxyAPI`, branch `aryan/rate-limit-headers`                                                                                             | git             |
| Proxy binary                | `~/.local/bin/cliproxyapi`                                                                                                                         | built from fork |
| Proxy config + creds        | `~/.cli-proxy-api/`                                                                                                                                | you             |
| Proxy service               | `~/.config/systemd/user/cliproxyapi.service` (+ linger on)                                                                                         | systemd         |
| Launcher                    | `~/.local/bin/cx`                                                                                                                                  | you             |
| CC env (replaces cx wiring) | `~/.claude/settings.json` → `env` (BASE_URL/API_KEY/AUTH_TOKEN, §4.7)                                                                              | you             |
| Statusline                  | `~/.claude/statusline.py` (Python; §3.8) + `~/.claude/statusline-quota-history.log`                                                                | you             |
| Go toolchain                | `~/.local/go-sdk/go/bin/go` (NOT in PATH)                                                                                                          | you             |
| Quota state (runtime)       | `~/.cli-proxy-api/quota-state.json`                                                                                                                | proxy writes    |
| Credential sources          | `~/.codex/auth.json`, `~/.kimi-code/credentials/kimi-code.json`, `~/.claude/.credentials.json` — or the proxy's own `--codex-login`/`--kimi-login` | OAuth flows     |

**Commits that matter:**

- tweakcc-fixed: `cc6b9e4` (catalog + agent-tool), `3f2ebba` (ctx window),
  `168783a` (picker), `5aae546` (rate-limit gate), `2623f27` (Opus 4.7/4.8
  picker list), `ec00ada` (aliases), `85d5f03` (statusline rewrite),
  `fe21f78` (2.1.226 re-anchor + retire obsolete no-ops, §3.2/§3.4/§3.5)
- CLIProxyAPI fork: `4256991` (Codex+Kimi header synthesis), `eaa2782`
  (quota-state.json)

---

## 3. The tweakcc patches (Problem B)

All config-driven via `settings.customModels` in `~/.tweakcc/config.json`; all
seven condition on that array being non-empty. Apply with:

```bash
cd ~/tweakcc-fixed
node dist/index.mjs --apply          # everything enabled in config
node dist/index.mjs --restore        # revert to pristine binary
```

**Value changes to `customModels` (e.g. a context window) require
`--restore && --apply`** — `custom-model-catalog` is append-only by design.

### 3.1 `custom-model-catalog` (`src/patches/customModelCatalog.ts`)

Appends entries to CC's embedded model catalog (one object literal in the
binary, `schema_version:1`, `models:[...]`, `aliases:{...}`).

- **Anchors** (non-minified literals, stable): `}],aliases:{` (models[] tail)
  and `,aliases:{opus:{default:` (aliases head).
- Entry's `id` becomes BOTH the `/model` value and the wire model name (the
  picker builders read catalog ids directly, e.g. `Km().fable5`). Use the exact
  id the proxy expects (`kimi-k3-256k`, `gpt-5.6-sol`, …).
- `effort` rungs map to catalog capabilities: always `effort`; `max` adds
  `max_effort`; `max` OR `xhigh` adds `xhigh_effort`.
- **Guards**: runtime-validates every `settings.customModels` definition before
  an apply (including local JSON, `--config-url`, and programmatic callers),
  JSON-encodes every injected scalar, then runs a structural self-validator
  before write. The catalog is `safeParse`d at runtime and a parse failure falls
  back to an EMPTY catalog = dead CC — this is THE brick risk. Also refuses
  built-in families (opus/sonnet/haiku/fable); idempotent by id-presence.

### 3.2 `context-window-from-catalog` (`src/patches/contextWindowFromCatalog.ts`)

CC's context-window resolver (`qmf` on 2.1.226; `mZc` on 2.1.220) never reads
the catalog: it special-cases 1M variants, then
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` (non-`claude-` ids only), then hardcoded
`nbr=200000`. Without this patch every custom model reports 200k to the
statusline + auto-compact (the 2.1.226 auto-compact resolver `M3` computes
its base window from this function via `hT`).

- **Anchor** (2.1.226, re-anchored 2026-08-10): the env-override guard
  `let X=te.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(X!==void 0&&X>0&&!wo(ns(e)).startsWith("claude-"))return X`.
  The minified helper names are **extracted from the file at apply time**, not
  hardcoded: `wo`/`ns` from the guard itself, the catalog by-id lookup (`Bv`,
  was `ww`) from the `.capabilities.includes` check in `l2`. The 2.1.220→2.1.226
  bump renamed every helper (`mZc→qmf`, `dro→Zti`, `ww→Bv`, `lo→wo`, `vi→ns`)
  and the hardcoded-name version silently no-opped — custom models ran at a
  wrong 200k window for a day. **The patch now fails loudly (null) on anchor
  drift instead of no-oping.**
- Injects `let cwb=wo(ns(e)),cw=cwb.startsWith("claude-")?void 0:Bv(cwb)?.context?.window;if(typeof cw==="number"&&cw>0)return cw;`
  before the env override. The `claude-` guard is NEW for 2.1.226 and
  load-bearing: the 2.1.226 catalog lists `window:1e6` for the **base**
  opus/sonnet entries (1M is opt-in via the `[1m]`/beta arms, which run
  first), so a blind catalog read would redefine built-ins to 1M.
- **Compaction path**: CC generates its summary with the current model through
  its normal Anthropic-facing `POST /v1/messages`; it does NOT call a
  provider-native compact endpoint. Verified from a manual Kimi compaction on
  2026-08-08: one 169-second `POST /v1/messages?beta=true` routed to
  `model=kimi-k3`, with no actual `/responses/compact` request. Therefore a
  Sol compaction enters the proxy as `/v1/messages` and is translated to a
  normal Codex `/responses` request — not Codex `/responses/compact`.
- Built-ins unaffected (guard + 1M arms run first). Live-verified on 2.1.226
  (2026-08-10): kimi-k3-256k → 262144, kimi-k3 → 1048576, gpt-5.6-luna →
  372000, claude-sonnet-5 → 200000.

### 3.3 `custom-model-picker` (`src/patches/customModelPicker.ts`)

Catalog injection makes a model _resolvable_ (`/model kimi-k3` works) but the
interactive picker builds its list from a fixed enumeration + pushes and never
iterates catalog `models[]`. This pushes `{value,label,description}` entries at
the `description:"Custom model"` push site (finder exported from
`modelSelector.ts`).

### 3.4 `agent-tool-model-string` (`src/patches/agentToolModelString.ts`)

The Agent/Task tool's inline `model` param is the locked surface (agent `.md`
frontmatter `model:` is already a free string). Widen it to a string schema so
subagents can take custom model ids inline.

Two minified Zod shapes are supported. CC 2.1.220 used
`v.enum(["sonnet","opus","haiku","fable"]).optional()` and is rewritten to
`v.string().optional()`. CC 2.1.226 changed syntax, not semantics: it emits the
standalone enum factory `$r(["sonnet","opus","haiku","fable"]).optional()`;
the patch captures the adjacent string factory from `subagent_type:$()` and
rewrites the model field to `$().optional()`. The previous absence check looked
only for `.enum(...)`, falsely declared this build "satisfied", and left the
live tool schema restricted. The patch now anchors to the Agent model-field
description and fails loudly on an unknown future shape.

Subagent _effort_ needs no patch: subagent definitions support an `effort`
frontmatter field (overrides session effort), and Workflow scripts have
`agent()` `opts.effort`; inline Agent-tool spawns inherit the session's effort
(no inline effort param).

### 3.5 `rate-limits-from-headers` (`src/patches/rateLimitsFromHeaders.ts`)

CC populates the statusline's `.rate_limits.five_hour/seven_day` from
`anthropic-ratelimit-unified-*` response headers ONLY when `ii()` reports an
OAuth-subscription session (checks credential scopes). With a credential env
var set (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, any proxy), `ii()` is
false and headers are ignored. This neutralizes the
gate in `cpo`: `let o=ii();if(!rir(o)){...return}` → `if(!1){...}`. Absent
headers still yield an empty map; subscriber sessions unaffected.

**UNNECESSARY on this setup (§4.7) and gate shape gone on 2.1.226**: with no
credential env vars, `ii()` is true for the whole session (it's a credential
check, not per-response), so headers from every provider parse natively. On
2.1.226 the `cpo` gate shape is gone (rate-limit machinery restructured around
representative-claim/overage-status headers). The patch logs "satisfied" on
this build. If a future launcher reintroduces credential env vars, re-check
whether a gate exists and re-anchor then.

### 3.6 `custom-model-alias` (`src/patches/customModelAlias.ts`)

`vi()` (the model resolver) only consults a hardcoded alias list
(`m1e=["sonnet","opus","haiku","fable","best",...,"opusplan"]`); catalog
`aliases{}` are never read there, so `alias` fields on custom entries were
inert and `/model k3` fell through `vi()` unchanged and 400'd at the proxy.
This injects a literal alias map at the head of `vi()`, before the built-in
switch:

```diff
 function vi(e){let t=e.trim(),r=t.toLowerCase(),n=Wb(r),o=n?Qs(r).trim():r;
+ let am={"k3":"kimi-k3","sol":"gpt-5.6-sol",...};if(am[o])return am[o];
 if(RI(o))switch(o){...
```

One injection covers `/model`, `--model`, agent frontmatter, and the Agent
tool's `model` param — everything downstream (catalog lookup `ww`, ctx window
`mZc`, allowlist `R5r`, which calls `vi()` FIRST) keys off `vi()`'s return.
Matching is case-insensitive; `k3[1m]` resolves to `kimi-k3` (the `[1m]` is
stripped before lookup and deliberately not re-appended). **Guards**: refuses
aliases colliding with built-in resolver words, with another custom model's
id, or duplicates. Alias changes require `--restore && --apply` (the anchor no
longer matches once injected; a partial pair-match fails loudly instead of
double-injecting).

### 3.7 `auto-model-swap` (`src/patches/autoModelSwap.ts`, M14)

When a small-context custom model hits its auto-compact ceiling, swap the
session to its larger-window sibling and continue **uncompacted** instead of
losing the raw conversation to a summary. Currently maps
`kimi-k3-256k → kimi-k3` (262144 → 1048576).

- **Insertion site** (2.1.226): `fXs()`, the auto-compact generator (exported
  as `autocompact` from `rVd()`), immediately AFTER the `KJ_` threshold gate —
  so the swap fires only when compaction is actually due — and before the
  reactive/auto branch, so both compaction routes are covered.
- **Mutation**: exactly what `/model` (`vwn`) and the native consent/refusal
  fallback swaps do — `setAppState({mainLoopModel:to, mainLoopModelForSession:null})`
  plus in-place `toolUseContext.options.mainLoopModel` (the query loop holds
  the same object, so it propagates this turn; appState covers future turns).
  **Session-only**: `Ewn` settings-persist deliberately skipped — a fresh
  256k session re-swaps when it fills; the user's default is untouched.
- Returns `{kind:"not_needed"}`; next turn's `KJ_` evaluates against the 1M
  window and compaction never arms. Emits a native
  `{type:"system",subtype:"notification",key:"auto-model-swap"}` banner.
- **Side-door stats**: fire-and-forget spawn of
  `~/claude-gateway/bin/model-swap-event` (exists-checked) with a JSON record
  on stdin → appends to `~/claude-gateway/model-swap-stats.jsonl`. Absent
  script = skipped. All policy lives outside the binary; deliberately NOT
  routed through CC hooks (closed event set = extra anchors; hooks intercept
  CC decisions — here the patch IS the decision).
- **Anchors**: literal `"DISABLE_COMPACT"` / `"mainLoopModel"` /
  `"autoCompactWindow"` / `"agentContext"` / `{kind:"not_needed"}` shapes in
  the `fXs` head; helper names extracted at apply time; **fails loudly (null)
  on drift**. fastMode bookkeeping skipped (Claude-side gate, no custom model
  can be a fast-mode target).

### 3.8 Also enabled

- `misc.enableModelCustomizations: true` + `CUSTOM_MODELS` in
  `modelSelector.ts` extended with Opus 4.7/4.8 (the hardcoded list stopped at
  4.6 — that WAS the "missing newer models" picker gap).

### Current `customModels` (as of 2026-08-08)

| id              | family | alias   | context_window | effort             | default |
| --------------- | ------ | ------- | -------------- | ------------------ | ------- |
| `kimi-k3`       | kimi   | `k3`    | 1048576        | low/high/max       | high    |
| `kimi-k3-256k`  | kimi   | —       | 262144         | low/high/max       | high    |
| `gpt-5.6-sol`   | gpt    | `sol`   | 372000         | low/med/high/xhigh | high    |
| `gpt-5.6-terra` | gpt    | `terra` | 372000         | low/med/high/xhigh | xhigh   |
| `gpt-5.6-luna`  | gpt    | `luna`  | 372000         | low/med/high/xhigh | high    |

Aliases resolve via the `custom-model-alias` patch (§3.6). All four verified
live end-to-end 2026-08-08 (`/model k3` → `kimi-k3` on the wire, correct
context window).

---

### 3.9 The statusline (not a patch)

`~/.claude/statusline.py` (versioned + tested in the separate gateway repo), a
Python rewrite of the old bash `statusline-command.sh` (rollback: point
`statusLine.command` in settings.json back at it). Two lines; line 2 renders
model/effort, context, cost/time, and per-provider quotas. Key properties:

- **Context segment**: YAS-style state word (`Smart/Coasting/Foggy/Cooked/
Dumb` at 25/50/70/90) + 4-wide micro-bar + pct + tokens. Toggles:
  `CC_SL_WORDS=0`, `CC_SL_BAR=0`.
- **Strict-priority greedy packing** for quotas: line 2 starts from compact
  per-provider pairs (`16/52`) and upgrades one feature at a time while the
  width budget allows — stressed windows expand first, then the current
  provider's burn rate, then its full expansion, then other providers (MRU
  order), then their burn rates, then cost/time (user's standing call: last).
  The first upgrade that doesn't fit stops the process, so a lower-priority
  feature never displaces a higher-priority one. (Replaced an all-or-nothing
  level ladder that wasted ~50 cols when full expansion overshot by a few.)
- **Width source**: CC injects a fresh `COLUMNS` into the statusline spawn env
  on EVERY render (verified 2026-08-08; absent from the CC process env, so it
  is computed per-spawn — resize-safe). No tty of any kind is available to the
  spawn; don't bother with ioctls except as fallback. `CC_SL_DEBUG=1` logs the
  width + packing result to `/tmp/sl-debug.log`.
- **Burn rate**: quota-state samples are logged (throttled, 3-day keep) to
  `~/.claude/statusline-quota-history.log`; the trailing-1h slope renders as
  `+N%/h`, amber when the pace runs the window dry before reset. `CC_SL_BURN=0`
  to disable. Caveat: this is a RECONSTRUCTION from sparse integer-percent
  samples — the authoritative source would be proxy-side (it sees every
  Codex response header and every Kimi poll). If pacing numbers ever look
  off, move the computation into the proxy and write it into quota-state.json.
- **Provider-generic + recency-ordered**: the renderer iterates whatever
  providers appear in `quota-state.json` (known glyphs `✳/⬡/☾` for
  claude/codex/kimi; a new provider gets its first letter until added to
  `PROVIDER_GLYPHS`), ordered most-recently-used first — so the active
  provider leads. The session's current provider (from the model id) keeps
  its burn rate visible at every ladder level. Adding e.g. Gemini later is a
  proxy-side change only.
- **Glyph quirk**: `✳` (U+2733) has emoji presentation in several fonts and
  overlaps the next glyph in-cell (fine in window titles — those are OS-drawn);
  the glyph string carries a trailing space as a workaround, regression-tested.

Golden tests (`statusline_test.py`, 18 cases) cover the ladder, burn rate
coloring, stale/native fallbacks, and toggles. Render time ~40ms vs ~220ms for
the bash version (which forked jq once per field).

---

## 4. The proxy fork (Problem A)

`~/src/CLIProxyAPI` branch `aryan/rate-limit-headers`, Go 1.26:

```bash
export PATH=$HOME/.local/go-sdk/go/bin:$PATH GOFLAGS=-mod=mod \
  GOMODCACHE=$HOME/.local/go-sdk/pkg/mod GOPATH=$HOME/.local/go-sdk/gopath
cd ~/src/CLIProxyAPI
go build -o ~/.local/bin/cliproxyapi ./cmd/server
systemctl --user restart cliproxyapi
```

### 4.1 Rate-limit header synthesis (`internal/runtime/executor/helps/rate_limit_headers.go`)

CC's statusline reads `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}`
(utilization as 0..1 fraction). Codex sends real quota headers on every
response (`X-Codex-Primary-Used-Percent`, `-Window-Minutes`, `-Reset-At`, plus
`Secondary-*`). `InjectCodexRateLimitHeaders` classifies by window length
(≥24h → 7d, else 5h) and stamps the Anthropic names. **Critical detail: a
0-minute window is inactive and must not be written** — Codex reports
`Secondary-Window-Minutes: 0` when the burst window isn't in play, and writing
it would overwrite the real Primary bucket (regression-tested).

### 4.2 Kimi quota polling (`internal/runtime/executor/helps/kimi_usage.go`)

Kimi exposes no response headers but has a polled endpoint:

```
GET https://api.kimi.com/coding/v1/usages   (Bearer OAuth)
→ usage:  {limit, used, resetTime}              // weekly (7d)
→ limits: [{window:{duration:300, timeUnit:TIME_UNIT_MINUTE}, detail:{...}}]  // 5h
```

`resetTime` is RFC3339Nano. Cached per-auth with stale-while-revalidate (60s
TTL, singleflight); first request for an auth fetches synchronously (4s
timeout). Stamps the same Anthropic headers.

### 4.3 quota-state.json (`internal/runtime/executor/helps/quota_state.go`)

CC's `rate_limits` slot is single-source (last response wins). The statusline
shows all three providers at once from
`~/.cli-proxy-api/quota-state.json`:

```json
{"claude": {"five_hour":{"used_percentage":13,"resets_at":...},
            "seven_day":{...}, "updated_at":...},
 "codex": {...}, "kimi": {...}}
```

- Codex: recorded at injection time (classified windows).
- Kimi: recorded from the poll snapshot, keyed by TRUE fetch time (stale cache
  must not read as fresh).
- Claude: `anthropic-ratelimit-unified-*` passthrough headers recorded on every
  upstream response (claude executor, sync + stream sites).
- Atomic tmp+rename under mutex; `~` in auth-dir resolved.

### 4.4 Call sites

- `codex_executor_execute.go` (Execute + executeCompact), `codex_executor_stream.go`:
  `helps.InjectCodexRateLimitHeaders(httpResp.Header, e.cfg.AuthDir)` right
  after `RecordAPIResponseMetadata`, before the header clone into Response.
- `kimi_executor.go` (claude-format branches of Execute + ExecuteStream):
  `claudeResp.Headers = helps.InjectKimiRateLimitHeaders(ctx, auth, e.cfg.AuthDir, claudeResp.Headers)`.
  NB: Kimi's Anthropic-format traffic delegates to the nested ClaudeExecutor —
  stamping happens on the RETURNED headers.
- `claude_executor_execute.go` / `_stream.go`:
  `helps.RecordAnthropicQuotaHeaders(e.cfg.AuthDir, "claude", httpResp.Header)`.

### 4.5 Proxy config (`~/.cli-proxy-api/config.yaml`)

```yaml
host: '127.0.0.1'
port: 8317
auth-dir: '~/.cli-proxy-api'
api-keys: ['<local key, also in cx as PROXY_KEY>']
debug: true
passthrough-headers: true # REQUIRED — without it no upstream headers reach CC
```

`passthrough-headers: true` forwards filtered upstream headers (default false
→ returns nil). The filter only blocks hop-by-hop, CORS, and known-gateway
prefixes (`x-litellm-`, `cf-aig-`, …) — `anthropic-ratelimit-*` passes.

### 4.6 Credentials (`~/.cli-proxy-api/*.json`, mode 600)

Synthesized from existing OAuth material (script pattern in git history /
session logs):

- `claude-*.json` ← `~/.claude/.credentials.json` → `claudeAiOauth`
  (access/refresh tokens, `expiresAt` ms → RFC3339 `expired`).
- `codex-*.json` ← `~/.codex/auth.json` (`tokens.id_token` for the `id_token`
  - email claim), or `cliproxyapi --codex-login` if that store is dead.
- `kimi-oauth.json` ← `~/.kimi-code/credentials/kimi-code.json` +
  `~/.kimi-code/device_id`, or `cliproxyapi --kimi-login` if that store is
  dead. No `~/.claudish/*` dependency as of 2026-08-10 — removed because the
  native CLI stores were themselves stale (unused `codex`/`kimi-code` CLI
  logins) while claudish's copies were accidentally the freshest thing on
  the machine; the proxy's own `--codex-login`/`--kimi-login` is now the
  correct "we own this" fallback instead of leaning on a tool being retired
  as the router.

Formats: `internal/auth/{claude,codex,kimi}/token.go` structs. The proxy has a
built-in auth auto-refresh subsystem (`sdk/cliproxy/auth/auto_refresh_loop.go`;
kimi is registered with a 5-minute lead in `sdk/auth/refresh_registry.go`) —
**Kimi tokens auto-renew with no external help**: the access token lives only
~15 minutes and the loop refreshes it on a ~10-minute cadence (verified in the
service logs: `auto-refresh scheduler due` → `refreshed kimi, <nil>`), plus a
reactive path refreshes on a 401 before failover (`conductor_refresh.go`).
Claude and Codex are refreshed the same way. **The resync tool below is only
needed if a REFRESH token itself is rejected** (revocation, or the provider
invalidates the chain) — not for ordinary expiry.

**Resync tool:** `python3 ~/.cli-proxy-api/resync-credentials.py [--check|--force] [provider]`.
**Needs-based** (the proxy auto-refreshes access tokens itself, so blind
copying could clobber a healthy rotated credential): a provider is synced only
if its proxy credential is missing, has no refresh token, is failing refresh
in the proxy journal (last 24h), or the native CLI store carries a newer,
different refresh token (i.e. a re-login just happened). Sources are the
NATIVE CLI stores, exclusively — `~/.claude/.credentials.json` (`claude
/login`), `~/.codex/auth.json` (`codex login`), `~/.kimi-code/credentials/`
(kimi-code CLI). No claudish fallback. If a native store is missing or dead
(refresh token gone), the fully manual alternative is the proxy's own OAuth
flows, which write the auth dir directly and become the new source of truth:
`cliproxyapi --claude-login | --codex-login | --kimi-login`.

**Re-login cadence:** Claude Code now owns the Claude refresh lifecycle
exclusively for normal CC traffic. If the chain breaks (~weekly by experience
on this shared account), run `claude /login`; no proxy resync is needed for CC
itself. `resync-credentials.py` remains useful for Codex/Kimi and for the
proxy's dormant Claude fallback credential.

### 4.7 Plain `claude` == `cx` — native subscription identity

`~/.claude/settings.json` carries ONLY the API routing override:

```json
"env": {
  "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317"
}
```

There is deliberately **no `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`**.
CC therefore loads `~/.claude/.credentials.json` as a real subscription
identity: `/login`, OAuth refresh, claude.ai connectors, `/status` billing
classification, and headless `-p` all use the vanilla code path. `BASE_URL`
reroutes only API requests (`/v1/messages`); it does not reroute Anthropic's
browser authorization or token-exchange endpoints.

The proxy has two complementary fork changes:

1. API routes trust their immediate peer when it is loopback (`127.0.0.0/8`
   or `::1`), so CC's bearer need not equal the proxy's configured local key.
   The service is explicitly bound to `127.0.0.1:8317`; management routes keep
   their separate secret middleware.
2. For requests whose upstream destination is Anthropic itself, the Claude
   executor prefers CC's incoming `sk-ant-oat…` bearer over its stored Claude
   credential. Anthropic therefore sees the same bearer and refresh owner as
   vanilla CC. Anthropic-compatible third-party executors (notably Kimi,
   which embeds `ClaudeExecutor`) are destination-gated and continue using
   their own stored credentials. A 401 from a forwarded Claude bearer is
   request-scoped: it neither refreshes nor cools down the proxy's stored
   Claude chain.

The stored Claude credential remains only as a fallback for non-CC local
clients that send no Claude OAuth bearer. Using that fallback can reintroduce
a second refresh owner; normal `claude`/`cx` traffic never exercises it.
`cx` is now functionally redundant except as a proxy-start convenience.

**History:** plain `claude` originally failed because its native credential had
been overwritten by an access-token-only export (no refresh token and epoch
`expiresAt`). It was reverse-healed from the proxy on 2026-08-08. The former
API-key and then bearer-token env approaches worked for transport but made CC
classify the session as API billing and disabled connectors; both credential
env vars are now removed.

### 4.8 systemd (the "rock solid" layer)

`~/.config/systemd/user/cliproxyapi.service`: `Restart=always`,
`RestartSec=2`, `KillMode=process`. `loginctl enable-linger` is ON (starts at
boot without login).

**Why:** the proxy kept dying silently — no panic, no OOM. Root cause: every
instance was parented to a shell/Claude session and got SIGKILLed when that
session's process tree was reaped. `nohup`/`setsid` only block SIGHUP.
systemd owns it now; verified SIGKILL → serving again in ~3s.

Ops: `journalctl --user -u cliproxyapi` (logs),
`systemctl --user restart cliproxyapi` (after rebuild).

---

## 5. Ground truths (measured, not docs)

- **Codex context window**: API metadata says 272,000. Measured: **366,810
  accepted**, ~395k rejected → real ceiling ≈ 372k (the old mirror value). The
  272k is a product cap, not a model limit. `gpt-5.4` also over-serves (291,296
  accepted) and advertises `max_context_window: 1000000` (1M mode untested).
- **Proxy model catalog is a GitHub mirror** (`router-for-me/models`), can be
  stale (it said 372000 when the API said 272000 — BOTH were "wrong" in
  different ways). Authenticated truth: `go run ./cmd/fetch_codex_models
--config <cfg> --auths-dir ~/.cli-proxy-api --output out.json`.
- **Codex rejects `thinking:{type:"disabled"}`** (500). CC always sends a
  `thinking` field (enabled/disabled/adaptive — never omits), which also makes
  the proxy's `clear_thinking` injection error a non-issue for CC traffic.
- **Codex effort**: `output_config.effort` → `reasoning.effort` verbatim in the
  translator; levels low/medium/high/xhigh (no `max`).
- **Kimi effort**: thinking-suffix form; k3 supports low/high/max server-side
  with auto-routing for the rest.
- **Claude passthrough is byte-verified upstream** against 2.1.220 (see
  `claude_executor_request.go` comments) — real Anthropic rate-limit headers
  pass through, so Claude quota works natively through the proxy.

---

## 6. Verification recipes

End-to-end (proxy + patched CC, native subscription identity):

```bash
# settings.json supplies BASE_URL; explicitly remove inherited credential vars.
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  ~/.local/bin/claude -p "hi" --model kimi-k3 --output-format json \
  | jq '.modelUsage | to_entries[0].value | {canonicalModel, contextWindow, maxOutputTokens}'
# expect: kimi-k3 / 1048576 / 65536 (or a provider quota error)
```

A fresh `CLAUDE_CONFIG_DIR` is no longer a useful auth test unless it also
contains a valid native OAuth identity: the point is specifically to exercise
CC's real `~/.claude/.credentials.json`, not a credential env override.

- Picker entries in binary: `grep -ac '"value":"kimi-k3","label":"Kimi K3"' <binary>` → 1
- Alias map in binary: `grep -ac '"k3":"kimi-k3","sol":"gpt-5.6-sol"' <binary>` → 1
- Alias end-to-end: `claude -p "say ok" --model k3 --output-format json | jq '.modelUsage|keys'` → `["kimi-k3"]`
- Rate-limit gate neutralized: `grep -ac 'if(!1){if(UDt={}' <binary>` → 1
- Quota headers on the wire: `curl -D - -o /dev/null <any /v1/messages call> | grep -i anthropic-ratelimit`
- Statusline render: `echo '<status JSON>' | python3 ~/.claude/statusline.py`;
  golden tests: `statusline_test.py` in the separate gateway repo

---

## 7. Maintenance runbook

**CC version update** (binary replaced by installer):

1. `cd ~/tweakcc-fixed && node dist/index.mjs --apply`
2. Check every patch reports ✓. A ✗ means the anchor drifted:
   `node dist/index.mjs unpack /tmp/cc.js <new binary>`, then grep `/tmp/cc.js`
   for the anchor shape (each patch file documents its anchor + the CC function
   it lives in) and update the patch.
3. Run the test suite: `pnpm exec vitest run` (+ `tsc --noEmit`).

**Adding a model**: ensure the proxy serves the id (`curl
:8317/v1/models -H "Authorization: Bearer <key>"`), add an entry to
`settings.customModels`, `--restore && --apply`, verify with §6.

**Context-window correction** (e.g. provider shrinks a window): edit config,
`--restore && --apply`. Do NOT hand-edit the binary.

**Proxy upgrade**: merge upstream into the fork, resolve against
`aryan/rate-limit-headers` (two commits, small surface), rebuild, restart.

**rotate/repair creds**: only needed when a REFRESH token is rejected (the
proxy auto-refreshes access tokens itself, §4.6). Run
`python3 ~/.cli-proxy-api/resync-credentials.py --check` to see who needs
what; a bare run syncs only the providers that need it, pulling from the
native CLI stores. If a source is stale, re-login first (`claude /login`,
`codex login`, kimi-code CLI) or use the proxy's own `--<provider>-login`.

**Reverting everything**: `node dist/index.mjs --restore` (CC back to
pristine), `systemctl --user disable --now cliproxyapi`, use plain `claude`.

---

## 8. Known limitations / open items

- **In-flight streaming request dies if the proxy restarts** (~3s systemd
  recovery; CC's retry covers it — single-turn retry, not seamless).
- **`/usage` box and picker still read as an "API session"** — `ii()` is still
  false (identity vs transport). Fixing means separating OAuth identity from
  API-key transport; deliberately untouched (attribution-confusion risk).
- **kimi-k3's 1M window** is from the model registry, not a live probe.
- **M8 — prompt bundles: RESEARCHED 2026-08-08, premise corrected.** Custom
  kimi/gpt entries currently get CC's **lean** prompt, not the long one (the
  `Zcg` full/lean switch falls through to lean for unknown ids). So the real
  question is lean-vs-full-vs-bundle, not "long prompt everywhere."
  `capabilities` is already config-supported — attaching
  `opus_5_prompt_bundle` is config + `--restore && --apply`, no patch. Its
  sections are individually env-gated (`CLAUDE_CODE_BISON_CAIRN`,
  `LARCH_CISTERN`, `MARL_CORMORANT`, `GORSE_PLOVER`, `AMBER_ASTROLABE`;
  `GAULT_KESTREL` is inverted) except `heron_brook` AgentTool-suppression and
  no-nudges. Plan: (1) zero-patch env-arm evaluation with the existing
  `tools/liveness/` harness (lean vs full vs full+bundle per custom model),
  (2) only then decide which sections are worth adapting, (3) mine Codex CLI
  (5.4/5.5-era only, local cache predates 5.6), Codex-plugin prompting
  guidance, and Kimi Code's 20k-char Jinja system prompt as EVIDENCE, never
  wholesale. Hard constraint: prompt overrides are global text splices —
  per-model divergent text needs a new model-branching patch. Anti-self-
  authoring rule: no model proposes AND ratifies the same section.
- **M9 — Gemini provider candidate**: Google AI Pro sub available;
  CLIProxyAPI supports Gemini OAuth. Proxy-side addition only — the statusline
  renderer is already provider-generic (§3.8) and CC-side needs only a new
  `customModels` entry.
- **M11 — gate the `claude-api` skill: RESEARCHED 2026-08-08, mostly
  config-only.** Its invocation payload is ~140k–215k tokens (64-file corpus:
  516KB shared + language block; all 64 when no language detected).
  Auto-trigger/listing pressure needs NO patch: `skillOverrides:
{"claude-api": "name-only"}` in settings (schema-native; keeps `/claude-api`
  and Skill-tool invocability, lists just the name). The on-invoke payload
  needs one patch: rewrite `sKS`/`Scm` (anchors: un-minified export map
  `registerClaudeApiSkill`) to emit the reading guide + a file-path index
  instead of inlining the corpus — the files are materialized on disk under
  the skill base dir regardless, so Read/Grep access is preserved.
- **M12 — Codex compaction: RESEARCHED 2026-08-08, direct routing rejected.**
  CC summarizes through ordinary `/v1/messages` (verified: one 169s
  `/v1/messages` call, zero `/responses/compact` calls, current model). But
  Codex's native compact returns an **opaque encrypted replacement-history
  blob, not a text summary** (V1 `/responses/compact`; V2 = ordinary
  `/responses` + `compaction_trigger` item — both end in
  `Compaction{encrypted_content}`). CC needs readable text for its
  transcript/`<summary>`/rewind model, so native routing is semantically
  incompatible without the proxy owning Codex history state — not worth it.
  **M12a (cheap, recommended)**: CC-side marker header on
  `querySource==="compact"` requests (anchor: `let pi=as.headers;` in the
  streaming request assembly) → proxy reads it for correct accounting and
  skips compaction-inapplicable request transforms. No prompt sniffing;
  headers survive to the executor intact. **M12b (native routing): deferred
  indefinitely.** Research notes: other Codex-native gaps inventory (turn-state
  stickiness, attestation, service_tier, WS transport) lives in the session
  transcript of 2026-08-08 if ever wanted.
- **Claude fallback credential** (§4.7): normal CC traffic forwards CC's own
  bearer and has one refresh owner. The proxy's stored Claude credential still
  exists for non-CC/no-bearer callers; exercising that fallback can reintroduce
  the old rotation race. Prefer CC's native bearer path.
- **Pricing absent** on injected catalog entries — CC-side cost readout for
  custom models is absent/zero by design (proxy still tracks real usage).
- **`gpt-5.4` 1M mode** advertised but untested; `gpt-5.4` not added to
  customModels (could be, at 272k conservative or probed first).
- **M13 — 2.1.226 re-anchor (DONE 2026-08-10, `fe21f78`).** The 2.1.226 bump
  renamed the whole resolver chain and left three gateway patches as silent
  no-ops; only `contextWindowFromCatalog` was a real regression (custom models
  at 200k). Re-anchored with apply-time name extraction + fail-loud policy +
  the new `claude-` built-in guard (2.1.226's catalog lists `window:1e6` for
  base opus/sonnet). `agentToolModelString` needed a second 2.1.226 re-anchor:
  upstream replaced the `.enum(...)` method with a standalone enum factory but
  kept the four-value restriction; `rateLimitsFromHeaders` remains unnecessary
  under §4.7.
  **Lesson now encoded in the patch: a gateway patch that can't find its
  anchor must fail loudly, never no-op** — the silent no-op is what hid this.
- **M14 — PreCompact auto-model-switch (BUILT 2026-08-10, tweakcc patch
  `auto-model-swap`).** When a `kimi-k3-256k` session hits its auto-compact
  ceiling, the session swaps to `kimi-k3` (1M) and continues uncompacted — no
  compaction and no manual `/model`. The patch sits in `fXs()` immediately
  after the `KJ_` threshold gate, performs the same session-state and
  `toolUseContext.options.mainLoopModel` mutation as `/model` without
  persisting the default, emits a native notification, and returns
  `{kind:"not_needed"}`. Side-door stats go through
  `~/claude-gateway/bin/model-swap-event` to
  `~/claude-gateway/model-swap-stats.jsonl`; a 2026-08-11 hardening pass fixed
  the original dot-directory path mismatch that silently skipped this sink.
  The earlier hook design is superseded: PreCompact input does not expose the
  model id, and its block reason does not enter model context. Anchors fail
  loudly on drift. Test: `src/patches/autoModelSwap.test.ts`; a live near-limit
  exercise remains pending (M14a).
- **M15 — >200k credits clamp can hit custom models (UNPATCHED).** CC's
  Anthropic-1M billing clamp is keyed on context size rather than provider, so a
  matching 429 can shrink any gateway model above 200k for the session. Do not
  patch until the trigger is reproduced; candidate fix is a `claude-` id guard.
- **M16 — auto-model-swap policy is hardcoded (DEFERRED).** The patch embeds
  `kimi-k3-256k → kimi-k3` and runs whenever any custom model exists. Move this
  into validated config before adding more pairs or making the behavior generic.
- **M17 — alias/catalog staleness guards are snapshots (DEFERRED).** Built-in
  alias collisions are checked against a copied list, while catalog id presence
  can hide changed windows/effort until `--restore`. Future work: extract live
  resolver collisions and stamp/compare injected-value hashes. For now, retain
  the documented `--restore && --apply` rule for custom-model value changes.

---

## 9. CC internals quick map (2.1.226; 2.1.220 names in §3.2)

For re-anchoring. All in the binary's embedded JS (`node dist/index.mjs unpack
out.js <binary>` to read it):

- Catalog object: `{schema_version:1,pricing_tiers:...,models:[...],
aliases:{...},...,alias_migration:{}}` (near file head) → Zod `.loose()` parse
  in the `c2` module; failure → empty catalog = dead CC (brick risk, §3.1).
- `ns(e)` — model resolver (was `vi`); built-in alias switch + custom aliases
  injected at its head (§3.6); strips `[1m]` via `Aa`, custom map `am={...}`.
- `Bv(e)` — catalog by-id lookup (was `ww`; `$rg().get`). Identifiable via the
  `.capabilities.includes` check in `l2`.
- `wo(e)` — alias/[1m] → base id (was `lo`). `wS(e)` — `/\[1m\]/i.test`.
- `qmf(e,t)` — raw context-window resolver (patched; was `mZc`). `hT(e,t)` —
  the used resolver: `Wmf()` env/`DISABLE_COMPACT` → `vPs` 1M-credits cap →
  `qmf`. `M3(e,t)` — auto-compact window with sources env/settings/clientdata/
  experiment/model-default/unknown-model; base window from `hT`. `Zye`/`nbr` = 200000. `JQu` — hardcoded per-model override map (NOT the catalog).
- `m$(model, cap)` — capability gate.
- `ii()` — OAuth-subscription check (credential scopes). Gates `/usage`,
  picker "Default (recommended)"; the old `cpo` rate-limit gate shape is gone
  on 2.1.226 (restructured around representative-claim/overage-status; §3.5).
- Picker: fixed entries + enumeration + pushes; `{value,label,description}`
  shape.
- Effort: `EL=["low","medium","high","xhigh","max"]`, sent as
  `output_config.effort`.
