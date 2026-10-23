# Summon-Fixer-

A project-local, Codex-powered development companion that bridges live web applications with intelligent local workspace code modification.

## Monorepo Structure

- [packages/contracts/](packages/contracts/): Shared contract schemas, TypeScript types, and validation helpers.
- [apps/](apps/): Application harnesses and demo hosts (Phase 2).
- [AGENTS.md](AGENTS.md): Architecture, ownership boundaries, permission model, and operating guidelines.
- [CLAUDE.md](CLAUDE.md): Agent operating instructions and execution constraints.

## Prerequisites

- **Node.js**: `>= 24.0.0`
- **npm**: `>= 10.0.0`

## Setup & Getting Started

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Build all packages**:
   ```bash
   npm run build
   ```

3. **Run TypeScript typechecks**:
   ```bash
   npm run typecheck
   ```

4. **Run unit tests**:
   ```bash
   npm run test
   ```

5. **Clean build artifacts**:
   ```bash
   npm run clean
   ```

## Development Roadmap

- **Phase 1A (Current)**: Minimal npm-workspaces foundation and shared contracts package (`@summon-fixer/contracts`).
- **Phase 1B**: Local Codex runner engine and diff generator.
- **Phase 2**: Browser dev overlay and Vite injection plugin.
