# Frugal Deck

Cliente de escritorio open source que envuelve el CLI oficial de Claude Code. Muestra la terminal real y añade alrededor lo que le falta: historial de sesiones, adjuntos fáciles, voz, varias cuentas, límites de uso y handoff automático con Frugal.

**Versión objetivo:** 0.1.0
**Estado:** en desarrollo, Fase 1 de 7.
**Plataforma de 0.1.0:** Windows 10 y 11.

## Principios

1. **La terminal es la real.** Deck ejecuta el binario oficial de Claude Code sin modificarlo, dentro de un PTY.
2. **Cero tokens añadidos.** Ninguna función puede agregar contenido al prompt, servidores MCP ni llamadas al modelo. Lo que no cumpla esto queda fuera o es opcional y apagado.
3. **Deck nunca toca credenciales.** No lee, copia ni guarda `.credentials.json` ni tokens. El login siempre es el flujo oficial dentro de la terminal.
4. **Nada se pierde.** Archivar nunca borra, y Deck conserva su propia copia de cada sesión.

## Documentos

| Archivo | Contenido |
|---|---|
| [docs/REQUISITOS.md](docs/REQUISITOS.md) | Todo lo pedido para el cliente |
| [docs/PLAN.md](docs/PLAN.md) | Plan completo de 0.1.0, por fases |
| [docs/DECISIONES.md](docs/DECISIONES.md) | Decisiones tomadas, motivos y alternativas |
| [docs/INVESTIGACION.md](docs/INVESTIGACION.md) | Datos verificados, medición de tokens, competencia y fuentes |

## Licencia

MIT (propuesta).
