# Frugal Deck 0.1.0 Plan

All agreed scope fits in 0.1.0, Windows only.

## Architecture

| Component | Technology | Role |
|---|---|---|
| Application | Electron | Window, panels, processes |
| Terminal | xterm.js with `FitAddon` | Shows the real TUI |
| PTY | node-pty (ConPTY) | Runs `claude` without a console window |
| Index | SQLite | Chats, sessions, tags, spaces, accounts |
| Voice | whisper.cpp as a helper process, or `/voice` in the PTY | Local transcription or on Anthropic |
| Administrator | Helper process elevated by UAC and named pipe | Hosts the PTY for elevated sessions |
| Design | Hallmark skill | Visual and interface direction |

**Data in `~/.frugal-deck/`:** `deck.db`, `archive/`, and `settings.json`. Accounts are stored only as name and folder path, with no tokens.

**Main tables:** `spaces`, `chats`, `sessions` (chat, order, previous session, archived), `tags`, `chat_tags`, `accounts` (name, `config_dir`), `limit_readings`.

## Phase 0: technical tests

No product is built until this phase closes.

| # | Test | Success | If it fails |
|---|---|---|---|
| 1 | TUI in xterm.js and node-pty, with scroll, colors, and drag to resize | No visible corruption | Try the WebGL renderer and adjust redraw |
| 2 | Pasting a path in the PTY generates `[Image #N]`; `@path` works with spaces | Text order intact | Clipboard plus `Alt+V` |
| 3 | Resume a session with another account, sharing `projects` via junction; sync `plugins`, `skills`, and `settings.json` | No new login and full history | Copy the JSONL; if not, switch accounts with handoff |
| 4 | Elevated PTY hosted by helper process and named pipe | Input, output, and resize work | Relaunch the whole client as administrator |
| 5 | `claude "<block>"` runs `/frugal` with a multi-line block | Skill loaded with its arguments | Paste the block into the PTY |
| 6 | `statusLine` via `--settings`, chaining the user's status line | Limit and context data received | Context from JSONL and limits only with `/usage` |
| 7 | `/usage` in a hidden PTY with another account | Readable data without spending tokens | Show only the last reading |
| 8 | Whisper quality in Spanish, and `/voice` inside the PTY | Usable transcription | Another Whisper model |
| 9 | Effect of `--exclude-dynamic-system-prompt-sections` on startup cache | Measurement recorded | Do not use the flag |

### Phase 0 results

**Test 1: passed** (2026-11-08, `spikes/01-tui`). Electron 45.2.3, node-pty 1.1.0 with its prebuilt binaries, without recompiling, and `@xterm/xterm` 6.0.0 with the default renderer. WebGL was not needed.

- A real 15 MB session resumed with `--resume`: correct colors, working mouse wheel, and no corruption after 90 resize steps at 16 ms.
- Limit: dragging was simulated with `setSize`. A manual mouse drag is still missing.

Findings for Phase 1:

- The TUI uses the alternate screen. The wheel is managed by Claude, and `term.scrollLines` is useless for scrolling history.
- Screens in the normal buffer, such as the trust dialog, leave residue in the scrollback on each resize: about 40 lines in one drag. Debounce was not tested in that case. At 150 ms there was no visible difference on the alternate screen.
- The trust dialog can appear and must be shown without accepting it automatically. It appeared in `Downloads`, stored in `.claude.json` with backslashes, and not in `frugal-plugin`, stored with forward slashes. Cause not confirmed.
- Inherited `NO_COLOR` turns off TUI colors.
- Opening with `--resume` without sending anything added between 604 and 706 bytes to the JSONL, so resuming modifies the file. The incremental index must account for this.
- `p.kill()` followed by `app.quit()` did not close the application in 80 s with the dialog open. `p.kill()` and `app.exit(0)` one second later closed without orphan processes.

**Test 2: passed with one condition** (2026-11-08, `spikes/02-paste`). Pasted with `term.paste` in a new session, with a message sent and verified in the JSONL.

- The three image paths generated `[Image #1]`, `[Image #2]`, and `[Image #3]` in place and in the correct order: without spaces, with spaces, and with spaces in quotes.
- `@"path with spaces"` attached the file. `@path with spaces` without quotes kept the text, but attached nothing and gave no visible error in the saved message.
- In the JSONL the text goes first with the markers, and images go after as separate blocks, in the same order.

