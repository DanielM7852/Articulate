/**
 * Typed surface of `mouth-demo/src/pointcloud-material.js` (plain JavaScript, reached through the `@mouth-demo`
 * Vite alias): the point material of Ava's dot head, shared with the dashboard's learner face (faceCloud.ts).
 */
declare module '@mouth-demo/src/pointcloud-material.js' {
  import type { ShaderMaterial } from 'three';

  export const COLOR_NAVY: string;
  export const COLOR_HALO: string;
  export const COLOR_GREY: string;
  /** radius in metres; minPx, maxPx in device px */
  export const DOT: { radius: number; mouthSwell: number; holdSwell: number; rimSwell: number; minPx: number; maxPx: number };
  /** aInfo.y per dot */
  export const KIND: { head: number; hair: number; eyes: number; teeth: number };
  /** aInfo.x per mesh class */
  export const SIZE_MUL: { full: number; hair: number; eyes: number; teeth: number };
  export const HAIR_TONE: { base: number; spec: number };
  export const TEETH_TONE: { navyMix: number; spec: number };
  export const LIGHT: { sizeShadow: number; sizeLit: number; shadeShadow: number; shadeLit: number };
  export const VERT: string;
  export const FRAG: string;

  /**
   * The cloud's ShaderMaterial. Geometry attributes: position, aNormal (vec3), aInfo (vec4: size multiplier, kind,
   * mouth weight, alpha), aFly (vec4: fly-in start, random phase), aShape (vec2). Uniforms live on
   * `material.uniforms` (uProj: device px per world unit at distance 1, uDpr, uRadius, ...).
   */
  export function createPointMaterial(opts?: {
    radius?: number;
    center?: { x: number; y: number; z: number };
    yRange?: [number, number];
  }): ShaderMaterial;
}
