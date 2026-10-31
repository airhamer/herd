// In-page fan-out for live activity events. useSnapshot owns the dashboard
// WebSocket and publishes every {type:"event"} push here; feeds subscribe.
import type { ActivityEvent } from "../api/types";

type Listener = (event: ActivityEvent) => void;
const listeners = new Set<Listener>();

export function publishActivity(event: ActivityEvent): void {
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch {
      // one feed's failure must not starve the others
    }
  }
}

/** Returns an unsubscribe function. */
export function subscribeActivity(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Plausible ActivityEvent shape (the socket is untrusted input). */
export function isActivityEvent(value: unknown): value is ActivityEvent {
  const e = value as ActivityEvent | null;
  return (
    !!e &&
    typeof e === "object" &&
    Number.isInteger(e.id) &&
    Number.isFinite(e.ts) &&
    typeof e.type === "string" &&
    typeof e.message === "string"
  );
}