**Test 3: passed with `-p`, pending in the TUI** (2026-11-08, `spikes/03-resume`). Junctions were additive and removed at the end.

- `claude-sm` resumed with `-p`, without a new login, a session created by the main account through a junction in `projects/<project>`. It remembered the session key, and the JSONL records two different organizations.
- It also resumed without error a copy of a session with signed `thinking` blocks (`claude-opus-5`). That copy does not record the original organization; the main one is assumed because it was in `~/.claude`.
- A skill linked by junction in `skills/` appeared in the listing. With `plugins` linked by junction and `settings.json` copied, `claude plugin list` came out identical (22 lines, 0 differences), in a config folder without login.

Not verified:

- **TUI with the other account.** `claude-sm` has credentials and `claude auth status` gives `loggedIn: true`, but it lacks `hasCompletedOnboarding`. The TUI showed the theme selector and then "Select login method". It was not continued. Unknown whether, once that wizard is completed once, it enters without login. Phase 3 must resolve this in "Add account".
- **Junction of the whole `projects` folder.** Tested per project, to avoid replacing the real folder of an account in use. Migrating each account's existing projects remains Phase 3 work.
- **Plugins loaded in a session.** Only the listing was checked.
- **Trust per account.** Each account has its own `.claude.json` and `claude-sm` has no trust folder at all, so the dialog should be expected in each new folder. It never got shown.

Resolved on 2026-11-09: with `hasCompletedOnboarding: true` added to `claude-sm`'s `.claude.json`, the TUI skipped the theme and login screens, showed the trust dialog in a new folder, and reached the prompt as Claude Team without a new login. No prompt was sent. The trust dialog's default option is "No, exit". "Add account" must set that flag after `claude auth login`. The whole `projects` junction and plugins loaded in a session remain unverified.

**Test 4: passed** (2026-11-08, `spikes/04-elevated`). Unprivileged Node opens the pipe and a UAC-elevated helper connects and hosts a PTY with ConPTY.

- All 8 checks passed: elevated helper and PTY (`net session`), output, input, resize to 132 columns (`[Console]::WindowWidth`), variables sent through the pipe, `claude.cmd --version`, child process output, and helper shutdown with no remaining processes.
- Without UAC, the same checks detect no elevation, so the check distinguishes both cases.

Findings for Phase 4:

- The pipe server is the unprivileged process and the elevated helper is the client. The reverse was not tested; it was avoided because the default DACL of a pipe created by an elevated process should not give write access to a normal one.
- The pipe name and token travel as helper arguments. The server validates the token, but the helper does not yet authenticate the server. The product needs mutual authentication, because a process of the same user could create another instance of the pipe.
- The helper must be installed where an unprivileged user cannot write. Otherwise it could be replaced before elevation.
- The elevated process does not inherit the client environment: Deck must send `CLAUDE_CONFIG_DIR` and other variables in the startup message.

Not verified: the `claude` TUI when elevated and its resize inside xterm.js. Only `claude.cmd --version` was run, to avoid running hooks or plugins with administrator privileges.

**Test 5: passed by launching the binary directly** (2026-11-08, `spikes/05-prompt`). 5-line `/frugal code` block as positional argument, verified in the JSONL.

- Directly to `claude.exe`: the skill loaded with all its arguments and line breaks, and followed the block's instructions.
- Via `cmd.exe /c claude`: the skill loaded only with `code`. `cmd.exe` cuts at the first line break, losing the rest with no error.
- Deck must not launch `claude` via the `.cmd` shim. In the npm install the binary is in `node_modules/@anthropic-ai/claude-code/bin/claude.exe`. Other install methods were not checked, and Phase 1 needs to resolve that path.

**Test 6: passed, with simulated chaining** (2026-11-08, `spikes/06-statusline`). `statusLine` as JSON in `--settings`, launching `claude.exe` directly with Haiku, in `frugal-plugin`.

- The status line receives on stdin `context_window` (`used_percentage`, `context_window_size`, `current_usage` with cache tokens), `rate_limits` (`five_hour` and `seven_day`, each with `used_percentage` and `resets_at`), `cost`, `session_id`, and `transcript_path`.
- In 3 invocations: the first without `rate_limits` and without context percentage, the second with `rate_limits` and `used_percentage: null`, and the third, after the response, with both. Deck must accept those empty or missing fields.
- Chaining: a script saves the JSON, passes the same stdin to another command, and returns its output. That output appeared in the TUI.

Not verified:

