# Storage architecture

The engine repository contains code and system procedures. Personal records and prose live in Neon. Original files live in private R2 storage. Personal content never belongs in a commit, PR, review comment or workflow log.

Use `node .agents/scripts/pages.ts list`, `read <slug>` and `search <text>` to discover context. Page types group people, topics, sources, answers, projects, areas, daily and weekly notes. `edit <slug>` creates a scratch copy outside git; `save <slug>` records a revision. `write` reads a body from stdin. `delete` soft-deletes a page. Query members and relationships for household details. Use files.ts for original files and provenance.

The local scripts and Worker share packages/core queries. The Worker uses Hyperdrive for Neon, private R2 for files, and OAuth for client access. OWNER is a Worker var; set PUBLIC_ORIGIN as a Worker and Actions secret; smoke checks use PUBLIC_ORIGIN from the environment. Cloudflare resource identifiers remain deployment configuration.

Build status lives on the Builds board in bookout-labs/life-ai-engine. Fresh public history must contain only the reviewed engine tree, never the private repository history.
