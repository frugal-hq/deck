# Contribuir

## Versiones

Frugal Deck usa `MAJOR.MINOR.PATCH`, definida en `package.json` y `package-lock.json`.

- **MAJOR**: rompe la compatibilidad o cambia casi todo.
- **MINOR**: cambios grandes: varias funciones, una función considerable o una corrección grande que añade comportamiento.
- **PATCH**: añadidos pequeños y correcciones.

Subir MINOR deja PATCH en 0; subir MAJOR deja ambos en 0.

La versión solo cambia cuando se decide sacar una nueva. Terminar una fase o una función no la cambia por sí solo.

Cada cambio de versión es un commit aparte y siempre va primero, antes de los cambios de esa versión. Su mensaje es exactamente:

```
chore: bump version to <version>
```

## Commits

- Una sola línea, en formato convencional: `tipo: resumen` o `tipo(ámbito): resumen`. En inglés, en minúsculas, en imperativo, corto y sin punto final.
- Tipos: `feat`, `fix`, `perf`, `refactor`, `docs`, `style`, `test`, `build`, `ci`, `chore`.
- Sin descripción y sin `Co-Authored-By`.
- Un cambio por commit, separados por archivo o tema. Nunca un commit grande con todo.
- El commit de versión nunca lleva ámbito.
- Actualizar una dependencia: `build: update <dependencia> to <versión>`.

## Releases

[`release.yml`](.github/workflows/release.yml) se ejecuta en cada push a `main`. Si pasan las comprobaciones de `test/`, vuelve a publicar `v<versión>` con la versión de `package.json`.

Las notas listan los commits desde `chore: bump version to <versión>`, así que ese mensaje debe coincidir exactamente. Una versión con guion, como `0.2.0-beta.1`, se publica como prerelease.
