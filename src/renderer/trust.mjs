// Reads Claude Code's folder trust screen. Any other screen, or a reworded one, returns null and the user answers it as usual.
const DOWN = '\x1b[B';
const ENTER = '\r';

export function trustPromptKey(lines) {
  if (!lines.includes('Accessing workspace:') || !lines.some((line) => line.startsWith('Enter to confirm'))) return null;
  if (lines.some((line) => /^[❯>] Yes, I trust this folder$/.test(line))) return ENTER;
  if (lines.some((line) => /^[❯>] No, exit$/.test(line))) return DOWN;
  return null;
}
