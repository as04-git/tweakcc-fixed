# Custom Model Gateway — Maintainer's Guide

How Codex (GPT-5.6) and Kimi (K3) subscriptions run **natively** inside Claude
Code alongside the Claude subscription: real `/model` picker entries, correct
context windows, per-provider 5h/7d quota in the statusline, subagent support —
without redefining what `opus`/`sonnet`/`haiku`/`fable` mean.

Built 2026-08-08, CC 2.1.220. Read this top-to-bottom once before tweaking
anything; the failure modes section will save you.

---

## 1. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Claude Code 2.1.220 (patched binary, native ELF)                 │
│   6 tweakcc patches → model catalog, picker, ctx window,          │
│   agent-tool enum, rate-limit gate, /model aliases                │
└──────────────┬───────────────────────────────────────────────────┘
               │ ANTHROPIC_BASE_URL=http://127.0.0.1:8317
               │ ANTHROPIC_API_KEY=<local proxy key>
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
system replaces it. `claudish` remains installed and its OAuth token files are
the credential source (below); do not run CC through it anymore.

---

## 2. Component inventory

| Component                   | Location                                                                                   | Owner           |
| --------------------------- | ------------------------------------------------------------------------------------------ | --------------- |
| Patched CC binary           | `~/.local/share/claude/versions/2.1.220`                                                   | tweakcc         |
| Patch source + tests        | `~/tweakcc-fixed` (this repo)                                                              | git             |
| tweakcc config (model defs) | `~/.tweakcc/config.json` → `settings.customModels`                                         | you             |
| Proxy source (fork)         | `~/src/CLIProxyAPI`, branch `aryan/rate-limit-headers`                                     | git             |
| Proxy binary                | `~/.local/bin/cliproxyapi`                                                                 | built from fork |
| Proxy config + creds        | `~/.cli-proxy-api/`                                                                        | you             |
| Proxy service               | `~/.config/systemd/user/cliproxyapi.service` (+ linger on)                                 | systemd         |
| Launcher                    | `~/.local/bin/cx`                                                                          | you             |
| CC env (replaces cx wiring) | `~/.claude/settings.json` → `env` (BASE_URL/API_KEY/AUTH_TOKEN, §4.7)                      | you             |
| Statusline                  | `~/.claude/statusline.py` (Python; §3.8) + `~/.claude/statusline-quota-history.log`        | you             |
| Go toolchain                | `~/.local/go-sdk/go/bin/go` (NOT in PATH)                                                  | you             |
| Quota state (runtime)       | `~/.cli-proxy-api/quota-state.json`                                                        | proxy writes    |
| Credential sources          | `~/.claudish/{codex,kimi}-oauth.json`, `~/.codex/auth.json`, `~/.claude/.credentials.json` | OAuth flows     |

**Commits that matter:**

- tweakcc-fixed: `cc6b9e4` (catalog + agent-tool), `3f2ebba` (ctx window),
  `168783a` (picker), `5aae546` (rate-limit gate), `2623f27` (Opus 4.7/4.8
  picker list), `ec00ada` (aliases), `85d5f03` (statusline rewrite)
- CLIProxyAPI fork: `4256991` (Codex+Kimi header synthesis), `eaa2782`
  (quota-state.json)

---

## 3. The tweakcc patches (Problem B)

All config-driven via `settings.customModels` in `~/.tweakcc/config.json`; all
six condition on that array being non-empty. Apply with:

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
- **Guards**: structural self-validator before write (the catalog is
  `safeParse`d at runtime and a parse failure falls back to an EMPTY catalog =
  dead CC — this is THE brick risk); refuses built-in families
  (opus/sonnet/haiku/fable); idempotent by id-presence.

### 3.2 `context-window-from-catalog` (`src/patches/contextWindowFromCatalog.ts`)

