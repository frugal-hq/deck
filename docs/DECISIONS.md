# Decisions

| Topic | Decision | Reason | Discarded alternative |
|---|---|---|---|
| Name | Frugal Deck (`frugal-deck`) | Available on GitHub and npm when checked; Frugal family | "Frugal Client": generic and with a same-named repository. Avoid "Claude" in the name for trademark reasons |
| Version | 0.1.0 with all agreed scope | User request | |
| Stack | Electron, node-pty, xterm.js | Most proven combination for a real TUI | Tauri: lighter, with more risk in the PTY flow |
| Platform | Windows only in 0.1.0 | Reduces risk; it is the usage environment | Multiplatform |
| Integration | Official binary in PTY | Preserves all features and is the route allowed by the terms | Agent SDK or `stream-json` with own UI |
| Product rule | Zero added tokens | The project exists to save | Prompts, MCP, or own calls |
| Credentials | Deck never reads or stores them | The terms prohibit collecting, storing, or brokering credentials | Local store with tokens |
| Accounts | One `CLAUDE_CONFIG_DIR` folder per account | Method recommended in the official docs; already used by Frugal | Copying `.credentials.json` or using `/logout`, which revokes the credential |
| Account switch | Restart with `--resume` with Claude idle | Cannot switch live | Live switch |
| Account roles | Per session, according to its `CLAUDE_CONFIG_DIR` | `accounts.json` is global and there can be chats on different accounts at the same time | Rewriting `accounts.json` on every switch |
| Rotation at limit | Manual, with a warning at 80% | Plan limits assume ordinary individual use | Automatic switch |
| Limits | Official status line; hidden `/usage` for other accounts if the test works | No tokens and no credential access | Internal usage endpoint: would require reading the token |
| Voice | Off by default; when enabled, local Whisper or Anthropic `/voice` | Neither spends tokens. Whisper keeps audio on the machine; `/voice` sends it to Anthropic, with prior warning | Subagent; OpenAI Realtime; correction by secondary account |
| Attachments | Insert at the CLI cursor | Preserves order by design | Separate attachment list |
| Handoff | Detection in JSONL, no mandatory Frugal changes | Frugal emits no separate signal | Modifying the Frugal protocol |
| Handoff threshold | Keep 150k | 100k improves little and duplicates handoffs | 100k or 200k |
| Handoff length | Do not shorten | 250 words are less than 1% of startup | Shorter block, with risk of losing quality |
| Organization | Spaces, tags, pins, grouping by project, and `Ctrl+Shift+K` | Tags do not take rows | Groups or nested folders |
| Archive | Own compressed copy | Claude Code deletes CLI transcripts after 30 days by default | Relying only on `cleanupPeriodDays` |
| Nimbalyst | Build Deck without forking; take ideas | Its main mode adds prompt and MCP | Fork |

## What is taken from Nimbalyst

Context meter, history search, per-worktree sessions, diff view, and per-session state. All without tokens.

## What is not taken

Own system prompt, injected MCPs, re-rendered transcript, cloud voice enabled by default, and telemetry enabled by default.

## Notes for the README

- Plan limits assume ordinary individual use. Using multiple accounts to extend them is each user's own responsibility.
- Bypass and administrator are risks the user activates explicitly.
