/**
 * Scene graph for loaded glTF assets — transform hierarchy, visibility, anchor baking.
 * Builds formal {@link SceneNode} trees (ADR-0005).
 */
import { SceneNode, type SceneAnchor, type SceneAnnotation } from '../scene/scene-node';
import type { ExtractedGltf, ExtractedMesh, ExtractedNode } from './gltf-loader';

export interface BuildGltfSceneOpts {
  propId?: string | null;
}

export interface GltfSceneResult {
  roots: GltfSceneNode[];
  nodeByIndex: GltfSceneNode[];
  anchors: SceneAnchor[];
  annotations: SceneAnnotation[];
  propId: string | null;
}

export function buildGltfScene(extracted: ExtractedGltf, opts: BuildGltfSceneOpts = {}): GltfSceneResult {
  const { meshes, nodes, scenes, scene } = extracted;
  const propId = opts.propId ?? null;
  const nodeByIndex = nodes.map((n) => new GltfSceneNode(n, meshes, { propId }));

  for (const n of nodeByIndex) {
    for (const childIdx of (n.source as ExtractedNode).children) {
      const child = nodeByIndex[childIdx];
      if (child) {
        n.children.push(child);
        child.parent = n;
      }
    }
  }

  const rootIndices = scenes[scene]?.nodes ?? [0];
  const roots = rootIndices.map((i) => nodeByIndex[i]).filter(Boolean);

  const anchors: SceneAnchor[] = [];
  const annotations: SceneAnnotation[] = [];
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
  constructor(source: ExtractedNode, meshes: ExtractedMesh[], opts: BuildGltfSceneOpts = {}) {
    const extras = (source.extras || {}) as { annotationId?: string; power_gen?: { materialRingIndex?: number; role?: string } };
    const ringIndex = extras.power_gen?.materialRingIndex ?? 11.0;
    super({
      name: source.name,
      translation: source.translation as [number, number, number],
      rotation: source.rotation as [number, number, number, number],
      scale: source.scale as [number, number, number],
      meshPrimitives: null,
      material: { ringIndex },
      extras: source.extras || {},
      annotationId: extras.annotationId || null,
      role: extras.power_gen?.role ?? null,
      propId: opts.propId ?? null,
      source
    });

    if (source.mesh != null && meshes[source.mesh]) {
      this.meshPrimitives = meshes[source.mesh].primitives;
    }
  }
}

export { SceneNode };
