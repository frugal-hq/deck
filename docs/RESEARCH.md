# Research (2026-11-08)

## Claude Code, verified locally (version 2.1.287)

- Flags: `--session-id`, `--resume`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode`, `--settings`, `-w/--worktree`, `-n/--name`, `--exclude-dynamic-system-prompt-sections`.
- The prompt can be passed as an argument in an interactive session: `claude [options] [prompt]`.
- JSONL in `~/.claude/projects/<folder>/<uuid>.jsonl`. Types seen: `user`, `assistant`, `attachment`, `custom-title`, `last-prompt`, `agent-name`, `system`. Useful fields: `cwd`, `sessionId`, `entrypoint`, `gitBranch`, `isSidechain`, `origin`.
- The JSONL format is undocumented: the reader must tolerate changes.
- Local volume: 7,350 project folders and more than 10,000 JSONL files. An incremental index is needed.

## Official documentation

- **Multiple accounts:** each `CLAUDE_CONFIG_DIR` has its own login, settings, and history. On Windows, the credential is in `.credentials.json` inside that folder. [Authentication](https://code.claude.com/docs/en/authentication)
- **Expired session:** only if renewal fails; `/status` indicates it.
- **Terms:** third parties may not collect, store, or broker Claude.ai credentials; starting a session in the unmodified binary is allowed. Products with the Agent SDK must use an API key. [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- **Limits:** the status line delivers `rate_limits.five_hour`, `rate_limits.seven_day`, and `context_window.used_percentage`. `rate_limits` appears only on Pro, Max, and Ultra, after the session's first response. [Status line](https://code.claude.com/docs/en/statusline)
- **Retention:** `cleanupPeriodDays` defaults to 30 and deletes without warning. Desktop sessions are kept without limit unless configured otherwise. [Settings reference](https://code.claude.com/docs/en/settings-reference)
- **Cache across sessions:** shared in the same directory and in parallel; in series, only if the git snapshot matches; not shared across different directories. [Prompt caching](https://code.claude.com/docs/en/prompt-caching)
- **Auto-compaction:** on 1M models, around 967k tokens (delegated-review data).
- **Voice:** `/voice` requires a Claude.ai account. Spanish, Windows, and operation inside a PTY are undocumented.
- **Pricing:** Opus 5.5 and Sonnet 5.5 read cache at 0.05x; writes at 1.25x (5 minutes) or 2x (1 hour). [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- **Cache weight on plans:** "counts less", with no published figures.

## Handoff token measurement

Local simulation over 215 sessions with a peak of 150k or more (45,330 calls). Only token counters were read.

**Estimated savings vs. continuing the chat**

| Threshold | Savings |
|---|---|
| 100k | 38-47% |
| 150k | 37-42% |
| 200k | 34-37% |

**Assumptions:** 50k startup, 20k to re-read files, handoff only at the start of a turn, same subsequent work, all at Opus 5.5 prices with output at 5x. Output at 5x was not confirmed because the pricing table arrived truncated. Quality loss is not measured.

- Median context peak: 340k.
- Real cost breakdown: 48% cache reads, 39% cache writes, 13% output.
- 76% of calls occurred with 150k or more context.
- First call: 47.7k in CLI (11 sessions) and 68k in Desktop (204 sessions).
- 535 cache misses with 150k or more.
- Break-even at 150k with no cache at startup: about 22 API calls.

## Frugal, local code

- `plugin/hooks/session-count.sh:36-45`: computes context and adds the rule every 150k. The model writes the block itself as text.
- `plugin/accounts/server.py:111`: `ready()` filters by `enabled`, `needs_login`, and `exhausted_until`.
- `plugin/accounts/server.py:658`: Claude accounts live in `~/.claude-<id>`.
- `~/.frugal/accounts.json` is global.

## Nimbalyst

Repository: [nimbalyst/nimbalyst](https://github.com/nimbalyst/nimbalyst), MIT, Electron.

**Verified in its code:** telemetry enabled by default (`store.ts:743`), OAuth-login sessions in `sdkOptionsBuilder.ts`, and an [open issue](https://github.com/nimbalyst/nimbalyst/issues/1646) requesting multiple accounts without logging out.

**By delegated review, not line-by-line verified:** Agent SDK as default provider and optional real TUI; own system prompt and several injected MCPs; voice with OpenAI Realtime and API key; no evidence of interleaved attachments; per-project permissions; no administrator mode; context meter with Compact button and no automatic handoff; kanban, worktrees, editors, diff, mobile, and extensions.

## Other projects reviewed

| Project | License | Approach |
|---|---|---|
| [opcode](https://github.com/winfunc/opcode) | AGPL-3.0 | Tauri, re-renders `stream-json` |
| [claudecodeui](https://github.com/siteboon/claudecodeui) | AGPL-3.0 | Agent SDK plus terminal plugin |
| [claude-squad](https://github.com/smtg-ai/claude-squad) | AGPL-3.0 | Go and tmux, real TUI |
| [crystal](https://github.com/stravu/crystal) | MIT | Electron, replaced by Nimbalyst |
| [klaudio-panels](https://github.com/willywg/klaudio-panels) | MIT | Tauri, real TUI |

## Names checked

`frugal-deck`: no matches on GitHub or npm. With matches: `frugal client`, `conch`, `Tildeck`, `Cabina`.
