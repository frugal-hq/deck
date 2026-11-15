# Tauri port plan

Phase 0 of everything still pending: move Frugal Deck from Electron to Tauri 2 (Rust core, system WebView2), keeping the renderer.

## Baseline (2026-11-12, Electron 45, 4 chats open)

| Process | Working set | Private |
|---|---|---|
| Deck main + renderer + GPU + 3 utility | 335 MB | 403 MB |
| Elevated helper (second Electron: main + GPU) | 61 MB | 129 MB |
| **Deck total, 8 processes** | **396 MB** | **532 MB** |
| claude.exe x4 (not Deck's, for scale) | 1081 MB | 2501 MB |

CPU since start: renderer 349 s, GPU 190 s, main 108 s. Re-measure the same way after the port (PowerShell `Get-CimInstance Win32_Process` filtered by the exe path, summing WorkingSet64 and PrivateMemorySize64).

**Targets:** Deck total at most 200 MB working set with 4 chats; installer at most 15 MB; elevated helper at most 20 MB; renderer CPU no higher than today on the same workload.

## Scope

- **Kept as is:** `src/renderer/*` (app.js, chats.mjs, palette, trust, voice.mjs, CSS, HTML), xterm.js and its fit addon, fonts.
- **Ported to Rust:** `src/main/*`, about 2,800 lines and 65 preload channels.
- **Bridge:** a `deck.js` shim that defines `window.deck` with the same method names as `preload.js`, mapped to `invoke` and `listen`, so app.js does not change.

| Node / Electron | Rust / Tauri |
|---|---|
| node-pty (ConPTY) | `portable-pty`; output streamed over `tauri::ipc::Channel`, not JSON events |
| node:sqlite (`deck.db`) | `rusqlite` (bundled), same schema and file, so the existing index keeps working |
| worker_threads indexer, fs.watch | indexer thread, `notify` watcher, same 1 s debounce |
| http status-line bridge | `tiny_http` on localhost |
| net named pipe, elevated helper | same exe with `--elevated-helper`, loopback TCP with the same HMAC handshake, the same PowerShell launch and scheduled task |
| child_process (claude, whisper.cpp, MCP list) | `std::process::Command` |
| flashFrame, setOverlayIcon | `request_user_attention`, `set_overlay_icon` |
| dialog, shell.openExternal | `tauri-plugin-dialog`, `tauri-plugin-opener` |
| webUtils.getPathForFile | window drag-drop event paths |
| Menu.setApplicationMenu(null) | no menu; DevTools only in debug builds |

## Phases

1. **Scaffold.** Create the `tauri` branch, add `src-tauri/`, serve `src/renderer` plus copies of xterm and fonts as frontendDist, and add the `deck.js` shim with every channel stubbed. Done when the window opens with the sidebar empty.
2. **Terminal.** Port start, input, resize, kill and the output stream. Done when a Claude chat runs, resizes and closes, and its output keeps up with a long turn without lag. Ported in `src-tauri/src/chat.rs`: new chats in the default folder start, echo, resize, exit and close, and closing the window kills them. The folder picker for the dialog plugin (phase 6), administrator chats for phase 5, and accounts, the status line and the Ctrl+G editor for phase 4. Checked by hand on 2026-11-14.
3. **Index.** Port indexer.js to Rust with tests ported from `test/indexer.check.js`. Done when the sidebar, groups, workspaces, links and rename/delete match Electron on the same `deck.db`. Ported in `src-tauri/src/index.rs` (44 `cargo test`s) with the indexer thread, a `notify` watcher and resume in `chat_start`: the listing of 1,420 sessions matches `listIndex` from indexer.js on the same `deck.db` field for field and in order, and link, unlink, undo, the watcher and resume work. Main account only until phase 4, which also brings the organizer writes (topics, titles, model joins and workspaces), MCP scope renames and handoff offers. Checked by hand on 2026-11-14.
4. **Accounts and settings.** Port accounts.js, mcp.js, handoff.js, organizer.js, statusline.js and voice.js, porting each `test/*.check.js` to `cargo test`. Done when switching accounts, the MCP dialogs, handoff, the organizer, the badge status line and dictation work. Ported in `accounts.rs`, `mcp.rs`, `handoff.rs`, `organizer.rs`, `statusline.rs` and `voice.rs`, with the chat glue in `chat.rs` (82 `cargo test`s): the index reads every Claude account's projects, and over CDP the Deck lists 2 accounts, 1,210 sessions and 33 MCP servers, and the organizer estimates topics, joins and workspaces. The Ctrl+G editor is the Deck's own exe run with `--edit` from `prompt-editor.cmd` in the app data folder. Checked by hand on 2026-11-14.
5. **Elevated.** Port the helper, UAC launch and `~/.frugal-deck/elevated.log`. Done when an admin chat starts after one UAC prompt. Ported in `src-tauri/src/elevated.rs` (85 `cargo test`s, one runs a command through the helper without UAC); a chat closed while UAC waits is killed once it starts. Checked by hand on 2026-11-14. The Electron and Tauri Decks share the task name, so switching between them re-registers it after one UAC prompt.
6. **Window and OS.** Port attention flash, the overlay dot, file drop, link opening and the details panel tasks (`~/.frugal/jobs.jsonl`, `~/.frugal-deck/tasks.jsonl`). Ported in `os.rs` (file and folder dialogs, shell thumbnails, pasted images, link opening, the taskbar flash and dot) and `tasks.rs` (89 `cargo test`s; over CDP thumbnails, pasted images, tasks and the attention calls work). A drop is held by `deck.js`, its files are posted to the host with `postMessageWithAdditionalObjects`, and the drop is dispatched again with their paths; Tauri logs a console error for that message. The saved window size and position (`window.json`) are kept in the app data folder. Not ported: the overlay tooltip. Checked by hand on 2026-11-14.
7. **Package.** Build an NSIS installer with the WebView2 bootstrapper, keep `~/.frugal-deck` data, and remove Electron and node-pty. Built with `cargo tauri build` (tauri-cli 2.12.4): a 3.55 MiB NSIS installer (`installMode` both, so per user or per machine) that downloads WebView2 when it is missing, around a 14.5 MB exe. `build.rs` ships only the 400 and 500 woff2 fonts and copies `node_modules` files to `vendor`, since the CLI refuses a `frontendDist` holding a `node_modules` folder, and rewrites the renderer copies to match. The uninstaller deletes the administrator task (`installer.nsh`); `~/.frugal-deck` is never touched. The installer uses the Deck's colours and art (`src-tauri/installer/`): `installer/installer.nsi` is Tauri's NSIS template, identical to tauri-cli 2.12.4's except for the `DarkPage` calls on every page, so copy it again from `tauri-bundler` when upgrading tauri-cli. The installer people run is `setup/`, a small Tauri window in the Deck's style (tokens, font, logo) that embeds that NSIS installer and runs it silently with `/S` and `/CurrentUser` or `/AllUsers` (an existing install keeps its mode), started through ShellExecute so its administrator prompt appears; without WebView2 it runs the NSIS installer as is, which installs WebView2. Build it after the Deck: `cargo tauri build` in `src-tauri`, then `cargo build --release` in `setup` (`setup/target/release/frugal-deck-setup.exe`; keep its version in `setup/Cargo.toml` and `setup/tauri.conf.json` with the Deck's). The menu's Updates dialog (`update.rs`) offers a newer NSIS installer from the build folder the exe was built in, the latest GitHub release of `frugal-hq/deck` when its tag is newer and it has an asset ending in `_x64-setup.exe`, or a picked file; it runs the installer with `/S /R` and quits, and NSIS opens the Deck again. Each release attaches that NSIS installer, plus the setup under a name that does not end in `_x64-setup.exe`. Releases are not signed. The release exe loads the index and fonts over CDP. Electron, node-pty, `src/main` and the Node checks ported to `cargo test` are removed; CI runs `cargo test` and the renderer checks under Node. Checked by hand on 2026-11-14.
8. **Verify.** Re-measure against the baseline, then run the parity checklist: every chat action, badge, dialog and panel. Renderer checks (`*.check.mjs`) still run under Node. Measured 2026-11-13, release build, 4 new idle chats, same method: 7 processes (exe, WebView2 browser, GPU, renderer, 2 utility, crashpad), 457 MB working set and 261 MB private, against 335 MB and 403 MB for Electron without its helper. Private memory is 35% lower, but the working set is 36% higher and misses the 200 MB target: the WebView2 browser (126 MB), renderer (116 MB) and GPU (95 MB) processes hold most of it, and shared runtime pages count in each. With WebView2's memory target set to low while the window has no focus (`os::save_memory`), the same run in the background measures 183 MB working set and 247 MB private: the target is met in the background, not while the window is focused. The elevated helper measures 17 MB working set and 3 MB private (2026-11-14). Not measured yet: renderer CPU on a long workload. The installer meets its target (3.55 MiB).

## After the port (previous pending work, in order)

Missed clicks, this session's UI changes and `~/.frugal-deck/elevated.log` after a UAC prompt were checked by hand on 2026-11-14.

### Unfinished from docs/PLAN.md

- **Phase 1:** `claude.exe` is found on PATH, next to an npm shim, or in `%USERPROFILE%\.local\bin`, where the native installer puts it without changing PATH. Still to check by hand: a real user status line and an untrusted folder (Test 6).
- **Phase 3:** a handoff on 2026-11-14 named two `Read first:` paths and the new session read neither before its first reply, which only asked a question; frugal has no rule on the receiving side to read them.
- **Phase 4:** the first admin chat, the scheduled-task path and the log were checked by hand on 2026-11-14. Still to check: the elevated TUI's resize and Ctrl+G from an elevated chat. The task is used only for an exe in Program Files; elsewhere every admin chat asks UAC.
- **Phase 5:** checked by hand on 2026-11-14. Parakeet stays later.
- **Phase 6, not started:** git diff and worktree panel, `claude -w`, diff lines as `@file:line`, full chain view, archive and archived view, compressed copy in `~/.frugal-deck/archive/`, system notifications. The archive copy is mandatory before 0.1.0.
- **Phase 7, not started:** installer and CI (the Tauri NSIS work in phase 7 above covers part), README with screenshots and terms notice, re-register the administrator task on install and remove it on uninstall.

## Risks

- **Output throughput** over IPC, measured in phase 2 with `cmd /c type` of a 17.6 MB ANSI file at 200x50: node-pty alone reads 1.0 MB/s from ConPTY; the Tauri debug build delivers 0.9 MB/s to the page in 4,401 channel messages (output is batched every 4 ms; unbatched it was 0.8 MB/s in 198,894 messages). ConPTY is the ceiling, not the IPC.
- **WebView2 missing** on old Windows 10: the bootstrapper installs it.
- **Quick win without the port:** xterm's WebGL addon may cut renderer and GPU CPU. Try it in phase 2 on both builds.
