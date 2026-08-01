# ADR-0006: Wolfram MCP is optional/experimental, not a source of truth

- **Status:** Accepted
- **Date:** 2026-07

## Context

`src/mcp-manager.ts` (`WolframMCPManager`) and `src/fallback-physics.ts` were built to let the app query Wolfram Alpha via MCP for "authoritative" physics values, with a local fallback when disconnected. `SEGIntegrationManager` (`src/integration.ts`) instantiates `WolframMCPManager` unconditionally and is itself constructed on every WebGPU visualizer init (`src/multi-device-visualizer.js`) — but purely to own the typed physics GPU uniform buffer, not for Wolfram specifically.

In practice:

- This is a static site with **no backend**. `WolframMCPManager.connect()` is never called anywhere in the app, so the manager always operates in fallback mode — it has never made a live Wolfram query in production.
- The actual authoritative constants source is `physics/constants.json` → codegen → `ValidatedConstants.ts` (see ADR-0002 and `docs/AGENTS.md` language strategy). Wolfram was never wired as the real source of truth; the fallback values *are* the values in use.
- Docs and code comments imply "live Wolfram" integration that does not exist at runtime, which misleads contributors and agents.

## Decision

1. Wolfram MCP is **optional/experimental** and explicitly **not on the critical path**. `ValidatedConstants` + codegen remain the single authoritative source of physics constants.
2. No code removal in this pass — `WolframMCPManager` is already inert at runtime (fallback-only, `connect()` never invoked), so there is no live behavior to gate behind a flag today. If a live MCP connection is wired up later, it must be opt-in (e.g. `?wolfram=1`) and must never become an authoritative source for values already covered by `ValidatedConstants`.
3. Documentation (`src/mcp-manager.ts` header, `grok.md`, `claude.md`) must not describe Wolfram MCP as a live/authoritative integration.

## Consequences

- **Positive:** Removes a misleading "live Wolfram" claim from docs without a risky runtime change; keeps `ValidatedConstants` as the unambiguous source of truth.
- **Negative:** `WolframMCPManager` remains ~350 LOC of effectively dead-weight bundle surface. Follow-up (not in this ADR): either delete it, or actually wire `connect()` behind `?wolfram=1` if a real Wolfram MCP backend becomes available.
- **Neutral:** `SEGIntegrationManager` stays as-is (typed physics uniform buffer owner); only its Wolfram sub-component is demoted.

## Related

- ADR-0002 (WASM RK4 plant / constants provenance), `physics/constants.json`, `src/ValidatedConstants.ts`, `src/mcp-manager.ts`, `src/integration.ts`
