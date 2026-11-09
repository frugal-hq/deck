# Plan de Frugal Deck 0.1.0

Todo el alcance acordado entra en 0.1.0, solo para Windows.

## Arquitectura

| Pieza | Tecnología | Función |
|---|---|---|
| Aplicación | Electron | Ventana, paneles, procesos |
| Terminal | xterm.js con `FitAddon` | Muestra el TUI real |
| PTY | node-pty (ConPTY) | Ejecuta `claude` sin ventana de consola |
| Índice | SQLite | Chats, sesiones, tags, espacios, cuentas |
| Voz | whisper.cpp como proceso auxiliar, o `/voice` en el PTY | Transcripción local o en Anthropic |
| Administrador | Proceso auxiliar elevado por UAC y named pipe | Aloja el PTY de sesiones elevadas |
| Diseño | Skill Hallmark | Dirección visual e interfaz |

**Datos en `~/.frugal-deck/`:** `deck.db`, `archive/` y `settings.json`. Las cuentas se guardan solo como nombre y ruta de carpeta, sin tokens.

**Tablas principales:** `spaces`, `chats`, `sessions` (chat, orden, sesión anterior, archivada), `tags`, `chat_tags`, `accounts` (nombre, `config_dir`), `limit_readings`.

## Fase 0: pruebas técnicas

No se construye producto hasta cerrar esta fase.

| # | Prueba | Éxito | Si falla |
|---|---|---|---|
| 1 | TUI en xterm.js y node-pty, con scroll, colores y arrastre para redimensionar | Sin corrupción visible | Probar renderizador WebGL y ajustar el redibujado |
| 2 | Pegar una ruta en el PTY genera `[Image #N]`; `@ruta` funciona con espacios | Orden del texto intacto | Portapapeles más `Alt+V` |
| 3 | Reanudar una sesión con otra cuenta, compartiendo `projects` por junction; sincronizar `plugins`, `skills` y `settings.json` | Sin nuevo login y con historial completo | Copiar el JSONL; si no, cambiar de cuenta con handoff |
| 4 | PTY elevado alojado por proceso auxiliar y named pipe | Entrada, salida y resize funcionan | Relanzar el cliente completo como administrador |
| 5 | `claude "<bloque>"` ejecuta `/frugal` con un bloque de varias líneas | Skill cargada con sus argumentos | Pegar el bloque en el PTY |
| 6 | `statusLine` por `--settings`, encadenando la status line del usuario | Datos de límites y contexto recibidos | Contexto desde JSONL y límites solo con `/usage` |
| 7 | `/usage` en PTY oculto con otra cuenta | Datos legibles sin gastar tokens | Mostrar solo la última lectura |
| 8 | Calidad de Whisper en español, y `/voice` dentro del PTY | Transcripción usable | Otro modelo de Whisper |
| 9 | Efecto de `--exclude-dynamic-system-prompt-sections` en el caché del arranque | Medición registrada | No usar el flag |

### Resultados de la Fase 0

**Prueba 1: superada** (2026-11-08, `spikes/01-tui`). Electron 45.2.3, node-pty 1.1.0 con sus binarios precompilados, sin recompilar, y `@xterm/xterm` 6.0.0 con el renderizador por defecto. No hizo falta WebGL.

- Sesión real de 15 MB reanudada con `--resume`: colores correctos, rueda del ratón funcional y sin corrupción tras 90 pasos de redimensionado a 16 ms.
- Límite: el arrastre se simuló con `setSize`. Falta un arrastre manual con el ratón.

Hallazgos para la Fase 1:

