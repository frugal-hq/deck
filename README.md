<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/deck-mark-amber.svg">
  <img src="docs/brand/deck-mark.svg" alt="Frugal Deck logo" width="72">
</picture>

# Frugal Deck

Open-source desktop client that wraps the official Claude Code CLI. It shows the real terminal and adds around it what it lacks: session history, easy attachments, voice, multiple accounts, usage limits, and automatic handoff with Frugal.

## Status

In development toward 0.1.0, for Windows 10 and 11. Working today:

- The official Claude Code terminal in tabs, with context and usage-limit meters
- An index of every local session, with search and resume
- Pins, spaces, and tags
- Grouping by folder or by topic. Topics and clearer titles come from an optional one-shot Claude call that you start yourself; it uses your account's tokens and sends only titles, folder names, and dates
- New chats that open in `Frugal Deck/Sessions` in your home folder, or in a folder you choose
- Chats that join the sessions continued through a Frugal handoff, without any model call, with a Link to chat button and undo. If a handoff has several possible origins, an optional Claude call that you start yourself can pick one
- A title bar and window controls in Deck's own design

Not built yet: attachments, voice, multiple accounts, and opening the next session automatically after a handoff.

## Principles

1. **The terminal is the real one.** Deck runs the official Claude Code binary unchanged, inside a PTY.
2. **Zero added tokens.** No feature may add content to the prompt, MCP servers, or model calls. Anything that fails this is out or optional and off.
3. **Deck never touches credentials.** It does not read, copy, or store `.credentials.json` or tokens. Login is always the official flow inside the terminal.
4. **Nothing is lost.** Archiving never deletes, and Deck keeps its own copy of every session.

## Documents

| File | Content |
|---|---|
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Everything requested for the client |
| [docs/PLAN.md](docs/PLAN.md) | Complete 0.1.0 plan, by phases |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decisions made, reasons, and alternatives |
| [docs/RESEARCH.md](docs/RESEARCH.md) | Verified data, token measurement, competitors, and sources |

## License

MIT. See [LICENSE](LICENSE).
