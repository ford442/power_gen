/**
 * Scene graph for loaded glTF assets — transform hierarchy, visibility, anchor baking.
 * Builds formal {@link SceneNode} trees (ADR-0005).
 */
import { SceneNode } from '../scene/scene-node.js';

/** @typedef {import('../scene/scene-node.js').SceneAnchor} GltfAnchor */
/** @typedef {import('../scene/scene-node.js').SceneAnnotation} GltfAnnotation */

/**
 * @param {ReturnType<import('./gltf-loader.js').extractGltfMeshes>} extracted
 * @param {{ propId?: string|null }} [opts]
 */
export function buildGltfScene(extracted, opts = {}) {
  const { meshes, nodes, scenes, scene } = extracted;
  const propId = opts.propId ?? null;
  const nodeByIndex = nodes.map((n) => new GltfSceneNode(n, meshes, { propId }));

  for (const n of nodeByIndex) {
    for (const childIdx of n.source.children) {
      const child = nodeByIndex[childIdx];
      if (child) {
        n.children.push(child);
        child.parent = n;
      }
    }
  }

  const rootIndices = scenes[scene]?.nodes ?? [0];
  const roots = rootIndices.map((i) => nodeByIndex[i]).filter(Boolean);

  /** @type {GltfAnchor[]} */
  const anchors = [];
  /** @type {GltfAnnotation[]} */
  const annotations = [];
  for (const root of roots) {
    root.updateWorldTransform();
    anchors.push(...root.collectAnchors());
    annotations.push(...root.collectAnnotations());
  }

  return { roots, nodeByIndex, anchors, annotations, propId };
}

/**
 * glTF-backed scene node — extends formal SceneNode with source mesh wiring.
 */
export class GltfSceneNode extends SceneNode {
  /**
   * @param {object} source
   * @param {object[]} meshes
   * @param {{ propId?: string|null }} [opts]
   */
  constructor(source, meshes, opts = {}) {
    const ringIndex = source.extras?.power_gen?.materialRingIndex ?? 11.0;
    super({
      name: source.name,
      translation: source.translation,
      rotation: source.rotation,
      scale: source.scale,
      meshPrimitives: null,
      material: { ringIndex },
      extras: source.extras || {},
      annotationId: source.extras?.annotationId || null,
      role: source.extras?.power_gen?.role ?? null,
      propId: opts.propId ?? null,
      source
    });

    if (source.mesh != null && meshes[source.mesh]) {
      this.meshPrimitives = meshes[source.mesh].primitives;
    }
  }
}

export { SceneNode };