- El TUI usa la pantalla alternativa. La rueda la gestiona Claude, y `term.scrollLines` no sirve para desplazar el historial.
- Las pantallas en el búfer normal, como el diálogo de confianza, dejan restos en el scrollback con cada resize: unas 40 líneas en un arrastre. No se probó el debounce en ese caso. Con 150 ms no hubo diferencia visible en la pantalla alternativa.
- El diálogo de confianza puede aparecer y debe mostrarse sin aceptarlo automáticamente. Apareció en `Downloads`, guardada en `.claude.json` con barras invertidas, y no en `frugal-plugin`, guardada con barras normales. La causa no está confirmada.
- `NO_COLOR` heredado apaga los colores del TUI.
- Abrir con `--resume` sin enviar nada añadió entre 604 y 706 bytes al JSONL, así que reanudar modifica el archivo. El índice incremental debe tenerlo en cuenta.
- `p.kill()` seguido de `app.quit()` no cerró la aplicación en 80 s con el diálogo abierto. `p.kill()` y `app.exit(0)` un segundo después cerró sin procesos huérfanos.

**Prueba 2: superada con una condición** (2026-11-08, `spikes/02-paste`). Pegado con `term.paste` en una sesión nueva, con un mensaje enviado y comprobado en el JSONL.

- Las tres rutas de imagen generaron `[Image #1]`, `[Image #2]` y `[Image #3]` en su sitio y con el orden correcto: sin espacios, con espacios y con espacios entre comillas.
- `@"ruta con espacios"` adjuntó el archivo. `@ruta con espacios` sin comillas conservó el texto, pero no adjuntó nada y no dio error visible en el mensaje guardado.
- En el JSONL el texto va primero con los marcadores, y las imágenes van después como bloques separados, en el mismo orden.

**Prueba 3: superada con `-p`, pendiente en el TUI** (2026-11-08, `spikes/03-resume`). Las junctions fueron aditivas y se retiraron al terminar.

- `claude-sm` reanudó con `-p`, sin login nuevo, una sesión creada por la cuenta principal a través de una junction en `projects/<proyecto>`. Recordó la clave de la sesión, y el JSONL registra dos organizaciones distintas.
- También reanudó sin error una copia de una sesión con bloques `thinking` firmados (`claude-opus-5`). Esa copia no registra la organización original; se asume la principal porque estaba en `~/.claude`.
- Una skill enlazada por junction en `skills/` apareció en el listado. Con `plugins` enlazado por junction y `settings.json` copiado, `claude plugin list` salió idéntico (22 líneas, 0 diferencias), en una carpeta de configuración sin login.

No verificado:

- **TUI con la otra cuenta.** `claude-sm` tiene credenciales y `claude auth status` da `loggedIn: true`, pero no tiene `hasCompletedOnboarding`. El TUI mostró el selector de tema y después "Select login method". No se continuó. Falta saber si, completado ese asistente una vez, entra sin login. La Fase 3 debe resolverlo en "Agregar cuenta".
- **Junction de la carpeta `projects` completa.** Se probó por proyecto, para no reemplazar la carpeta real de una cuenta en uso. Migrar los proyectos existentes de cada cuenta queda como trabajo de la Fase 3.
- **Plugins cargados en una sesión.** Solo se comprobó el listado.
- **Confianza por cuenta.** Cada cuenta tiene su `.claude.json` y `claude-sm` no tiene ninguna carpeta de confianza, así que cabe esperar el diálogo en cada carpeta nueva. No llegó a mostrarse.

**Prueba 4: superada** (2026-11-08, `spikes/04-elevated`). Node sin privilegios abre el pipe y un auxiliar elevado por UAC se conecta y aloja un PTY con ConPTY.

- Pasaron los 8 controles: auxiliar y PTY elevados (`net session`), salida, entrada, resize a 132 columnas (`[Console]::WindowWidth`), variables enviadas por el pipe, `claude.cmd --version`, salida del proceso hijo y cierre del auxiliar sin procesos restantes.
- Sin UAC, los mismos controles detectan que no hay elevación, así que el control distingue ambos casos.

Hallazgos para la Fase 4:

