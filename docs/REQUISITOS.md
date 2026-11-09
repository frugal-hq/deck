# Requisitos de Frugal Deck 0.1.0

## Terminal y chat

- Cada chat nuevo abre Claude Code automáticamente, listo para escribir, sin teclear `claude`.
- Se ve solo la pantalla de la terminal, sin la ventana completa de consola.
- La terminal se ajusta sola al cambiar el tamaño de la ventana, de la barra lateral o de cualquier panel.

## Adjuntos

- Adjuntar archivos sin copiar rutas a mano: botón, arrastrar y pegar desde el portapapeles.
- Se mantiene el orden del CLI: adjunto, texto, otro adjunto, en cadena. Ejemplo: `[Image #3] mi jefe dijo esto: [Image #4]`.

## Voz

- Dictar con el micrófono como alternativa al teclado.
- El texto transcrito queda en la entrada para revisarlo antes de enviar.

## Sesiones e historial

- Barra lateral izquierda con todas las sesiones e historial, sin necesidad de pedirle a Claude que las recupere.
- Después de un handoff, un chat agrupa todas sus sesiones. Con una sola sesión se ve como un chat normal.
- Con varias sesiones, un botón en el chat y en la barra lateral abre las anteriores.
- Las sesiones se pueden archivar. Lo archivado no se pierde y va a una vista aparte que indica de qué chat proviene.

## Organización

- Modelo más organizable y compacto que los grupos actuales de Claude, que ocupan demasiado espacio: tags, grupos o pestañas.

## Cuentas

- Agregar varias cuentas de Claude con login oficial, una sola vez por cuenta.
- Selector para cambiar la cuenta principal, dueña de la sesión, sin volver a iniciar sesión. Si esto exigiera volver a iniciar sesión, la función se descarta.
- Roles automáticos: la cuenta principal de la sesión es la principal y las demás cuentas de Claude pasan a ser secundarias de Frugal. Con cuentas A y B: si A es principal, B es secundaria; si B es principal, A es secundaria.
- Ese comportamiento se puede desactivar en las opciones del cliente.

## Límites y contexto

- Ver el límite de 5 horas y el semanal desde un botón en el chat, como el de la app actual.
- Un botón adicional muestra los límites de todas las cuentas anexadas.
- Medidor de contexto por sesión.

## Handoff con Frugal

- Cuando Frugal emite un handoff porque el contexto creció, Deck abre automáticamente una sesión nueva en el mismo chat, cargando ese handoff.

## Permisos

- Opción para iniciar con bypass de permisos y con acceso de administrador.
- Ambas desactivadas por defecto, activables para todas las sesiones o solo para una.
- Advertencia que explique qué implica cada una.

## Git

- Panel de diff de Git, abrible y colapsable.
- Sesiones en worktree.

## Diseño

- La UI se diseña con la skill Hallmark.

## Publicación

- Proyecto open source en GitHub.
