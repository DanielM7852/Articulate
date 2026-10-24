/**
 * Typed surface of `mouth-demo/src/mouth-demo.js` (plain JavaScript, reached through
 * the `@mouth-demo` Vite alias). Mirrors the API table in mouth-demo/README.md.
 */
declare module '@mouth-demo/src/mouth-demo.js' {
  export type MouthCueId = 'round-lips' | 'spread-lips' | 'open-jaw';
  export type MouthView = 'front' | 'side';
  export type MouthStyle = 'hologram' | 'particles' | 'porcelain' | 'hybrid' | 'solid';
  export type MouthDriver = 'auto' | 'talkinghead' | 'three';
  export type MouthAssembly = 'assembled' | 'dispersed' | 'assembling' | 'dispersing';

  export interface AssemblyOptions {
    /** Length of the transition. Defaults: 1600 for assemble, 1100 for disperse. Reduced motion uses a 300 ms crossfade. */
    durationMs?: number;
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
    /** Freeze the face, camera and choreography clock without losing state. */
    pause(): void;
    resume(): void;
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
  }

  export function createMouthDemo(container: HTMLElement, options?: MouthDemoOptions): Promise<MouthDemo>;
}
