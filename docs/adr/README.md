# Architecture Decision Records

Lightweight ADRs for the SEG WebGPU Visualizer. Each file is a short record of a durable choice and its consequences.

| ID | Title |
|----|--------|
| [0001](./0001-dual-renderer.md) | Dual renderer: WebGPU primary, WebGL2 opt-in (no auto-fallback) |
| [0002](./0002-wasm-rk4-plant.md) | Optional C++/WASM RK4 plant beside GPU particles |
| [0003](./0003-no-threejs.md) | Custom WebGPU/WebGL2 stack, no Three.js |
| [0004](./0004-energy-network.md) | Multi-device energy network (visual pipes → physical coupling) |
| [0005](./0005-showroom-lab-twin-epic.md) | Showroom / Lab / Twin epic (north star) |
| [0006](./0006-wolfram-mcp-demotion.md) | Wolfram MCP is optional/experimental, not a source of truth |
| [0007](./0007-gpu-chores-exclusive-session.md) | gpu-chores exclusive session (no third GPU device) |
| [0008](./0008-device-catalog.md) | Device identity catalog (`shaderMode` vs `wasmMode`) |
| [0009](./0009-lab-session-host.md) | LabSession host: one plant, two GPU backends |
| [0010](./0010-fdtd-slice.md) | 2D FDTD wave slice (not FEM) |
| [0011](./0011-field-coupling.md) | Lab field coupling (optional cross-device B) |
| [0012](./0012-fdtd-materials.md) | FDTD material cells (μ_r / σ), still 2D, still not FEM |

Status values: **Accepted** · **Superseded** · **Proposed**
