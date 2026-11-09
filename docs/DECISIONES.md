# Decisiones

| Tema | Decisión | Motivo | Alternativa descartada |
|---|---|---|---|
| Nombre | Frugal Deck (`frugal-deck`) | Libre en GitHub y npm al revisarlo; familia Frugal | "Frugal Client": genérico y con un repositorio homónimo. Evitar "Claude" en el nombre por la marca |
| Versión | 0.1.0 con todo el alcance acordado | Pedido del usuario | |
| Stack | Electron, node-pty, xterm.js | Combinación más probada para un TUI real | Tauri: más ligero, con más riesgo en el flujo del PTY |
| Plataforma | Solo Windows en 0.1.0 | Reduce riesgo; es el entorno de uso | Multiplataforma |
| Integración | Binario oficial en PTY | Conserva todas las funciones y es la vía que permiten los términos | Agent SDK o `stream-json` con UI propia |
| Regla de producto | Cero tokens añadidos | El proyecto existe para ahorrar | Prompts, MCP o llamadas propias |
| Credenciales | Deck nunca las lee ni guarda | Los términos prohíben recoger, almacenar o intermediar credenciales | Base local con tokens |
| Cuentas | Una carpeta `CLAUDE_CONFIG_DIR` por cuenta | Método recomendado en la documentación oficial; ya lo usa Frugal | Copiar `.credentials.json` o usar `/logout`, que revoca la credencial |
| Cambio de cuenta | Reiniciar con `--resume` con Claude inactivo | No se puede cambiar en caliente | Cambio en vivo |
| Roles de cuenta | Por sesión, según su `CLAUDE_CONFIG_DIR` | `accounts.json` es global y puede haber chats en cuentas distintas a la vez | Reescribir `accounts.json` en cada cambio |
| Rotación al límite | Manual, con aviso al 80 % | Los límites de plan asumen uso individual ordinario | Cambio automático |
| Límites | Status line oficial; `/usage` oculto para otras cuentas si la prueba funciona | Sin tokens ni acceso a credenciales | Endpoint interno de uso: exigiría leer el token |
| Voz | Desactivada por defecto; al activarla, Whisper local o `/voice` de Anthropic | Ninguna gasta tokens. Whisper deja el audio en el equipo; `/voice` lo envía a Anthropic, con aviso previo | Subagente; OpenAI Realtime; corrección por cuenta secundaria |
| Adjuntos | Insertar en el cursor del CLI | Conserva el orden por diseño | Lista separada de adjuntos |
| Handoff | Detección en JSONL, sin cambios obligatorios en Frugal | Frugal no emite una señal aparte | Modificar el protocolo de Frugal |
| Umbral de handoff | Mantener 150k | 100k mejora poco y duplica los handoffs | 100k o 200k |
| Largo del handoff | No acortar | 250 palabras son menos del 1 % del arranque | Bloque más corto, con riesgo de perder calidad |
| Organización | Espacios, tags, fijados, agrupación por proyecto y `Ctrl+Shift+K` | Los tags no ocupan filas | Grupos o carpetas anidadas |
| Archivo | Copia comprimida propia | Claude Code borra transcripts CLI tras 30 días por defecto | Depender solo de `cleanupPeriodDays` |
| Nimbalyst | Construir Deck sin hacer fork; tomar ideas | Su modo principal añade prompt y MCP | Fork |

## Qué se toma de Nimbalyst

Medidor de contexto, búsqueda en historial, sesiones por worktree, vista de diff y estado por sesión. Todo sin tokens.

## Qué no se toma

Prompt de sistema propio, MCP inyectados, transcript re-renderizado, voz en la nube activada por defecto y telemetría activada por defecto.

## Avisos para el README

- Los límites de los planes asumen uso individual ordinario. Usar varias cuentas para ampliarlos queda bajo la responsabilidad de cada usuario.
- Bypass y administrador son riesgos que el usuario activa de forma explícita.