- El servidor del pipe es el proceso sin privilegios y el auxiliar elevado es el cliente. No se probó el sentido contrario; se evitó porque el DACL por defecto de un pipe creado por un proceso elevado no debería dar escritura a uno normal.
- El nombre del pipe y el token viajan como argumentos del auxiliar. El servidor valida el token, pero el auxiliar aún no autentica al servidor. El producto necesita autenticación mutua, porque un proceso del mismo usuario podría crear otra instancia del pipe.
- El auxiliar debe instalarse donde un usuario sin privilegios no pueda escribir. Si no, se podría sustituir antes de la elevación.
- El proceso elevado no hereda el entorno del cliente: Deck debe enviar `CLAUDE_CONFIG_DIR` y demás variables en el mensaje de inicio.

No verificado: el TUI de `claude` elevado y su resize dentro de xterm.js. Solo se ejecutó `claude.cmd --version`, para no correr hooks ni plugins con privilegios de administrador.

**Prueba 5: superada lanzando el binario directamente** (2026-11-08, `spikes/05-prompt`). Bloque `/frugal code` de 5 líneas como argumento posicional, comprobado en el JSONL.

- Directo a `claude.exe`: la skill se cargó con todos sus argumentos y saltos de línea, y siguió las instrucciones del bloque.
- Por `cmd.exe /c claude`: la skill se cargó solo con `code`. `cmd.exe` corta en el primer salto de línea, se pierde el resto sin ningún error.
- Deck no debe lanzar `claude` por el shim `.cmd`. En la instalación npm el binario está en `node_modules/@anthropic-ai/claude-code/bin/claude.exe`. Otras formas de instalación no se comprobaron, y la Fase 1 necesita resolver esa ruta.

**Prueba 6: superada, con el encadenado simulado** (2026-11-08, `spikes/06-statusline`). `statusLine` como JSON en `--settings`, lanzando `claude.exe` directo con Haiku, en `frugal-plugin`.

- La status line recibe por stdin `context_window` (`used_percentage`, `context_window_size`, `current_usage` con los tokens de caché), `rate_limits` (`five_hour` y `seven_day`, cada uno con `used_percentage` y `resets_at`), `cost`, `session_id` y `transcript_path`.
- En 3 invocaciones: la primera sin `rate_limits` y sin porcentaje de contexto, la segunda con `rate_limits` y `used_percentage: null`, y la tercera, tras la respuesta, con ambos. Deck debe aceptar esos campos vacíos o ausentes.
- Encadenado: un script guarda el JSON, pasa el mismo stdin a otro comando y devuelve su salida. Esa salida apareció en el TUI.

No verificado:

- **Una status line real del usuario.** `~/.claude/settings*.json` no define `statusLine`, y se encadenó un script de prueba. Deck tendrá que leer el comando del usuario de sus ajustes, teniendo en cuenta la precedencia.
- **Carpeta sin confianza y otra cuenta.** Solo se probó en `frugal-plugin` con la cuenta de `~/.claude`.

**Prueba 7: superada con `-p`; en PTY solo con la cuenta principal** (2026-11-08, `spikes/07-usage`).

- Cuenta de `~/.claude` en PTY oculto: `claude "/usage"` abre el panel con sesión y semana (`0% used`, `91% used`) y sus reinicios. Mostró `Total cost: $0.0000` y no creó JSONL.
- `claude-sm` en PTY: se queda en el selector de tema del onboarding y no llega a `/usage`.
- `claude -p /usage --no-session-persistence --output-format json`: funciona sin PTY y sin onboarding, con `total_cost_usd: 0` y 0 tokens en `usage`. Con `claude-sm` devolvió las líneas de sesión y semana en 2 de 2 ejecuciones. Con la cuenta principal, en 2 de 2 devolvió el desglose sin esas líneas. La causa no está confirmada; el panel del PTY avisó de un límite de peticiones en el desglose por modelo.
- `-p` evita el onboarding y limpiar secuencias ANSI, pero no garantiza los porcentajes. Hay que extraerlos del texto, porque no vienen como campos, y si faltan mostrar la última lectura, que es la alternativa prevista en la tabla.

No verificado: que los porcentajes de `claude-sm` sean los de su organización. `claude auth status` da correo y `orgId` distintos, pero las dos cuentas mostraron cifras casi iguales (91% y 92% semanal) y los mismos reinicios. La Fase 3 debe confirmarlo antes de mostrar límites por cuenta.

