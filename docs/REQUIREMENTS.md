# Frugal Deck 0.1.0 Requirements

## Terminal and chat

- Each new chat automatically opens Claude Code, ready to type, without typing `claude`.
- Only the terminal screen is shown, without the full console window.
- The terminal auto-adjusts when the window, sidebar, or any panel is resized.

## Attachments

- Attach files without copying paths by hand: button, drag and drop, and paste from the clipboard.
- CLI order is preserved: attachment, text, another attachment, in sequence. Example: `[Image #3] my boss said this: [Image #4]`.

## Voice

- Dictate with the microphone as an alternative to the keyboard.
- Transcribed text stays in the input for review before sending.

## Sessions and history

- Left sidebar with all sessions and history, without asking Claude to recover them.
- After a handoff, a chat groups all its sessions. With a single session it looks like a normal chat.
- With multiple sessions, a button in the chat and in the sidebar opens the previous ones.
- Sessions can be archived. Archived items are not lost and go to a separate view indicating which chat they came from.

## Organization

- A more organizable and compact model than Claude's current groups, which take up too much space: tags, groups, or tabs.

## Accounts

- Add multiple Claude accounts with official login, once per account.
- Selector to switch the primary account, the session owner, without logging in again. If this required logging in again, the feature is discarded.
- Automatic roles: the session's primary account is the primary one and other Claude accounts become Frugal secondaries. With accounts A and B: if A is primary, B is secondary; if B is primary, A is secondary.
- That behavior can be disabled in the client options.

## Limits and context

- See the 5-hour and weekly limits from a button in the chat, like in the current app.
- An additional button shows limits for all attached accounts.
- Per-session context meter.

## Handoff with Frugal

- When Frugal emits a handoff because context grew, Deck automatically opens a new session in the same chat, loading that handoff.

## Permissions

- Option to start with permission bypass and with administrator access.
- Both off by default, enable-able for all sessions or just one.
- Warning explaining what each one entails.

## Git

- Git diff panel, openable and collapsible.
- Sessions in worktree.

## Design

- The UI is designed with the Hallmark skill.

## Release

- Open-source project on GitHub.
