import { Client } from "pg";
import type { RealtimeEvent } from "./realtime-rls";

// In-process realtime fan-out hub.
//
// Postgres delivers row-change events via pg_notify on per-table channels
// ("realtime:<schema>:<table>", emitted by the _dashboard.realtime_notify
// trigger). The naive approach holds one LISTEN connection per SSE subscriber,
// which caps concurrent subscribers at the pool size (~50) and burns through
// Postgres `max_connections` long before a feature like chat reaches hundreds
// of simultaneous users.
//
// Instead, each replica keeps ONE shared connection that LISTENs on the union
// of channels that currently have subscribers, and fans every notification out
// to the in-process subscribers for that channel. Subscriber count is then
// bounded by memory (thousands per replica), not by DB connections (exactly one
// per replica, regardless of how many users are streaming). pg_notify still
// reaches every replica's shared connection, so multi-replica fan-out is
// automatic — each replica delivers to its own local subscribers.

// A subscriber is either a plain delivery callback (basic mode) or one paired
// with an authorizer (authorized mode). When `authorize` is present the hub
// calls it with the parsed event and only delivers the raw payload if it
// resolves true. `authzKey` lets the hub evaluate the decision once per distinct
// identity per event and reuse it across subscribers that share it.
type Subscriber = {
  deliver: (payload: string) => void;
  authorize?: (event: RealtimeEvent) => Promise<boolean> | boolean;
  authzKey?: string;
};

const RECONNECT_MS = 2_000;

// Channels are built from already-validated schema/table identifiers, but quote
// defensively since they're interpolated into LISTEN/UNLISTEN (which take an
// identifier, not a bind parameter).
function quoteChannel(channel: string): string {
  return `"${channel.replace(/"/g, '""')}"`;
}

class RealtimeHub {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private readonly channels = new Map<string, Set<Subscriber>>();
  private readonly connectionString =
    process.env.REALTIME_DATABASE_URL ?? process.env.DATABASE_URL;

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) this.connecting = this.connect();
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    if (!this.connectionString) {
      throw new Error("REALTIME_DATABASE_URL/DATABASE_URL is not set");
    }
    const client = new Client({
      connectionString: this.connectionString,
      keepAlive: true,
    });

    client.on("notification", (msg: { channel: string; payload?: string }) => {
      const subs = this.channels.get(msg.channel);
      if (!subs) return;
      this.dispatch(subs, msg.payload ?? "");
    });

    const onDown = (err?: Error) => {
      if (this.client !== client && this.connecting === null) return;
      if (err) console.error("[realtime] listener connection lost:", err.message);
      this.client = null;
      this.connecting = null;
      client.removeAllListeners();
      client.end().catch(() => {});
      // Reconnect (and re-LISTEN every active channel) as long as anyone is
      // still subscribed. Events that fire during the gap are missed — SSE
      // clients (EventSource) reconnect on stream close and re-subscribe.
      if (this.channels.size > 0) {
        setTimeout(() => void this.getClient().catch(() => {}), RECONNECT_MS);
      }
    };
    client.on("error", onDown);
    client.on("end", () => onDown());

    await client.connect();
    this.client = client;
    this.connecting = null;

    // Restore every active channel. On the first connect the map is empty; on a
    // reconnect this re-establishes the full set.
    for (const channel of this.channels.keys()) {
      await client.query(`LISTEN ${quoteChannel(channel)}`);
    }
    return client;
  }

  // Fans one notification out to a channel's subscribers. Basic subscribers get
  // the raw payload immediately. Authorized subscribers are filtered by their
  // `authorize` callback; the decision is computed once per distinct `authzKey`
  // per event (many subscribers share a user identity) and reused. A failing or
  // throwing authorizer fails closed (the event is dropped for that subscriber).
  private dispatch(subs: Set<Subscriber>, payload: string): void {
    let event: RealtimeEvent | null = null;
    let parsed = false;
    // Per-event memo of authorization decisions, keyed by authzKey.
    let decisions: Map<string, Promise<boolean>> | null = null;

    for (const sub of subs) {
      if (!sub.authorize) {
        try {
          sub.deliver(payload);
        } catch {
          /* a slow/throwing subscriber must never block the others */
        }
        continue;
      }

      if (!parsed) {
        parsed = true;
        try {
          event = JSON.parse(payload) as RealtimeEvent;
        } catch {
          event = null;
        }
      }
      // Unparseable payload → fail closed for every authorized subscriber.
      if (!event) continue;
      const evt = event;

      if (!decisions) decisions = new Map();
      const key = sub.authzKey ?? "";
      let decision = decisions.get(key);
      if (!decision) {
        decision = Promise.resolve()
          .then(() => sub.authorize!(evt))
          .catch(() => false);
        decisions.set(key, decision);
      }
      decision
        .then((ok) => {
          if (ok) {
            try {
              sub.deliver(payload);
            } catch {
              /* ignore */
            }
          }
        })
        .catch(() => {});
    }
  }

  // Subscribe to a channel; returns an unsubscribe function. The shared
  // connection LISTENs on the first subscriber to a channel and UNLISTENs when
  // the last one leaves.
  async subscribe(channel: string, fn: Subscriber): Promise<() => void> {
    let subs = this.channels.get(channel);
    const firstForChannel = !subs;
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(fn);

    try {
      const client = await this.getClient();
      if (firstForChannel) {
        await client.query(`LISTEN ${quoteChannel(channel)}`);
      }
    } catch (e) {
      // Roll back so a failed LISTEN doesn't leave a phantom subscriber.
      subs.delete(fn);
      if (subs.size === 0) this.channels.delete(channel);
      throw e;
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const set = this.channels.get(channel);
      if (!set) return;
      set.delete(fn);
      if (set.size === 0) {
        this.channels.delete(channel);
        // Best-effort: if the connection is mid-reconnect the channel is simply
        // not re-LISTENed, since it's no longer in the map.
        this.client?.query(`UNLISTEN ${quoteChannel(channel)}`).catch(() => {});
      }
    };
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __realtimeHub: RealtimeHub | undefined;
}

// One hub per process (per replica). globalThis-scoped so dev HMR doesn't spin
// up a second listener connection.
export function realtimeHub(): RealtimeHub {
  if (!globalThis.__realtimeHub) globalThis.__realtimeHub = new RealtimeHub();
  return globalThis.__realtimeHub;
}