**Prueba 8: Whisper usable en español general con edición posterior; `/voice` sin probar** (2026-11-08, `spikes/08-whisper`). `whisper-cli` del build b5454, CPU sin GPU, con una muestra de 35 s en español grabada del micrófono con ffmpeg (media -36,7 dB, pico -19,8 dB), una sola persona y una sola toma.

- Bien: "archivo de configuración", "error en la línea 42", "mañana a las tres y media tenemos" y frases fuera del guion dichas al final.
- Mal: se perdió el inicio ("Hola, estoy probando"), "Claude" pasó a "pueda", "corrija" a "corrí que", "commit" a "comienzo", "pull request" a "por recuerdos", "presupuesto" a "su puesto", y "en Lima" desapareció.
- Español general entendible, pero no sirve para dictar instrucciones técnicas, que es el uso de Deck.
- Velocidad: 39,6 s con 4 hilos y 34,1 s con 12, para 35 s de audio. Más hilos apenas ayudan y no llega a tiempo real con holgura.
- `--prompt` con un glosario no corrigió los términos y añadió una repetición inventada al final ("E. E. E."). No usarlo sin más pruebas.

- `ggml-medium` con 12 hilos (21,6 s): acertó "revise" y "corrige", pero "Claude" pasó a "club", "commit" a "comienzo", y la transcripción se cortó tras esa frase. No mejoró a `small`.
- Volumen normalizado con `loudnorm`: peor en los dos modelos. Solo salió "La transcripción en español" y una secuencia de letras.
- Esa primera muestra no es fiable: se sale del guion y los tiempos de las pasadas truncadas no valen como velocidad.

Segunda toma, con el guion completo y una parte final improvisada, 35 s (media -36,7 dB, pico -16,1 dB), 12 hilos y sin glosario:

| Modelo | Tiempo | Aciertos | Fallos |
|---|---|---|---|
| `ggml-small` | 11,4 s | "Hola, estoy probando", "archivo de configuración", "rama principal", "Lima", "presupuesto" | "Claude" a "Klaus", "corrija" a "corregir", "línea 42" a "9.42", "commit" a "comienzo", "pull request" a "por recués" |
| `ggml-medium` | 20,8 s | Lo anterior más "línea 42" y "3 y media" | "transcripción" a "traducción", "Claude" a "Klaus", "corrija" a "corregir", "commit" a "comentario", "pull request" a "por request", y una acotación inventada al final (`*sonido de chocotón*`) |
| `ggml-large-v3` | 36,0 s | Lo anterior más "commit", "rama principal" y "3 y media" | "Claude" a "Cloud", "corrija" a "correga", "pull request" a "port request", "transcripción" a "transcripciones", y una palabra inventada al final ("¡Guau!") |

- La parte improvisada, en español general y con números, salió bien en los dos modelos.
- `ggml-large-v3` es el más claro de los tres, pero ocupa 3,1 GB y en CPU con 12 hilos tarda lo mismo que dura el audio (36,0 s para 35 s). `ggml-medium` (20,8 s, 1,53 GB) es la opción para respuesta rápida.
- Los nombres propios y los términos en inglés siguen fallando en los tres, menos "commit" en `large-v3`. Deck debe dejar el texto editable antes de enviarlo.
- El silencio final puede generar texto inventado. La Fase 5 debe recortar silencios o usar VAD.

No verificado: varias voces, otros micrófonos y `/voice` dentro del PTY, que necesita hablar en directo y activa un ajuste persistente.

**Prueba 9: medición registrada** (2026-11-08, `spikes/09-cache`). Con `claude-sm`, Haiku, `-p`, `--strict-mcp-config` y `--no-session-persistence`, en dos carpetas desechables. Una respuesta por caso, de unos 26 250 tokens de entrada.

