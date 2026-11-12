# Haven API

[中文](README.md) · [English](README.en.md)

A backend for structured-model editing: manage drafts, validation, versions and publication, with a separate review flow for candidate changes. Built with NestJS and SQLite, it provides data and validation APIs for editors and automation clients.

## Features

- Models and drafts: paginated listings, creation, reads and draft updates.
- Contract validation based on Haven Kit document/editing schemas with structured results.
- Versioned publication: read versions and published documents, publish and roll back.
- Concurrency and idempotency through revision checks and publication keys.
- Candidate editing: create candidates, submit commands, inspect operations, validate or discard.
- API discovery through OpenAPI, capability endpoints and document/editing JSON Schema.

## Quick start

Node.js `>=26.13.0 <27`, pnpm `12.18.0`, and Haven Kit packages matching the dependency versions.

```sh
# Build and publish matching Haven Kit packages to your registry first.
corepack enable
cp .env.example .env
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

## Configuration

| Setting | Purpose |
| --- | --- |
| `HOST / PORT` | Defaults to `127.0.0.1:3000`. |
| `HAVEN_DATABASE` | SQLite database file; default: `./data/haven.db`. |
| `HAVEN_API_TOKEN` | Access credential required in production or when binding to a non-loopback address. |
| `@haven registry` | Connect your package registry through the project’s npm configuration. |

## Usage

After startup, inspect `GET /api/v1/health` and `/api/v1/openapi.json`. Models are under `/api/v1/models`, and candidate operations are under `/api/v1/candidates`. Clients should send the required revision and idempotency fields when saving or publishing.

## Project structure

- `src/models/` — Models, drafts and publication
- `src/candidates/` — Candidate editing
- `src/storage/` — SQLite persistence

## License

[PolyForm Noncommercial 1.0.0](LICENSE). See [LICENSE_SCOPE.md](LICENSE_SCOPE.md) for the scope of original material and third-party components, and the accompanying notices for third-party copyrights and licenses.
