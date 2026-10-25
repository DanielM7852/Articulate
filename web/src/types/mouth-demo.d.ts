/**
 * Typed surface of `mouth-demo/src/mouth-demo.js` (plain JavaScript, reached through
 * the `@mouth-demo` Vite alias). Mirrors the API table in mouth-demo/README.md.
 */
declare module '@mouth-demo/src/mouth-demo.js' {
  import type { QualityTier } from '@mouth-demo/src/quality.js';
  export type { QualityTier };
  /** A rung of the runtime quality ladder: the tier, or a step within the full tier. */
  export type QualityLevel = 'full' | 'full-dpr' | 'full-dots' | 'light' | 'simple';

  /** Detail of the 'quality:change' event and the onQualityChange callback. */
  export interface QualityChange {
    tier: QualityTier;
    level: QualityLevel;
    /** Average fps that triggered an automatic step; null otherwise. */
    fps: number | null;
    /** e.g. 'initial', 'url', 'user', 'auto', 'fps-low', 'fps-high', 'fps-fallback', '3d-failed', or a detection reason. */
    reason: string;
    /** Whether the frame-rate monitor may step the tier. */
    adaptive: boolean;
  }

  export type MouthCueId = 'round-lips' | 'spread-lips' | 'open-jaw';
  export type MouthView = 'front' | 'side';
  export type MouthStyle = 'hologram' | 'particles' | 'porcelain' | 'hybrid' | 'solid';
  export type MouthDriver = 'auto' | 'talkinghead' | 'three';
  export type MouthAssembly = 'assembled' | 'dispersed' | 'assembling' | 'dispersing';

  export interface AssemblyOptions {
    /** Length of the transition. Defaults: 1600 for assemble, 1100 for disperse. Reduced motion uses a 300 ms crossfade. */
    durationMs?: number;
  }

  /** A picture drawn in dots that the particle head starts from (see MouthDemo.setStartShape). */
  export interface StartShape {
    /** xyz per sample, in camera space (the picture's plane in front of the camera). Any count. */
    points: Float32Array;
    /** 0..1 per sample, 1 darkest (darker samples carry more dots, drawn darker and larger). Default 1. */
    shade?: Float32Array;
    /** Metres between samples: each sample's dots are spread over a cell this wide. */
    jitter?: number;
    /** The picture's area in m² (default: samples x jitter²); sets the dot radius for an even coverage. */
    area?: number;
    /** Dot radius on the picture, metres; overrides the one derived from `area`. */
    dotRadius?: number;
  }

  export interface StartShapeImageOptions {
    /** Image URL; its pixels darker than `threshold` become the dots. */
    src: string;
    /** Where the image sits, in CSS px relative to the demo's canvas host. */
    box: { x: number; y: number; width: number; height: number };
    /** How the image fills the box, like CSS object-fit. Default 'fill'. */
    fit?: 'fill' | 'cover' | 'contain';
    /** CSS px between samples. Default 1.6. */
    spacing?: number;
    /** Luminance (0..1, composited over cream) below which a pixel is part of the shape. Default 0.55. */
    threshold?: number;
  }

  /** Timestamps in seconds from the start of the speech audio (e.g. from Cartesia). */
  export interface SpeechTimeline {
    phonemes?: { p: string; start: number; end: number }[];
    words?: { text: string; start: number; end: number }[];
  }

  export interface SpeechHandle {
    /** More timestamps arrived. */
    append(t: SpeechTimeline): void;
    /** No more data; the mouth relaxes after the last timed item. */
    end(): void;
    /** Release immediately (eases to rest). */
    stop(): void;
  }

  export interface SpeakOptions {
    /** Seconds since the speech audio started; negative means not started yet. */
    clock: () => number;
    timeline?: SpeechTimeline;
  }

