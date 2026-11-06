<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project guidance

- Read [README.md](README.md) for project setup, batch commands, and operational constraints. Keep those instructions in README rather than duplicating them here.
- Web search must query SQLite only; do not call the YouTube API from pages or search routes.
- Discover new channels only in the channel batch. The video batch refreshes existing channel metadata and collects videos without searching for new channels. The combined batch runs both stages.
- Preserve broadcaster exclusions during channel discovery and refresh.
- Search longform and short videos together. `videos.is_short` is a duration-based Shorts candidate flag, not a confirmed YouTube classification.
- When changing the database schema, provide an upgrade path for existing databases in `scripts/database.mjs` and preserve existing data unless removal is explicitly required.
- Keep README up to date when changing setup, commands, or user-facing behavior.

## Validation

For code changes, run the relevant tests and checks:

```bash
npm test
npm run lint
npm run build
```

Batch tests use mocked API responses. Do not run live collection merely to validate a change, since it consumes API quota and modifies the local database.