CC's context-window resolver `mZc` never reads the catalog: it special-cases
1M variants, then `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (non-`claude-` ids only),
then hardcoded `ber=200000`. Without this patch every custom model reports
200k to the statusline + auto-compact.

- **Anchor**: `let X=dro(Y);if(X!==null)return X;let Z=` inside `mZc`.
- Injects `let cw=ww(lo(Y))?.context?.window;if(typeof cw==="number"&&cw>0)return cw;`
  BEFORE the env override (env keeps precedence).
- Built-ins unaffected: their 1M path is the pre-existing session-beta branch,
  which runs before the new lookup. Verified: opus/sonnet/haiku all still 200k.

### 3.3 `custom-model-picker` (`src/patches/customModelPicker.ts`)

Catalog injection makes a model _resolvable_ (`/model kimi-k3` works) but the
interactive picker builds its list from a fixed enumeration + pushes and never
iterates catalog `models[]`. This pushes `{value,label,description}` entries at
the `description:"Custom model"` push site (finder exported from
`modelSelector.ts`).

### 3.4 `agent-tool-model-string` (`src/patches/agentToolModelString.ts`)

The Agent/Task tool's inline `model` param was
`v.enum(["sonnet","opus","haiku","fable"]).optional()` — the only locked
surface (agent `.md` frontmatter `model:` is already a free string). Widened to
`v.string().optional()`. Subagents can take custom models inline.

### 3.5 `rate-limits-from-headers` (`src/patches/rateLimitsFromHeaders.ts`)

CC populates the statusline's `.rate_limits.five_hour/seven_day` from
`anthropic-ratelimit-unified-*` response headers ONLY when `ii()` reports an
OAuth-subscription session (checks credential scopes). With `ANTHROPIC_API_KEY`
set (any proxy), `ii()` is false and headers are ignored. This neutralizes the
gate in `cpo`: `let o=ii();if(!rir(o)){...return}` → `if(!1){...}`. Absent
headers still yield an empty map; subscriber sessions unaffected.

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

### 3.7 Also enabled

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

### 3.8 The statusline (not a patch)

`~/.claude/statusline.py` (versioned + tested in `docs/gateway-assets/`), a
Python rewrite of the old bash `statusline-command.sh` (rollback: point
`statusLine.command` in settings.json back at it). Two lines; line 2 renders
model/effort, context, cost/time, and per-provider quotas. Key properties:

- **Context segment**: YAS-style state word (`Smart/Coasting/Foggy/Cooked/
Dumb` at 25/50/70/90) + 4-wide micro-bar + pct + tokens. Toggles:
  `CC_SL_WORDS=0`, `CC_SL_BAR=0`.
- **Verbosity ladder** for quotas: renders as much as the width allows and
  sheds in a fixed order — cost/time first (standing call), then burn rate,
  then quiet providers collapse to `16/52` pairs, then countdowns, then pairs
  to the binding number, then word, then bar. Full form: per provider, both
  windows named with countdowns (`✳  5h 16% ↺43m · 7d 52% ↺7h53m`).
- **Width source**: CC injects a fresh `COLUMNS` into the statusline spawn env
  on EVERY render (verified 2026-08-08; absent from the CC process env, so it
  is computed per-spawn — resize-safe). No tty of any kind is available to the
  spawn; don't bother with ioctls except as fallback.
- **Burn rate**: quota-state samples are logged (throttled, 3-day keep) to
  `~/.claude/statusline-quota-history.log`; the trailing-1h slope renders as
  `+N%/h`, amber when the pace runs the window dry before reset. `CC_SL_BURN=0`
  to disable.
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
- `codex-*.json` ← `~/.claudish/codex-oauth.json` + `~/.codex/auth.json`
  (`tokens.id_token` for the `id_token` + email claim).
- `kimi-oauth.json` ← `~/.claudish/kimi-oauth.json` + `~/.claudish/kimi-device-id`.

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
NATIVE CLI stores first — `~/.claude/.credentials.json` (`claude /login`),
`~/.codex/auth.json` (`codex login`), `~/.kimi-code/credentials/` (kimi-code
CLI) — with claudish's copies as fallback. The fully manual alternative is the
proxy's own OAuth flows, which write the auth dir directly:
`cliproxyapi --claude-login | --codex-login | --kimi-login`.

**Re-login cadence:** Claude's refresh chain breaks ~weekly on this shared
account (another machine's use rotates it). When Claude starts 401ing:
`claude /login` in any terminal, then `resync-credentials.py` — the re-login
signal is detected automatically. A fresh `claude /login` also heals the
CC-side `.credentials.json` (§4.7) while it lasts.

### 4.7 Plain `claude` == `cx` (settings-env)

`~/.claude/settings.json` carries an `env` block CC applies to itself at
launch, so the proxy wiring no longer depends on launching through `cx`:

```json
"env": {
  "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",
  "ANTHROPIC_API_KEY": "<local proxy key>",
  "ANTHROPIC_AUTH_TOKEN": "<local proxy key>"
}
```

All three are needed: `BASE_URL`+`API_KEY` cover interactive use (what `cx`
sets), but **headless `-p` runs pre-flight through a login gate that rejects
the API-key path** ("Not logged in · Please run /login" — raised when the
resolver source isn't `ANTHROPIC_API_KEY`/`apiKeyHelper`); `AUTH_TOKEN` is the
bearer path headless accepts. `cx` remains as the proxy-autostart convenience
but is otherwise redundant (settings.json is mode 600 — it contains the key).

**Why plain `claude` failed before this:** no `ANTHROPIC_*` in the shell
environment → default `api.anthropic.com` + `~/.claude/.credentials.json`,
which is a BROKEN credential: access-token-only, no refresh token,
`expiresAt` pinned to the 1970 epoch → permanently "expired", unrefreshable,
login wall. The proxy holds the healthy Claude OAuth and self-refreshes it;
the CC-side file is only an identity anchor for interactive sessions — do not
"fix" it by deleting it without testing interactive startup first (the
occasional in-session "OAuth expired" blips trace to it; a fresh `cx` launch
rewrites/works around it, which is why opening another session heals the
first).

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

End-to-end (proxy + patched CC, fresh config dir):

```bash
export CLAUDE_CONFIG_DIR=/tmp/cc-test ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
       ANTHROPIC_AUTH_TOKEN=<local key>
