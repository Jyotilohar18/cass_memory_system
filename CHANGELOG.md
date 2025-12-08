# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Command cheat sheet and workflow guidance in README (context → mark → reflect → doctor → export).
- Installation section covering prebuilt binaries, Bun source build, Bun global install, and troubleshooting.

### Changed
- Documentation refinements for quick start and typical usage.

### Fixed
- N/A

### Deprecated
- None

### Removed
- None

### Security
- None

## [0.1.0] - 2025-12-07

### Added
- Initial release of cass-memory.
- Commands: init, context, diary, reflect, validate, mark, audit, playbook, project.
- Advanced commands: forget, stats, doctor, top, stale, why, similar.
- Confidence decay algorithm with configurable half-life.
- Scientific validation of playbook integrity.
- Three-layer memory model (Diary → Playbook → Project).
- ACE pipeline (Generator → Reflector → Validator → Curator).
- JSON output support for all commands.
- Cross-platform binary compilation targets (macOS, Linux, Windows).

### Changed
- N/A

### Deprecated
- None

### Removed
- None

### Fixed
- N/A

### Security
- None
