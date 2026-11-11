# Changelog

All notable changes to `@jie2gg/dsh-plugin-github` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project uses [semantic versioning](https://semver.org/).

## 0.1.0

### Added

- Bundle scaffold for a plugin that will manage the local GitHub CLI:
  `package.json` with the repository's required fields, `cordis.patch.yml`
  inserting the `github` plugin row, `src/index.ts`, an original `icon.svg`,
  `locale/en.json` and `locale/zh.json` display metadata, and
  `docs/DETAIL.md` / `docs/DETAIL.zh.md` detail documents.
- TypeScript build (`pnpm run build` → `lib/`) so the manifest's `main` and
  `exports` point at real build artifacts while `lib/` stays git-ignored.

### Notes

- The plugin is inert: no agent tool, no configuration fields, no Web UI, and no
  `gh` invocation. Enabling or disabling it changes nothing in the app.
