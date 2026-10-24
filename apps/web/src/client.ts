import type {
  Command,
  Event,
  Session,
} from "../../../packages/contracts/generated";
export type Snapshot = {
  session: Session;
  seq: number;
  attempt_id: string | null;
  generation_id: string | null;
  history: any[];
  outcomes: any[];
  decision: any;
  pending_sync: number;
  mock_mode: boolean;
  persistence: string;
  cache_keys: string[];
};
type Connection = {
  session_id: string;
  capability: string;
  events_url: string;
  audio_url: string;
  snapshot: Snapshot;
  targets: any[];
};
export class Client {
  connection?: Connection;
  events?: WebSocket;
  audio?: WebSocket;
  revision = 0;
  snapshot?: Snapshot;
  retry = 0;
  disposed = false;
  timer?: ReturnType<typeof setTimeout>;
  pending = new Map<
    string,
    {
      resolve: () => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  chain: Promise<unknown> = Promise.resolve();
  constructor(
    public onSnapshot: (snapshot: Snapshot) => void,
    public onEvent: (event: Event) => void,
    public onAudio: (message: any) => void,
    public onPcm: (data: ArrayBuffer) => void,
    public status: (text: string) => void,
    public disconnected: () => void,
  ) {}
  async connect() {
    this.disposed = false;
    const stored = sessionStorage.getItem("articulate-session-v1");
    if (stored) {
      this.connection = JSON.parse(stored);
      const response = await fetch(
        `/api/sessions/${this.connection!.session_id}/snapshot`,
        {
          headers: { Authorization: `Bearer ${this.connection!.capability}` },
        },
      );
      if (response.ok) this.connection!.snapshot = await response.json();
      else {
        sessionStorage.removeItem("articulate-session-v1");
        this.connection = undefined;
      }
    }
    if (!this.connection) {
      const response = await fetch("/api/sessions", { method: "POST" });
      if (!response.ok) throw new Error("Could not create session");
      this.connection = await response.json();
      sessionStorage.setItem(
        "articulate-session-v1",
        JSON.stringify(this.connection),
      );
    }
    const c = this.connection!;
    this.snapshot = c.snapshot;
    this.revision = c.snapshot.session.revision;
    this.onSnapshot(c.snapshot);
    const wsUrl = (path: string) =>
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
    await new Promise<void>((resolve, reject) => {
      const ws = (this.events = new WebSocket(wsUrl(c.events_url)));
      ws.onopen = () => ws.send(JSON.stringify({ capability: c.capability }));
      ws.onerror = () => reject(new Error("Event connection unavailable"));
      ws.onmessage = ({ data }) => {
        const event = JSON.parse(data);
        if (event.type === "snapshot") {
          this.snapshot = event.payload;
          this.revision = event.payload.session.revision;
          this.onSnapshot(event.payload);
          resolve();
          return;
        }
        if (event.type === "session.state")
          this.revision = event.payload.session.revision;
        if (event.type === "command.ack") {
          this.revision = Math.max(this.revision, event.payload.revision);
          const pending = this.pending.get(event.payload.command_id);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve();
            this.pending.delete(event.payload.command_id);
          }
        }
        if (event.type === "error") {
          for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(event.payload.detail));
          }
          this.pending.clear();
        }
        this.onEvent(event);
      };
      ws.onclose = () => {
        reject(new Error("Connection closed"));
        this.reconnect();
      };
    });
    await new Promise<void>((resolve, reject) => {
      const ws = (this.audio = new WebSocket(wsUrl(c.audio_url)));
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        ws.send(JSON.stringify({ capability: c.capability }));
        ws.send(JSON.stringify({ encoding: "pcm_s16le", channels: 1 }));
      };
      ws.onerror = () => reject(new Error("Audio connection unavailable"));
      ws.onmessage = ({ data }) => {
        try {
          if (data instanceof ArrayBuffer) this.onPcm(data);
          else {
            const message = JSON.parse(data);
            if (message.type === "audio.ready") resolve();
            else this.onAudio(message);
          }
        } catch (e) {
          this.status(String(e));
          this.disconnected();
        }
      };
      ws.onclose = () => {
        reject(new Error("Audio closed"));
        this.reconnect();
      };
    });
    this.retry = 0;
    this.status("Connected");
    // Private cached clips may be prefetched after reconnect; never enqueue them for playback.
    for (const key of this.snapshot?.cache_keys ?? [])
      void fetch(`/api/audio/${key}?session_id=${c.session_id}`, {
        headers: { Authorization: `Bearer ${c.capability}` },
      }).catch(() => {});
  }
  reconnect() {
    if (this.disposed || this.timer) return;
    this.disconnected();
    this.status("Reconnecting…");
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Disconnected"));
    }
    this.pending.clear();
    const events = this.events,
      audio = this.audio;
    if (events) events.onclose = null;
    if (audio) audio.onclose = null;
    events?.close();
    audio?.close();
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.connect().catch(() => this.reconnect());
      },
      Math.min(5000, 500 * 2 ** this.retry++),
    );
  }
  command(payload: Command["payload"]) {
    const send = async () => {
      if (this.events?.readyState !== WebSocket.OPEN)
        throw new Error("Disconnected");
      const command: Command = {
        schema_version: 1,
        command_id: crypto.randomUUID(),
        expected_revision: this.revision,
        payload,
      };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(command.command_id);
          reject(new Error("Command timeout"));
        }, 6000);
        this.pending.set(command.command_id, { resolve, reject, timer });
        this.events!.send(JSON.stringify(command));
      });
      if (payload.type === "session.configure") void this.preload();
    };
    const result = this.chain.then(send);
    this.chain = result.catch(() => {});
    return result;
  }
  async preload() {
    const c = this.connection;
    if (!c) return;
    const headers = { Authorization: `Bearer ${c.capability}` };
    try {
      const response = await fetch(`/api/sessions/${c.session_id}/preload`, {
        headers,
      });
      if (!response.ok) return;
      const { manifests } = await response.json();
      for (const m of manifests)
        void fetch(`${m.audio_location}?session_id=${c.session_id}`, {
          headers,
        }).catch(() => {});
    } catch {
      /* Cache preparation is optional; streaming and captions still work. */
    }
  }
  async refresh() {
    const c = this.connection;
    if (!c) return;
    const response = await fetch(`/api/sessions/${c.session_id}/snapshot`, {
      headers: { Authorization: `Bearer ${c.capability}` },
    });
    if (!response.ok) throw new Error("Snapshot unavailable");
    const snapshot: Snapshot = await response.json();
    if (snapshot.session.revision < this.revision) return;
    this.snapshot = snapshot;
    this.revision = snapshot.session.revision;
    this.onSnapshot(snapshot);
  }
  upload(data: ArrayBuffer) {
    if (
      this.audio?.readyState !== WebSocket.OPEN ||
      this.audio.bufferedAmount > 192000
    ) {
      this.disconnected();
      throw new Error("Microphone connection is too slow");
    }
    this.audio.send(data);
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.events?.close();
    this.audio?.close();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Closed"));
    }
    this.pending.clear();
  }
}