| Ronda | Variante | Carpeta | Escritura en caché | Lectura de caché |
|---|---|---|---|---|
| 1 | Sin flag | A | 7 945 | 18 307 |
| 1 | Sin flag | B | 7 945 | 18 307 |
| 1 | Con flag | A | 4 995 | 21 239 |
| 1 | Con flag | B | 4 071 | 22 163 |
| 2 | Sin flag | A y B | 0 | 26 252 |
| 2 | Con flag | A y B | 0 | 26 234 |

- Con el flag, abrir una carpeta nueva escribe 4 071 tokens en vez de 7 945, un 49% menos. Al repetir en la misma carpeta dentro del TTL, no hay diferencia.
- Límites: una sola medición en frío por caso, siempre en el mismo orden, con parte del prefijo ya caliente desde la primera llamada. Solo se midió con `-p`, no en el TUI, y la cantidad de contexto dinámico depende de la carpeta.

**Fase 0 cerrada** (2026-11-08). Las nueve pruebas tienen resultado. Lo no verificado pasa a la fase que lo usa, en las líneas "Pendiente de la Fase 0".

## Fase 1: base

- Ventana, pestañas y selector de carpeta.
- Chat nuevo con `claude --session-id <uuid>`.
- Barra lateral con índice incremental de los JSONL, tolerante a campos desconocidos.
- Reanudar con `--resume <id>` en el `cwd` original.
- Espacios, tags, fijados, agrupación automática por proyecto y `Ctrl+Shift+K`.
- Medidor de contexto, límites de 5 horas y semana en el chat.
- Ajuste automático de la terminal con cualquier cambio de layout.
- Dirección visual con Hallmark.
- Pendiente de la Fase 0: arrastre manual con el ratón (Prueba 1), ruta de `claude.exe` en otras formas de instalación (Prueba 5), status line real del usuario y carpeta sin confianza (Prueba 6).

## Fase 2: adjuntos

- Botón, arrastrar y pegar imagen desde el portapapeles.
- Todo se inserta en el cursor del CLI, de modo que conserva el orden.
- Los archivos que no son imagen entran como `@"ruta"`, siempre entre comillas (prueba 2).

## Fase 3: cuentas y handoff

**Cuentas**
- Agregar cuenta: crear `~/.claude-<id>` y abrir `claude auth login` en la terminal.
- Selector de principal: reinicia el proceso con `--resume` y el otro `CLAUDE_CONFIG_DIR`, con Claude inactivo.
- Vista de todas las cuentas: valor en vivo, última lectura con hora y cuenta atrás, y "agotada hasta X" para Codex, Grok y OpenCode.
- Aviso al 80 % del límite. El cambio de cuenta siempre es manual.

**Roles automáticos**
- Cada sesión excluye de las secundarias a su propia cuenta principal.
- Interruptor en opciones, activado por defecto.

**Handoff**
- Vigilar el JSONL al terminar cada turno y detectar un bloque que empiece por `/frugal` y traiga `Goal:` y `Next step:`.
- Con contexto de 150k o más: cuenta atrás cancelable, con el bloque visible y editable.
- Con menos de 150k: solo el botón "Continuar en sesión nueva".
- Nueva sesión con `claude.exe --session-id <nuevo> "<bloque>"`, nunca por el shim `.cmd` (prueba 5), misma carpeta, cuenta y permisos.
- Opción "Iniciar con Frugal", por sesión o global.

**Cambios en frugal-plugin**
- `ready()` en `plugin/accounts/server.py:111`: excluir la cuenta cuyo `config_dir` coincida con el `CLAUDE_CONFIG_DIR` de la sesión.
- Omitir la línea `Usage:` del handoff dentro de Deck.
- Probar un campo `Read first:` con un máximo de 3 rutas.
- Ese repositorio tiene cambios locales sin commit, incluido `server.py`: revisarlos antes de editar.

**Pendiente de la Fase 0**
- TUI con otra cuenta, junction de `projects` completa, plugins cargados en una sesión y confianza por cuenta (Prueba 3).
- Que los porcentajes de cada cuenta sean los de su organización (Prueba 7).

