---
name: deck-ui
description: UI and UX rules for the Frugal Deck renderer (src/renderer). Use before adding or changing any screen, dialog, control, style, state, or UI text in Frugal Deck, and when auditing or fixing its UI consistency.
---

# Deck UI

Frugal Deck is a dense, dark, terminal-first desktop app. Every screen is a tool, not a page. These rules sit on top of Hallmark's floor (tokens only, `:focus-visible`, no `transition: all`, reduced motion). Hallmark's page rules (hero, 80 words, container, section gaps) do not apply here.

Files: `src/renderer/tokens.css` (tokens), `base.css` (reset), `app.css` (components), `index.html` (markup), `app.js` (behavior).

## Tokens

- No literal colour, font, radius, z-index or duration in `app.css`. Use a token or add one to `tokens.css` first.
- Spacing: `--space-*` only. A literal px is allowed for 1px rules, motion offsets and optical nudges up to 2px.
- `--text-display`, `--text-section`, `--text-title` belong to the base heading reset only; do not use them in components.
- Text sizes in the app: `--text-xs` (meta, chips, bars), `--text-sm` (body, controls), `--text-md` (dialog titles). Nothing larger.
- Weights: 400 body, 500 headings and selected items. No other weights.

## Sizes

| Token | Px | Use |
|---|---|---|
| `--size-control-xs` | 24 | inline actions inside a row or card |
| `--size-control-sm` | 28 | toolbar buttons (`.btn--bar`), selects in Settings, chips |
| `--size-row` | 32 | list rows, tabs, settings tabs, filters |
| `--size-control` | 36 | default `.btn`, form inputs and selects in dialogs |
| `--size-control-lg` | 40 | the palette query only |
| `--size-chrome` | 46 | window controls, terminal dock |

- An icon button is square: width = height = its size token.
- Icons: `--icon-sm` (12) inside xs/sm controls and rows, `--icon` (16) default, `--icon-lg` (20) in chrome. No 14, 18, 22, 23.
- Radius: `--radius-pill` for controls, rows, chips, menus, tooltips; `--radius-card` for every surface larger than one control (dialogs, popovers, banners, code and log boxes, textareas); `--radius-sm` for checkboxes and marks; `50%` only for circles.
- Z-index: `--z-*` only. Dialogs `--z-modal`, menus `--z-dropdown`, toasts and undo bar `--z-toast`, tooltips `--z-tooltip`.

## Components

Reuse before adding. A new class that does the job of one below is a bug.

- **Buttons:** `.btn` (secondary), `.btn--primary` (one per view or dialog, the main action), `.btn--danger` (destroys data), `.btn--icon`, `.btn--bar`, `.btn.is-linked` (ghost). Busy: `aria-busy="true"` + `disabled`. Any custom button class must match `.btn`'s hover (brightness 1.14), active (0.92, scale 0.97) and disabled.
- **Inputs:** one text input style: height `--size-control`, padding-inline `--space-md`, `--color-paper-3` fill, `--radius-pill`. Textareas: same fill and padding, `--radius-card`. Compact settings inputs use `--size-control-sm`.
- **Rows:** height `--size-row`, `--radius-pill`. Hover `--color-highlight`. Selected `--color-accent-soft` with `--color-ink`.
- **Tabs and segmented controls:** selected = `--color-control` plus inset highlight, everywhere.
- **Dialogs:** native `<dialog>` with `showModal()`. Width `--dialog-sm|md|lg|xl`, padding `--space-md`, `margin-block-start: 12vh` (Settings excepted), `--color-paper-2`, `--radius-card`, `--shadow-card`. Title `--text-md`/500. Actions bottom right: Cancel (`.btn`) then the primary. Escape and Cancel close it and focus returns to the opener.
- **Floating (menus, tooltips, popovers):** `--color-control-2`, `--shadow-float`, no border.
- **Banners:** `.notice` pattern for every warning or info strip: `--radius-card`, padding `--space-xs` / `--space-sm`, `--text-sm`.
- **Code and logs:** `--font-outlier`, `--color-paper-3`, `--radius-card`, `--color-ink-2`.

## States

Every interactive element is a `<button>`, `<a>`, or native form control, never a `div` or `span` with a click handler. Each has:

- hover (except text fields, which change border on focus only),
- `:focus-visible` (the global ring in `base.css`; overrides keep it visible),
- `:disabled` (muted, `cursor: not-allowed`, no hover),
- `:active` for buttons.

Every panel that loads data shows all three: loading, empty (with what to do next), error (with the message and a retry). Use the `.empty` pattern for empty and error.

## Feedback

- Irreversible or destructive (deletes data, signs out, closes a busy chat, grants trust): `askConfirm` dialog, danger button labelled with the verb ("Delete account"), never "OK" or "Yes".
- Reversible (archive, unlink, move): act now, then `showUndo`. No confirm.
- Success that is not already visible on screen (save, import, apply, copy): a short status next to the control or the undo bar. Never silent.
- Errors: inline next to the control that failed. A modal only when the user must decide something.
- Never `alert()` or `confirm()`.

## Copy

- English, sentence case everywhere: buttons, titles, tabs, menu items.
- Buttons are verbs or verb phrases: "Save", "Add server", "Close chat". No "OK".
- Terms: **chat** is what the user sees and works in; **session** only for Claude Code session files or IDs. **Remove** takes something out of Deck and keeps the data; **delete** destroys it. **Account**, never profile. **Sign in / sign out**, never log in or logout.
- Errors say what failed and what to do: "Could not save the plugin. Check the file is writable." No "Error:" prefix, no stack traces in the UI.
- Ellipsis (…) on a control that opens a dialog for more input, and at the end of progress text ("Loading…"). Nowhere else, and never three dots.

## Checklist before handing back

0. `node test/ui.check.mjs` passes (tokens, radius, z-index, transitions, no alert/confirm, defined vars).
1. `grep -nE '[0-9]+px' src/renderer/app.css` shows no new spacing, size, radius or icon literals.
2. Every new interactive element has hover, `:focus-visible`, `:disabled`.
3. Every new async panel has loading, empty and error.
4. Every new action follows Feedback.
5. Every new string follows Copy.
