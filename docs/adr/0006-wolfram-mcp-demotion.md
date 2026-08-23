# ADR-0006: Wolfram MCP is optional/experimental, not a source of truth

- **Status:** Accepted (follow-up complete — manager removed)
- **Date:** 2026-07 (updated 2026-08)

## Context

`src/mcp-manager.ts` (`WolframMCPManager`) and `src/fallback-physics.ts` were built to let the app query Wolfram Alpha via MCP for "authoritative" physics values, with a local fallback when disconnected. `SEGIntegrationManager` (`src/integration.ts`) instantiated `WolframMCPManager` unconditionally and is itself constructed on every WebGPU visualizer init (`src/multi-device-visualizer.ts`) — but purely to own the typed physics GPU uniform buffer, not for Wolfram specifically.

In practice:

- This is a static site with **no backend**. `WolframMCPManager.connect()` was never called anywhere in the app, so the manager always operated in fallback mode — it never made a live Wolfram query in production.
- The actual authoritative constants source is `physics/constants.json` → codegen → `ValidatedConstants.ts` (see ADR-0002 and `docs/AGENTS.md` language strategy). Wolfram was never wired as the real source of truth; the fallback values *are* the values in use.
- Docs and code comments implied "live Wolfram" integration that did not exist at runtime, which misled contributors and agents.

## Decision

1. Wolfram MCP is **optional/experimental** and explicitly **not on the critical path**. `ValidatedConstants` + codegen remain the single authoritative source of physics constants.
2. **Follow-up (Wave 5):** `WolframMCPManager` and `src/mcp-manager.ts` were **deleted**. `SEGIntegrationManager` no longer constructs or re-exports an MCP manager. Bundle no longer pays for unused MCP cache/retry machinery on the default path.
3. `UncertaintyFlag.source: 'wolfram'` remains only as an **offline provenance tag** (constants validated during development), not a claim of live MCP.
4. If a live MCP connection is ever wired up later, it must be a new opt-in design (e.g. `?wolfram=1`) and must never become an authoritative source for values already covered by `ValidatedConstants`.
5. Documentation must not describe Wolfram MCP as a live/authoritative integration.

## Consequences

- **Positive:** Default WebGPU boot is free of dead MCP surface; `ValidatedConstants` is unambiguous as the source of truth.
- **Neutral:** Scientific-ui / debug-panel Wolfram status chrome may still exist as inert UI; it does not import a manager.
- **Neutral:** `SEGIntegrationManager` remains the typed physics uniform buffer owner.

## Related

- ADR-0002 (WASM RK4 plant / constants provenance), `physics/constants.json`, `src/ValidatedConstants.ts`, `src/integration.ts`
