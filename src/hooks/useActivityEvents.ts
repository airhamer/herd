// Fleet activity feed state (issue #32): an initial GET /api/events, live
// pushes from the dashboard WebSocket (via activityBus), a slow catch-up
// poll for anything a dropped socket missed, and "load older" paging.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchEvents } from "../api/client";
import type { ActivityEvent, EventsQuery } from "../api/types";
import { subscribeActivity } from "./activityBus";

export const ACTIVITY_POLL_MS = 30_000;

export interface ActivityFilter {
  sparkId?: string;
  /** Exact types or trailing-dot prefixes ("gpu."). */
  types?: string[];
}

export interface UseActivityEvents {
  events: ActivityEvent[];
  loading: boolean;
  error: string | null;
  /** True when older events may exist beyond what is loaded. */
  hasMore: boolean;
  loadOlder: () => Promise<void>;
  reload: () => Promise<void>;
}

/** Does a pushed event belong in a feed with this filter? */
export function matchesFilter(event: ActivityEvent, filter: ActivityFilter): boolean {
  if (filter.sparkId && event.sparkId !== filter.sparkId) return false;
  if (filter.types && filter.types.length > 0) {
    return filter.types.some((t) => (t.endsWith(".") ? event.type.startsWith(t) : event.type === t));
  }
  return true;
}

/** Merge by id, newest first, capped. */
export function mergeEvents(current: ActivityEvent[], incoming: ActivityEvent[], cap: number): ActivityEvent[] {
  if (incoming.length === 0) return current;
  const byId = new Map<number, ActivityEvent>();
  for (const e of current) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, cap);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * @param limit page size for the first load and each "load older"
 * @param filter optional unit / type filter (applied server-side and to pushes)
 * @param cap most events kept in memory
 */
export function useActivityEvents({
  limit = 50,
  filter = {},
  cap = 2000,
}: { limit?: number; filter?: ActivityFilter; cap?: number } = {}): UseActivityEvents {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const generation = useRef(0);

  const sparkId = filter.sparkId;
  const typesKey = (filter.types ?? []).join(",");

  const query = useCallback(
    (extra: EventsQuery): EventsQuery => ({
      limit,
      ...(sparkId ? { sparkId } : {}),
      ...(typesKey ? { types: typesKey.split(",") } : {}),
      ...extra,
    }),
    [limit, sparkId, typesKey],
  );

  const reload = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    try {
      const res = await fetchEvents(query({}));
      if (gen !== generation.current) return;
      setEvents(res.events.slice(0, cap));
      setHasMore(res.events.length >= limit);
      setError(null);
    } catch (err) {
      if (gen !== generation.current) return;
      setError(message(err));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [query, limit, cap]);

  const loadOlder = useCallback(async () => {
    const current = eventsRef.current;
    const oldest = current[current.length - 1];
    if (!oldest) return;
    const gen = generation.current;
    try {
      const res = await fetchEvents(query({ beforeId: oldest.id }));
      if (gen !== generation.current) return;
      setEvents((prev) => mergeEvents(prev, res.events, cap));
      setHasMore(res.events.length >= limit);
      setError(null);
    } catch (err) {
      if (gen === generation.current) setError(message(err));
    }
  }, [query, limit, cap]);

  // First load, and again whenever the filter changes.
  useEffect(() => {
    void reload();
  }, [reload]);

  // Live pushes.
  useEffect(() => {
    const filterNow: ActivityFilter = { sparkId, types: typesKey ? typesKey.split(",") : [] };
    return subscribeActivity((event) => {
      if (!matchesFilter(event, filterNow)) return;
      setEvents((prev) => mergeEvents(prev, [event], cap));
    });
  }, [sparkId, typesKey, cap]);

  // Catch-up poll: anything newer than what we hold (covers socket gaps).
  useEffect(() => {
    const timer = window.setInterval(() => {
      const newest = eventsRef.current[0];
      const gen = generation.current;
      fetchEvents(query(newest ? { sinceId: newest.id } : {}))
        .then((res) => {
          if (gen !== generation.current) return;
          setEvents((prev) => mergeEvents(prev, res.events, cap));
          setError(null);
        })
        .catch((err) => {
          if (gen === generation.current) setError(message(err));
        });
    }, ACTIVITY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [query, cap]);

  return { events, loading, error, hasMore, loadOlder, reload };
}
