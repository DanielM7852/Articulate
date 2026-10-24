/**
 * Typed surface of `mouth-demo/src/mouth-demo.js` (plain JavaScript, reached through
 * the `@mouth-demo` Vite alias). Mirrors the API table in mouth-demo/README.md.
 */
declare module '@mouth-demo/src/mouth-demo.js' {
  export type MouthCueId = 'round-lips' | 'spread-lips' | 'open-jaw';
  export type MouthView = 'front' | 'side';
  export type MouthStyle = 'hologram' | 'porcelain' | 'hybrid' | 'solid';
  export type MouthDriver = 'auto' | 'talkinghead' | 'three';

  export interface MouthDemo {
    readonly driverName: string;
    readonly style: MouthStyle;
    readonly view: MouthView;
    readonly speed: number;
    readonly cueId: MouthCueId | null;
    /** Demonstrate a cue and keep looping it. */
    showCue(id: MouthCueId): void;
    replay(): void;
    /** 0.5 for slow motion, 1 for normal speed. */
    setSpeed(speed: number): void;
    /** Animated camera swing. Resolves true when the swing finishes, false if interrupted. */
    setView(view: MouthView): Promise<boolean>;
    /** Ease back to neutral and stop looping. */
    stop(): void;
    setStyle(style: MouthStyle): void;
    /** Frees GPU resources, listeners and DOM. Safe to call twice. */
    dispose(): void;
  }

  export interface MouthDemoOptions {
    avatarUrl?: string;
    driver?: MouthDriver;
    style?: MouthStyle;
    /** false: the host renders its own controls. */
    controls?: boolean;
  }

  export function createMouthDemo(container: HTMLElement, options?: MouthDemoOptions): Promise<MouthDemo>;
}