- **A real user status line.** `~/.claude/settings*.json` does not define `statusLine`, and a test script was chained. Deck will have to read the user's command from its settings, taking precedence into account.
- **Untrusted folder and another account.** Only tested in `frugal-plugin` with the `~/.claude` account.

**Test 7: passed with `-p`; in PTY only with the main account** (2026-11-08, `spikes/07-usage`).

- `~/.claude` account in hidden PTY: `claude "/usage"` opens the panel with session and week (`0% used`, `91% used`) and their resets. It showed `Total cost: $0.0000` and created no JSONL.
- `claude-sm` in PTY: it stays on the onboarding theme selector and never reaches `/usage`.
- `claude -p /usage --no-session-persistence --output-format json`: works without PTY and without onboarding, with `total_cost_usd: 0` and 0 tokens in `usage`. With `claude-sm` it returned the session and week lines in 2 of 2 runs. With the main account, in 2 of 2 it returned the breakdown without those lines. Cause not confirmed; the PTY panel warned of a request limit in the per-model breakdown.
- `-p` avoids onboarding and ANSI cleanup sequences, but does not guarantee percentages. They must be extracted from text, because they do not come as fields, and if missing show the last reading, which is the fallback in the table.

Not verified: that `claude-sm` percentages are its organization's. `claude auth status` gives different email and `orgId`, but both accounts showed almost identical figures (91% and 92% weekly) and the same resets. Phase 3 must confirm this before showing per-account limits.

Resolved on 2026-11-09: limits are per account. `claude-sm` reported 95% weekly with a reset on Nov 9 at 11pm Lima, while the main account's status line showed 29% with a reset on Nov 13 at 22:00 UTC. `-p /usage` again returned session and week lines for `claude-sm` (2 of 2) and not for the main account (2 of 2), at no cost, so an account cannot rely on `-p` alone.

**Test 8: Whisper usable in general Spanish with later editing; `/voice` untested** (2026-11-08, `spikes/08-whisper`). `whisper-cli` from build b5454, CPU without GPU, with a 35 s Spanish sample recorded from the microphone with ffmpeg (mean -36.7 dB, peak -19.8 dB), a single person and a single take.

- Good: "config file", "error on line 42", "tomorrow at three thirty we have", and off-script phrases said at the end.
- Bad: the start was lost ("Hello, I'm testing"), "Claude" became "could", "correct" became "I ran that", "commit" became "beginning", "pull request" became "out of memories", "budget" became "his post", and "in Lima" disappeared.
- General Spanish is understandable, but not fit for dictating technical instructions, which is Deck's use.
- Speed: 39.6 s with 4 threads and 34.1 s with 12, for 35 s of audio. More threads barely help and it does not reach real time with margin.
- `--prompt` with a glossary did not fix terms and added an invented repetition at the end ("E. E. E."). Do not use it without more tests.

- `ggml-medium` with 12 threads (21.6 s): got "review" and "correct" right, but "Claude" became "club", "commit" became "beginning", and transcription cut off after that phrase. No improvement over `small`.
- Volume normalized with `loudnorm`: worse on both models. Only "Spanish transcription" and a sequence of letters came out.
- That first sample is unreliable: it goes off script and the truncated-pass times are not valid as speed.

Second take, with the full script and an improvised final part, 35 s (mean -36.7 dB, peak -16.1 dB), 12 threads and no glossary:

| Model | Time | Hits | Misses |
|---|---|---|---|
| `ggml-small` | 11.4 s | "Hello, I'm testing", "config file", "main branch", "Lima", "budget" | "Claude" to "Klaus", "correct" to "corregir", "line 42" to "9.42", "commit" to "beginning", "pull request" to "por recues" |
| `ggml-medium` | 20.8 s | The above plus "line 42" and "3 and a half" | "transcription" to "translation", "Claude" to "Klaus", "correct" to "corregir", "commit" to "comment", "pull request" to "por request", and an invented stage direction at the end (`*gulping sound*`) |
| `ggml-large-v3` | 36.0 s | The above plus "commit", "main branch", and "3 and a half" | "Claude" to "Cloud", "correct" to "correga", "pull request" to "port request", "transcription" to "transcriptions", and an invented word at the end ("Wow!") |

