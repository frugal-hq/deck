# Investigación (2026-11-08)

## Claude Code, verificado en local (versión 2.1.287)

- Flags: `--session-id`, `--resume`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode`, `--settings`, `-w/--worktree`, `-n/--name`, `--exclude-dynamic-system-prompt-sections`.
- El prompt se puede pasar como argumento en una sesión interactiva: `claude [options] [prompt]`.
- JSONL en `~/.claude/projects/<carpeta>/<uuid>.jsonl`. Tipos vistos: `user`, `assistant`, `attachment`, `custom-title`, `last-prompt`, `agent-name`, `system`. Campos útiles: `cwd`, `sessionId`, `entrypoint`, `gitBranch`, `isSidechain`, `origin`.
- El formato JSONL no está documentado: el lector debe tolerar cambios.
- Volumen local: 7350 carpetas de proyecto y más de 10 000 JSONL. Hace falta índice incremental.

## Documentación oficial

- **Varias cuentas:** cada `CLAUDE_CONFIG_DIR` tiene su propio login, ajustes e historial. En Windows, la credencial está en `.credentials.json` dentro de esa carpeta. [Authentication](https://code.claude.com/docs/en/authentication)
- **Sesión expirada:** solo si falla la renovación; `/status` lo indica.
- **Términos:** terceros no pueden recoger, almacenar ni intermediar credenciales de Claude.ai; sí se permite iniciar sesión en el binario sin modificar. Los productos con Agent SDK deben usar API key. [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- **Límites:** la status line entrega `rate_limits.five_hour`, `rate_limits.seven_day` y `context_window.used_percentage`. `rate_limits` aparece solo en Pro, Max y Ultra, tras la primera respuesta de la sesión. [Status line](https://code.claude.com/docs/en/statusline)
- **Retención:** `cleanupPeriodDays` vale 30 por defecto y borra sin avisar. Las sesiones de Desktop se conservan sin límite si no se configura lo contrario. [Settings reference](https://code.claude.com/docs/en/settings-reference)
- **Caché entre sesiones:** en el mismo directorio y en paralelo se comparte; en serie, solo si coincide el snapshot de git; entre directorios distintos no se comparte. [Prompt caching](https://code.claude.com/docs/en/prompt-caching)
- **Autocompactado:** en modelos de 1M, hacia los 967k tokens (dato de revisión delegada).
- **Voz:** `/voice` requiere cuenta Claude.ai. Español, Windows y funcionamiento dentro de un PTY no están documentados.
- **Precios:** Opus 5.5 y Sonnet 5.5 leen caché a 0.05x; escritura 1.25x (5 minutos) o 2x (1 hora). [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- **Peso del caché en planes:** "cuenta menos", sin cifras publicadas.

## Medición de tokens del handoff

Simulación local sobre 215 sesiones con un pico de 150k o más (45 330 llamadas). Solo se leyeron contadores de tokens.

**Ahorro estimado frente a continuar el chat**

| Umbral | Ahorro |
|---|---|
| 100k | 38-47 % |
| 150k | 37-42 % |
| 200k | 34-37 % |

**Supuestos:** arranque de 50k, 20k para releer archivos, handoff solo al inicio de un turno, mismo trabajo posterior, todo a precios de Opus 5.5 y salida a 5x. La salida a 5x no quedó confirmada porque la tabla de precios llegó cortada. No se mide la pérdida de calidad.

- Mediana del pico de contexto: 340k.
- Distribución del coste real: 48 % lectura de caché, 39 % escritura de caché, 13 % salida.
- El 76 % de las llamadas ocurrió con 150k o más de contexto.
- Primera llamada: 47,7k en CLI (11 sesiones) y 68k en Desktop (204 sesiones).
- 535 fallos de caché con 150k o más.
- Punto de equilibrio a 150k sin caché en el arranque: unas 22 llamadas a la API.

## Frugal, código local

- `plugin/hooks/session-count.sh:36-45`: calcula el contexto y añade la regla cada 150k. El bloque lo escribe el modelo como texto.
- `plugin/accounts/server.py:111`: `ready()` filtra por `enabled`, `needs_login` y `exhausted_until`.
- `plugin/accounts/server.py:658`: las cuentas Claude viven en `~/.claude-<id>`.
- `~/.frugal/accounts.json` es global.

## Nimbalyst

Repositorio: [nimbalyst/nimbalyst](https://github.com/nimbalyst/nimbalyst), MIT, Electron.

**Comprobado en su código:** telemetría activada por defecto (`store.ts:743`), sesiones con login OAuth en `sdkOptionsBuilder.ts`, y [issue abierto](https://github.com/nimbalyst/nimbalyst/issues/1646) que pide varias cuentas sin cerrar sesión.

**Por revisión delegada, sin verificar línea por línea:** Agent SDK como proveedor por defecto y TUI real opcional; prompt de sistema propio y varios MCP inyectados; voz con OpenAI Realtime y API key; sin evidencia de adjuntos intercalados; permisos por proyecto; sin modo administrador; medidor de contexto con botón Compact y sin handoff automático; kanban, worktrees, editores, diff, móvil y extensiones.

## Otros proyectos revisados

| Proyecto | Licencia | Enfoque |
|---|---|---|
| [opcode](https://github.com/winfunc/opcode) | AGPL-3.0 | Tauri, re-renderiza `stream-json` |
| [claudecodeui](https://github.com/siteboon/claudecodeui) | AGPL-3.0 | Agent SDK más plugin de terminal |
| [claude-squad](https://github.com/smtg-ai/claude-squad) | AGPL-3.0 | Go y tmux, TUI real |
| [crystal](https://github.com/stravu/crystal) | MIT | Electron, sustituido por Nimbalyst |
| [klaudio-panels](https://github.com/willywg/klaudio-panels) | MIT | Tauri, TUI real |

## Nombres revisados

`frugal-deck`: sin coincidencias en GitHub ni npm. Con coincidencias: `frugal client`, `conch`, `Tildeck`, `Cabina`.