## Fase 4: permisos y administrador

- Ajuste global y por sesión, apagado por defecto. Cambiar en una sesión viva la reinicia con `--resume`.
- Bypass: `--dangerously-skip-permissions`.
- Administrador: proceso auxiliar elevado, con UAC en cada sesión elevada.
- Pendiente de la Fase 0: TUI de `claude` elevado y su resize en xterm.js (Prueba 4).

**Textos de advertencia (borrador)**

- **Bypass de permisos:** Claude ejecutará comandos y modificará o borrará archivos sin pedirte confirmación. Un error o una instrucción maliciosa en un archivo o página puede causar daños sin que puedas detenerlo a tiempo. Anthropic recomienda usarlo solo en contenedores o máquinas virtuales aisladas.
- **Administrador:** Claude tendrá permisos de administrador de Windows y podrá cambiar la configuración del sistema, servicios, programas y archivos de cualquier usuario. Esos cambios pueden dejar el equipo inestable o inseguro.
- **Ambos juntos:** Claude podrá hacer cambios en todo el sistema sin ninguna confirmación. Un solo error puede dañar Windows o tus datos de forma irreversible. Requiere confirmación explícita cada vez.

## Fase 5: voz

- Desactivada por defecto. Al activarla, un aviso ofrece modelo local, Anthropic (`/voice`) o no usarla.
- Botón de micrófono.
- **Local:** captura en el cliente y whisper.cpp. Selector de modelo (`small`, `medium`, `large-v3`; tiempos en la Prueba 8) y de idioma. El modelo se descarga la primera vez, tras mostrar su tamaño.
- **Local:** recortar silencios o usar VAD antes de transcribir, porque el silencio final genera texto inventado. Sin probar; el VAD de whisper.cpp usa un modelo aparte.
- **Anthropic:** no consume tokens ni cuenta en `/usage`, y requiere una cuenta claude.ai activa, sin `ANTHROPIC_API_KEY` ni `ANTHROPIC_AUTH_TOKEN`. El aviso debe decir que el audio se envía a los servidores de Anthropic. `language` debe valer `es`, porque vacío dicta en inglés.
- **Anthropic:** sin probar en el PTY. La captura sería probablemente de `claude.exe` y no del cliente; confirmarlo antes de implementar.
- **Sin instalar nada:** el aviso menciona el dictado de Windows (`Win+H`). Sin verificar dónde procesa el audio ni cómo va con términos técnicos.
- **Más adelante:** Parakeet como otro modelo local (`parakeet-cli.exe` ya viene en el build b5454). Sin probar en español; entra en el selector solo si iguala o mejora a Whisper.
- El texto se pega en el cursor, se puede editar y no se envía solo.
- Pendiente de la Fase 0: `/voice` en el PTY, otras voces y otros micrófonos (Prueba 8).

## Fase 6: Git, cadenas y archivo

- Panel derecho colapsable: `git diff` y `git worktree list`, sin tokens.
- Opción de crear el chat en worktree con `claude -w`.
- Enviar líneas seleccionadas del diff como `@archivo:línea`.
- Vista completa de las sesiones de un chat.
- Archivar y vista de archivados con su chat de origen.
- Copia comprimida de cada sesión en `~/.frugal-deck/archive/` y restauración al reabrir.
- Notificación del sistema cuando Claude termine o pida permiso.

## Fase 7: publicación 0.1.0

- Instalador y CI.
- README con capturas y aviso de términos: uso individual, sin intermediar credenciales.
- Repositorio público en GitHub, `frugal-hq/deck`, licencia MIT.
- Sin firma de código, SmartScreen mostrará un aviso.

**La copia de archivo de la Fase 6 es obligatoria antes de publicar**, porque Claude Code borra transcripts CLI tras 30 días por defecto.

## Fuera de 0.1.0

macOS, Linux, sesiones en la nube, kanban, editores visuales, app móvil, sistema de extensiones y cambio automático de cuenta al llegar al límite.
