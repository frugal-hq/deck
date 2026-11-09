# Contributing

## Language

Everything in this repository is in English: code, comments, UI text, docs, assets, and commits.

## Versions

Frugal Deck uses `MAJOR.MINOR.PATCH`, set in `package.json` and `package-lock.json`.

- **MAJOR**: breaks compatibility or changes almost everything.
- **MINOR**: large changes: several features, one sizeable feature, or a large fix that adds behavior.
- **PATCH**: small additions and fixes.

Bumping MINOR resets PATCH to 0; bumping MAJOR resets both.

The version changes only when a new release is cut. Finishing a phase or a feature does not change it by itself.

Every version change is its own commit and always comes first, before that version's changes. Its message is exactly:

```
chore: bump version to <version>
```

## Commits

- One line, Conventional Commits: `type: summary` or `type(scope): summary`. Lowercase, imperative, short, no period.
- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `style`, `test`, `build`, `ci`, `chore`.
- No body and no `Co-Authored-By` trailer.
- One change per commit, split by file or concern. Never one big commit.
- The version bump commit never has a scope.
- Dependency updates: `build: update <dependency> to <version>`.

## Releases

[`release.yml`](.github/workflows/release.yml) runs on every push to `main`. If the checks in `test/` pass, it republishes `v<version>` with the version in `package.json`.

The notes list the commits since `chore: bump version to <version>`, so that message must match exactly. A version with a hyphen, such as `0.2.0-beta.1`, is published as a prerelease.