  export interface MouthDemo {
    readonly driverName: string;
    readonly style: MouthStyle;
    readonly view: MouthView;
    readonly speed: number;
    readonly cueId: MouthCueId | null;
    /** True from speak() until the speech ends or is stopped. */
    readonly speaking: boolean;
    /** Where the particle head is in its intro / outro. */
    readonly assembly: MouthAssembly;
    /** True only when the head is fully assembled (pointer scatter works only then). */
    readonly assembled: boolean;
    /** Demonstrate a cue and keep looping it. */
    showCue(id: MouthCueId): void;
    /**
     * Lip sync against an external audio clock. Replaces any speech in progress. A cue owns the mouth:
     * while a cue is chosen (or still easing out) speech writes nothing. Dispatches 'speech:start' (first
     * non-negative clock reading) and 'speech:end' on the container.
     */
    speak(opts: SpeakOptions): SpeechHandle;
    replay(): void;
    /** 0.5 for slow motion, 1 for normal speed. */
    setSpeed(speed: number): void;
    /** Animated camera swing. Resolves true when the swing finishes, false if interrupted. */
    setView(view: MouthView): Promise<boolean>;
    /** Ease back to neutral and stop looping. */
    stop(): void;
    setStyle(style: MouthStyle): void;
    /** Turn the head toward a point in front of the screen. x: -1 left to +1 right, y: -1 down to +1 up. Null releases it. */
    lookAt(target: { x: number; y: number } | null): void;
    /** Camera distance multiplier, eased. 1 is the default framing; 0.8 is closer. */
    setZoom(zoom: number): void;
    /**
     * Particles style: the dots fly in from around the stage and build the head. Resolves true when
     * assembled, false if disperse() interrupts it. Other styles settle the state and resolve at once.
     */
    assemble(opts?: AssemblyOptions): Promise<boolean>;
    /** Particles style: the head dissolves (dots drift outward and up and fade). Resolves false if interrupted. */
    disperse(opts?: AssemblyOptions): Promise<boolean>;
    /** True while a start shape is set. */
    readonly hasStartShape: boolean;
    /**
     * Particles style: while dispersed the dots draw this picture, and assemble() morphs each dot from its
     * spot on it to its spot on the head. Null restores the default fly-in (after a morph in progress).
     * Returns true when the picture is on stage.
     */
    setStartShape(shape: StartShape | null): boolean;
    /** setStartShape from an image laid out in a box on the canvas. Resolves true when the picture is on stage. */
    setStartShapeFromImage(opts: StartShapeImageOptions): Promise<boolean>;
    /** Wash the stage backdrop toward a flat CSS colour; null returns to the default gradient. */
    setBackdrop(color: string | null, opts?: { durationMs?: number }): void;
    /** Freeze the face, camera and choreography clock without losing state. */
    pause(): void;
    resume(): void;
    /**
     * Switch quality tier. `adaptive: false` pins it; otherwise the frame-rate monitor may step it down (and
     * back up one rung). Builds the 3D stack on the way up from 'simple'; resolves once applied. Fires
     * 'quality:change' (and onQualityChange).
     */
    setQuality(tier: QualityTier, opts?: { adaptive?: boolean; reason?: string }): Promise<void>;
    /** The tier drawn now (after any automatic step). */
    getQuality(): QualityTier;
    readonly qualityLevel: QualityLevel;
    /** Frees GPU resources, listeners and DOM. Safe to call twice. */
    dispose(): void;
  }

  export interface MouthDemoOptions {
    avatarUrl?: string;
    driver?: MouthDriver;
    style?: MouthStyle;
    /** false: the host renders its own controls. */
    controls?: boolean;
    /** Start with the particle head dispersed (empty stage) until assemble() is called. Default false. */
    startDispersed?: boolean;
    /** Starting tier (`?quality=` on the URL wins). 'simple' builds no 3D at all. Default 'full'. */
    quality?: QualityTier;
    /** false pins the tier (no automatic steps). Default true. */
    adaptive?: boolean;
    /** Reason reported with the first 'quality:change'. */
    qualityReason?: string;
    /** Picture shown in the head's place in the simple tier. */
    posterUrl?: string;
    onQualityChange?: (change: QualityChange) => void;
  }

  export function createMouthDemo(container: HTMLElement, options?: MouthDemoOptions): Promise<MouthDemo>;
}

/** Typed surface of `mouth-demo/src/quality.js`: tier detection and the frame-rate monitor. */
declare module '@mouth-demo/src/quality.js' {
  export type QualityTier = 'full' | 'light' | 'simple';
  export const TIERS: QualityTier[];
  export const STORAGE_KEY: string;

  export interface TierDetection {
    tier: QualityTier;
    /** e.g. 'no-webgl', 'software-renderer', 'performance-caveat', 'gpu-tier-1', 'mobile', 'cores-4', 'detect-error'. */
    reason: string;
    /** detect-gpu tier 0..3, null when unknown. */
    gpuTier: number | null;
    renderer: string;
    isMobile: boolean;
    software: boolean;
  }

  export interface TierDecision extends TierDetection {
    source: 'url' | 'user' | 'detected';
    /** The hardware's own tier (what "auto" means). */
    detected: QualityTier;
  }

  export interface DetectOptions {
    /** Where detect-gpu's benchmark JSON is served (default: unpkg). */
    benchmarksURL?: string;
  }

  export function urlParams(): URLSearchParams;
  export function readUrlQuality(): QualityTier | null;
  export function readStoredQuality(): QualityTier | null;
  export function storeQuality(tier: QualityTier | null): void;
  export function detectHardwareTier(opts?: DetectOptions): Promise<TierDetection>;
  export function detectTier(opts?: DetectOptions): Promise<TierDecision>;

  export interface FpsMonitor {
    tick(now?: number): void;
    reset(): void;
    restart(): void;
    readonly fps: number;
    readonly stopped: boolean;
    dispose(): void;
  }

  export function createFpsMonitor(opts?: {
    onDown?: (e: { fps: number; fallback: boolean }) => void;
    onUp?: (e: { fps: number }) => void;
    onSample?: (fps: number, avg: number) => void;
    bounds?: [number, number];
    sampleMs?: number;
    samples?: number;
    threshold?: number;
    maxFlipflops?: number;
    settleMs?: number;
    fpsOverride?: (() => number | null | undefined) | null;
  }): FpsMonitor;
}