- The improvised part, in general Spanish with numbers, came out well on both models.
- `ggml-large-v3` is the clearest of the three, but takes 3.1 GB and on CPU with 12 threads it takes as long as the audio lasts (36.0 s for 35 s). `ggml-medium` (20.8 s, 1.53 GB) is the option for fast response.
- Proper names and English terms still fail on all three, except "commit" in `large-v3`. Deck must leave text editable before sending it.
- Final silence can generate invented text. Phase 5 must trim silences or use VAD.

Not verified: multiple voices, other microphones, and `/voice` inside the PTY, which needs to speak live and enables a persistent setting.

**Test 9: measurement recorded** (2026-11-08, `spikes/09-cache`). With `claude-sm`, Haiku, `-p`, `--strict-mcp-config`, and `--no-session-persistence`, in two disposable folders. One response per case, about 26,250 input tokens.

| Round | Variant | Folder | Cache write | Cache read |
|---|---|---|---|---|
| 1 | No flag | A | 7,945 | 18,307 |
| 1 | No flag | B | 7,945 | 18,307 |
| 1 | With flag | A | 4,995 | 21,239 |
| 1 | With flag | B | 4,071 | 22,163 |
| 2 | No flag | A and B | 0 | 26,252 |
| 2 | With flag | A and B | 0 | 26,234 |

- With the flag, opening a new folder writes 4,071 tokens instead of 7,945, 49% less. Repeating in the same folder within the TTL, no difference.
- Limits: a single cold measurement per case, always in the same order, with part of the prefix already warm from the first call. Only measured with `-p`, not in the TUI, and the amount of dynamic context depends on the folder.

**Phase 0 closed** (2026-11-08). All nine tests have results. Anything unverified moves to the phase that uses it, in the "Pending from Phase 0" lines.

## Phase 1: base

- Window, tabs, and folder selector.
- New chat with `claude --session-id <uuid>`.
- Sidebar with incremental index of JSONLs, tolerant to unknown fields.
- Resume with `--resume <id>` in the original `cwd`.
- Spaces, tags, pins, automatic grouping by project, and `Ctrl+Shift+K`.
- Context meter, 5-hour and weekly limits in the chat.
- Automatic terminal fitting on any layout change.
- Visual direction with Hallmark.
- Pending from Phase 0: manual mouse drag (Test 1, confirmed by the user on 2026-11-11 for the window and the sidebar), `claude.exe` path in other install methods (Test 5), real user status line and untrusted folder (Test 6).

## Phase 2: attachments

- Button, drag and drop, and paste image from the clipboard.
- All inserted at the CLI cursor, so order is preserved.
- Non-image files go in as `@"path"`, always in quotes (test 2).

## Phase 3: accounts and handoff

**Accounts**
- Add account: create `~/.claude-<id>` and open `claude auth login` in the terminal.
- Primary selector: restarts the process with `--resume` and the other `CLAUDE_CONFIG_DIR`, with Claude idle.
- All-accounts view: live value, last reading with time and countdown, and "exhausted until X" for Codex, Grok, and OpenCode.
- Warning at 80% of the limit. Account switch is always manual.

**Automatic roles**
- Each session excludes its own primary account from the secondaries.
- Toggle in options, enabled by default.

**Handoff**
- Watch the JSONL at the end of each turn and detect a block starting with `/frugal` and carrying `Goal:` and `Next step:`.
- With context of 150k or more: cancellable countdown, with the block visible and editable.
- With less than 150k: only the "Continue in new session" button.
- New session with `claude.exe --session-id <new> "<block>"`, never via the `.cmd` shim (test 5), same folder, account, and permissions.
- "Start with Frugal" option, per session or global.

**Changes in frugal-plugin**
- `ready()` in `accounts/server.py`: exclude the account whose `config_dir` matches the session's `CLAUDE_CONFIG_DIR`.
- Omit the handoff `Usage:` line inside Deck.
- Test a `Read first:` field with a maximum of 3 paths.
- That repository has uncommitted local changes, including `server.py`: review them before editing.

**Pending from Phase 0**
- TUI with another account, full `projects` junction, plugins loaded in a session, and per-account trust (Test 3).
- That each account's percentages are its organization's (Test 7).

**Status (2026-11-10): done.** "Start new chats with Frugal" is a setting, and the chat badge's Frugal button types `/frugal:frugal` for one chat; both skip accounts without the plugin. The handoff template has a `Read first:` line with up to 3 paths; whether new sessions read them is untested. Transcripts are shared per file instead of a `projects` junction, and per-account limits and trust were confirmed on 2026-11-09.

## Phase 4: permissions and administrator

