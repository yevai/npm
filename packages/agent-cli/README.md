# agent-cli

Experimental. Yet another CLI for language models.

## Design Principles

1. Fast (This means we use https://www.npmjs.com/package/cac)
2. Minimal
3. Non-prescriptive

## Requirements

### Python

Should use uv and/or whatever is on the systemn automatically.

### TypeScript

Should attempt deno if exists, otherwise bun, otherwise Node22+ with type stripping, falling back to --experimental-transform-types

## Functionality

*Extremely* basic config: memory driver, env driver, fs driver. Minimal use case:

- Can use a mix of repo-shared KV pairs and worktree/agent/shell local KV pairs.