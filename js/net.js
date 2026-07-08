// Transport layer: one tiny interface, two implementations.
//
//   SupabaseTransport — production. Realtime broadcast + presence on a
//     public channel named after the room code. No database tables.
//   LocalTransport    — same-browser BroadcastChannel with emulated
//     presence. Used by automated tests (?t=local) and offline demos.
//
// Interface:
//   await t.join()                 resolves once connected & presence tracked
//   t.send(type, data)             broadcast to the OTHER peer(s) (no echo)
//   t.on(type, fn)                 fn({ from, data })
//   t.onPresence(fn)               fn([{ id, name, role }]) on any change
//   t.leave()

import { SUPABASE_URL, SUPABASE_KEY, TRANSPORT } from './config.js';

class BaseTransport {
  constructor(code, self) {
    this.code = code;
    this.self = self; // { id, name, role }
    this.handlers = new Map();
    this.presenceHandler = null;
  }
  on(type, fn) { this.handlers.set(type, fn); }
  onPresence(fn) { this.presenceHandler = fn; }
  _dispatch(type, from, data) {
    const fn = this.handlers.get(type);
    if (fn) fn({ from, data });
  }
  _emitPresence(members) {
    if (this.presenceHandler) this.presenceHandler(members);
  }
}

class SupabaseTransport extends BaseTransport {
  constructor(code, self) {
    super(code, self);
    // Game events are low-rate (a handful per question), so the default
    // client-side broadcast throttle (10 msg/s) is plenty.
    this.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    this.channel = null;
  }

  join() {
    return new Promise((resolve, reject) => {
      const ch = this.client.channel(`hmmm:${this.code}`, {
        config: {
          broadcast: { self: false, ack: false },
          presence: { key: this.self.id },
        },
      });
      this.channel = ch;

      ch.on('broadcast', { event: 'game' }, ({ payload }) => {
        if (!payload || payload.from === this.self.id) return;
        this._dispatch(payload.t, payload.from, payload.d);
      });

      ch.on('presence', { event: 'sync' }, () => {
        const state = ch.presenceState();
        const members = [];
        for (const key of Object.keys(state)) {
          const metas = state[key];
          if (metas && metas.length) {
            members.push({ id: key, name: metas[0].name, role: metas[0].role });
          }
        }
        this._emitPresence(members);
      });

      let settled = false;
      ch.subscribe(async (status, err) => {
        if (status === 'SUBSCRIBED') {
          await ch.track({ name: this.self.name, role: this.self.role });
          if (!settled) { settled = true; resolve(); }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          if (!settled) {
            settled = true;
            reject(new Error(`Could not connect (${status}${err ? ': ' + err.message : ''})`));
          }
        }
      });
    });
  }

  send(type, data) {
    if (!this.channel) return;
    this.channel.send({
      type: 'broadcast',
      event: 'game',
      payload: { t: type, from: this.self.id, d: data },
    });
  }

  leave() {
    if (this.channel) {
      this.client.removeChannel(this.channel);
      this.channel = null;
    }
  }
}

// ---------------------------------------------------------------------------

const LOCAL_HEARTBEAT_MS = 700;
const LOCAL_TIMEOUT_MS = 2500;

class LocalTransport extends BaseTransport {
  constructor(code, self) {
    super(code, self);
    this.bc = null;
    this.members = new Map(); // id -> { name, role, lastSeen }
    this.heartbeatTimer = null;
    this.reaperTimer = null;
  }

  join() {
    this.bc = new BroadcastChannel(`hmmm:${this.code}`);
    this.bc.onmessage = (ev) => {
      const m = ev.data;
      if (!m || m.from === this.self.id) return;
      if (m.t === '__hb') {
        const known = this.members.has(m.from);
        this.members.set(m.from, { ...m.d, lastSeen: Date.now() });
        if (!known) { this._beat(); this._syncPresence(); }
        return;
      }
      if (m.t === '__bye') {
        this.members.delete(m.from);
        this._syncPresence();
        return;
      }
      this._dispatch(m.t, m.from, m.d);
    };

    this._beat();
    this.heartbeatTimer = setInterval(() => this._beat(), LOCAL_HEARTBEAT_MS);
    this.reaperTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, m] of this.members) {
        if (now - m.lastSeen > LOCAL_TIMEOUT_MS) { this.members.delete(id); changed = true; }
      }
      if (changed) this._syncPresence();
    }, LOCAL_HEARTBEAT_MS);

    // Give existing peers a moment to heartbeat back so the first
    // presence snapshot is complete.
    return new Promise((resolve) => setTimeout(() => { this._syncPresence(); resolve(); }, 250));
  }

  _beat() {
    this.bc.postMessage({ t: '__hb', from: this.self.id, d: { name: this.self.name, role: this.self.role } });
  }

  _syncPresence() {
    const members = [{ id: this.self.id, name: this.self.name, role: this.self.role }];
    for (const [id, m] of this.members) members.push({ id, name: m.name, role: m.role });
    this._emitPresence(members);
  }

  send(type, data) {
    if (this.bc) this.bc.postMessage({ t: type, from: this.self.id, d: data });
  }

  leave() {
    if (this.bc) {
      this.bc.postMessage({ t: '__bye', from: this.self.id, d: {} });
      this.bc.close();
      this.bc = null;
    }
    clearInterval(this.heartbeatTimer);
    clearInterval(this.reaperTimer);
  }
}

// ---------------------------------------------------------------------------

export function createTransport(code, self) {
  return TRANSPORT === 'local'
    ? new LocalTransport(code, self)
    : new SupabaseTransport(code, self);
}