- Global and per-session setting, off by default. Changing it in a live session restarts it with `--resume`.
- Bypass: `--dangerously-skip-permissions`.
- Administrator: elevated helper process, with UAC on each elevated session.
- Pending from Phase 0: elevated `claude` TUI and its resize in xterm.js (Test 4).

**Status (2026-11-10): built, not yet run with UAC.** `src/main/elevated.js` relaunches the Deck with `--elevated-helper`, and each end proves it holds the secret (HMAC over the other's nonce) before a PTY starts. `test/elevated.check.js` covers the handshake and an impostor pipe server; the relay itself only runs in an elevated shell. Bypass and administrator together are confirmed once and stay accepted across restarts until either setting is turned off (the user's choice on 2026-11-11, replacing a confirmation per run); UAC still asks once per Deck run. Still untested: the elevated `claude` TUI, its resize, and Ctrl+G from an elevated chat.

**Warning texts (draft)**

- **Permission bypass:** Claude will run commands and modify or delete files without asking for confirmation. An error or malicious instruction in a file or page can cause damage before you can stop it in time. Anthropic recommends using it only in isolated containers or virtual machines.
- **Administrator:** Claude will have Windows administrator permissions and can change system configuration, services, programs, and any user's files. Those changes can leave the machine unstable or insecure.
- **Both together:** Claude can make system-wide changes with no confirmation. A single error can damage Windows or your data irreversibly. Requires explicit confirmation each time.

## Phase 5: voice

- Off by default. When enabled, a notice offers local model, Anthropic (`/voice`), or not using it.
- Microphone button.
- **Local:** capture in the client and whisper.cpp. Model selector (`small`, `medium`, `large-v3`; times in Test 8) and language. The model downloads on first use, after showing its size.
- **Local:** trim silences or use VAD before transcribing, because final silence generates invented text. Untested; whisper.cpp's VAD uses a separate model.
- **Anthropic:** does not consume tokens or count in `/usage`, and requires an active claude.ai account, without `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. The notice must say audio is sent to Anthropic's servers. `language` must be `es`, because empty dictates in English.
- **Anthropic:** untested in the PTY. Capture would probably be from `claude.exe`, not the client; confirm before implementing.
- **No install:** the notice mentions Windows dictation (`Win+H`). Unverified where it processes audio or how it handles technical terms.
- **Later:** Parakeet as another local model (`parakeet-cli.exe` already comes in build b5454). Untested in Spanish; only enters the selector if it matches or beats Whisper.
- Text is pasted at the cursor, editable, and not sent by itself.
- Pending from Phase 0: `/voice` in the PTY, other voices, and other microphones (Test 8).

**Status (2026-11-10): local dictation built.** whisper.cpp b5454 and the chosen model download to `userData/voice` after a size prompt, each checked against its size and SHA-256. The recording is trimmed by an energy gate on both ends, not Silero VAD. `src/main/voice.js` transcribed the Test 8 sample with `small`; the microphone path in the window is untested. Anthropic voice works in the app (2026-11-11): chats launch with `voice: { enabled: true, mode: "hold" }` in `--settings`, because Claude Code reads `voice.enabled` before `voiceEnabled` and `/voice off` writes it to user settings, and the mic button holds Space by sending it every 30 ms. Claude Code dictation defaults to English; its language comes from `/config`. Parakeet stays later.

## Phase 6: Git, chains, and archive

- Collapsible right panel: `git diff` and `git worktree list`, without tokens.
- Option to create the chat in a worktree with `claude -w`.
- Send selected diff lines as `@file:line`.
- Full view of a chat's sessions.
- Archive and archived view with their source chat.
- Compressed copy of each session in `~/.frugal-deck/archive/` and restore on reopen.
- System notification when Claude finishes or asks for permission.

## Phase 7: 0.1.0 release

- Installer and CI.
- README with screenshots and terms notice: individual use, no credential brokering.
- Public repository on GitHub, `frugal-hq/deck`, MIT license.
- No code signing, SmartScreen will show a warning.
- The installer must put the Deck, and so its elevated helper, where non-admins cannot write (Test 4). Until then an administrator chat runs code from a user-writable folder.

**The Phase 6 archive copy is mandatory before release**, because Claude Code deletes CLI transcripts after 30 days by default.

## Out of 0.1.0

macOS, Linux, cloud sessions, kanban, visual editors, mobile app, extension system, and automatic account switching at the limit.
