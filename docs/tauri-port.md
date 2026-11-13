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
| net named pipe, elevated helper | same exe with `--elevated-helper`, `interprocess` named pipe, `ShellExecuteExW` with `runas` |
| child_process (claude, whisper.cpp, MCP list) | `std::process::Command` |
| flashFrame, setOverlayIcon | `request_user_attention`, `set_overlay_icon` |
| dialog, shell.openExternal | `tauri-plugin-dialog`, `tauri-plugin-opener` |
| webUtils.getPathForFile | window drag-drop event paths |
| Menu.setApplicationMenu(null) | no menu; DevTools only in debug builds |

## Phases

1. **Scaffold.** Create the `tauri` branch, add `src-tauri/`, serve `src/renderer` plus copies of xterm and fonts as frontendDist, and add the `deck.js` shim with every channel stubbed. Done when the window opens with the sidebar empty.
2. **Terminal.** Port start, input, resize, kill and the output stream. Done when a Claude chat runs, resizes and closes, and its output keeps up with a long turn without lag. Ported in `src-tauri/src/chat.rs`: new chats in the default folder start, echo, resize, exit and close, and closing the window kills them. Resume waits for the index (phase 3), the folder picker for the dialog plugin (phase 6), administrator chats for phase 5, and accounts, the status line and the Ctrl+G editor for phase 4. Still to check by hand: a long turn, and that Ctrl+R and F5 no longer reload the page.
3. **Index.** Port indexer.js to Rust with tests ported from `test/indexer.check.js`. Done when the sidebar, groups, workspaces, links and rename/delete match Electron on the same `deck.db`.
4. **Accounts and settings.** Port accounts.js, mcp.js, handoff.js, organizer.js, statusline.js and voice.js, porting each `test/*.check.js` to `cargo test`. Done when switching accounts, the MCP dialogs, handoff, the organizer, the badge status line and dictation work.
5. **Elevated.** Port the helper, UAC launch and `~/.frugal-deck/elevated.log`. Done when an admin chat starts after one UAC prompt.
6. **Window and OS.** Port attention flash, the overlay dot, file drop, link opening and the details panel tasks (`~/.frugal/jobs.jsonl`, `~/.frugal-deck/tasks.jsonl`).
7. **Package.** Build an NSIS installer with the WebView2 bootstrapper, keep `~/.frugal-deck` data, and remove Electron and node-pty.
8. **Verify.** Re-measure against the baseline, then run the parity checklist: every chat action, badge, dialog and panel. Renderer checks (`*.check.mjs`) still run under Node.

## After the port (previous pending work, in order)

1. Missed clicks: re-test on WebView2 and measure with DevTools (debug build) if they persist. The selection drag fix is in `ad32be4`.
2. Check this session's UI changes: selection, Task row, badge dot, MCP dialogs, usage panel, details panel tasks.
3. Read `~/.frugal-deck/elevated.log` after a UAC prompt.

### Unfinished from docs/PLAN.md

- **Phase 1:** `claude.exe` path for installs other than PATH and npm (Test 5); real user status line and untrusted folder (Test 6).
- **Phase 3:** whether new sessions read the handoff `Read first:` paths.
- **Phase 4:** built, never run with UAC. Untested: the elevated `claude` TUI, its resize, Ctrl+G from an elevated chat, and the scheduled-task path when elevated.
- **Phase 5:** the microphone path in the window; `/voice` with other voices and microphones (Test 8). Parakeet stays later.
- **Phase 6, not started:** git diff and worktree panel, `claude -w`, diff lines as `@file:line`, full chain view, archive and archived view, compressed copy in `~/.frugal-deck/archive/`, system notifications. The archive copy is mandatory before 0.1.0.
- **Phase 7, not started:** installer and CI (the Tauri NSIS work in phase 7 above covers part), README with screenshots and terms notice, install where non-admins cannot write, re-register the administrator task on install and remove it on uninstall.

## Risks

- **Output throughput** over IPC, measured in phase 2 with `cmd /c type` of a 17.6 MB ANSI file at 200x50: node-pty alone reads 1.0 MB/s from ConPTY; the Tauri debug build delivers 0.9 MB/s to the page in 4,401 channel messages (output is batched every 4 ms; unbatched it was 0.8 MB/s in 198,894 messages). ConPTY is the ceiling, not the IPC.
- **WebView2 missing** on old Windows 10: the bootstrapper installs it.
- **Quick win without the port:** xterm's WebGL addon may cut renderer and GPU CPU. Try it in phase 2 on both builds.