~/.local/bin/claude -p "hi" --model kimi-k3 --output-format json \
  | jq '.modelUsage | to_entries[0].value | {canonicalModel, contextWindow, maxOutputTokens}'
# expect: kimi-k3 / 1048576 / 65536
```

NB: headless `-p` needs `ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY` (§4.7);
a fresh `CLAUDE_CONFIG_DIR` additionally needs a seeded `.claude.json` — or
just rely on the settings-env and run without `CLAUDE_CONFIG_DIR`.

- Picker entries in binary: `grep -ac '"value":"kimi-k3","label":"Kimi K3"' <binary>` → 1
- Alias map in binary: `grep -ac '"k3":"kimi-k3","sol":"gpt-5.6-sol"' <binary>` → 1
- Alias end-to-end: `claude -p "say ok" --model k3 --output-format json | jq '.modelUsage|keys'` → `["kimi-k3"]`
- Rate-limit gate neutralized: `grep -ac 'if(!1){if(UDt={}' <binary>` → 1
- Quota headers on the wire: `curl -D - -o /dev/null <any /v1/messages call> | grep -i anthropic-ratelimit`
- Statusline render: `echo '<status JSON>' | python3 ~/.claude/statusline.py`;
  golden tests: `python3 docs/gateway-assets/statusline_test.py`

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
- **Prompt bundles parked**: `opus_5_prompt_bundle`, `fable_5_mitigations`,
  `lean_prompt` capabilities are NOT set on custom entries (long default prompt
  everywhere). Per-section env vars exist for testing:
  `CLAUDE_CODE_BISON_CAIRN` (delivering-work), `CLAUDE_CODE_LARCH_CISTERN`
  (corrections). **Backlog plan**: mine the system prompts Codex CLI uses for
  the gpt-5.6 family and Kimi Code uses for k3 (fan out parallel Luna
  subagents at xhigh to collate them), then attach CC prompt-bundle
  capabilities to the custom catalog entries with our own prompts informed by
  those native-CLI best practices.
- **Gemini provider candidate**: Google AI Pro sub available; CLIProxyAPI
  supports Gemini OAuth. Proxy-side addition only — the statusline renderer is
  already provider-generic (§3.8) and CC-side needs only a new `customModels`
  entry.
- **`~/.claude/.credentials.json` is deliberately weird** (§4.7): epoch
  `expiresAt`, no refresh token. Interactive sessions tolerate it (identity
  anchor); headless must use `ANTHROPIC_AUTH_TOKEN`. Replacing it with a
  healthy OAuth export would quiet the occasional in-session "OAuth expired"
  blip, but test interactive startup before touching it.
- **Pricing absent** on injected catalog entries — CC-side cost readout for
  custom models is absent/zero by design (proxy still tracks real usage).
- **`gpt-5.4` 1M mode** advertised but untested; `gpt-5.4` not added to
  customModels (could be, at 272k conservative or probed first).

---

## 9. CC internals quick map (2.1.220)

For re-anchoring. All in the binary's embedded JS (`node dist/index.mjs unpack
out.js <binary>` to read it):

- Catalog object: `Skl={schema_version:1,pricing_tiers:...,models:[...],
aliases:{...},defaults:{},best:"fable",latest_per_family:{...},
alias_migration:{}}` → `G8m()` Zod `.loose()` parse; failure → empty `W8m`.
- `vi(e)` — model resolver; built-in alias cases via `m1e` + switch; custom
  aliases injected at its head by the `custom-model-alias` patch (§3.6).
- `ww(e)` — catalog by-id lookup (`q8m().get`).
- `lo(e)` — alias/[1m] → base id. `Wu(e)` — strips `[1m]` from wire model.
- `mZc(e,t)` — context window (patched). `lst(e)` — max output (reads catalog).
- `m$(model, cap)` — capability gate.
- `ii()` — OAuth-subscription check (credential scopes). Gates `cpo`
  (rate-limit parse, patched), `/usage`, picker "Default (recommended)".
- `SLu(headers)` — parses `anthropic-ratelimit-unified-{5h,7d}-*` into the
  statusline cache `UDt`.
- Picker: fixed entries + `for(let c of $1e())` enumeration + pushes;
  `{value,label,description}` shape.
- Effort: `EL=["low","medium","high","xhigh","max"]`, sent as
  `output_config.effort`.
