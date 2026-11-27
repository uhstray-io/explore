import { listenStatus } from '../assets/listening.js';

// The agents polling `next` for work, by map (null for every map) and worker. Presence (who is listening now)
// expires 40 seconds after a listener's last poll. Activity is kept apart from presence, so a slow poll never
// restarts a listening window (K1): it counts from the last saved change to a map the listener covers, which
// includes a job handed to it.
const presenceMs = 40000, forgetMs = 3 * 60 * 60 * 1000; // Activity outlasts the longest window.
export function createListeners() {
  const records = new Map();
  return {
    // A poll. Returns the listener, with its window starting now if it is new, or if it comes back after its
    // presence lapsed and its window had closed: that is a new agent session, often under the same worker name.
    seen(mapId, worker, windowMinutes, now = Date.now()) {
      const key = JSON.stringify([mapId, worker]);
      const record = records.get(key) ?? { mapId, worker, lastActivity: now, lastSeen: now };
      if (now - record.lastSeen >= presenceMs && now - record.lastActivity >= windowMinutes * 60000) record.lastActivity = now;
      record.lastSeen = now; records.set(key, record);
      return record;
    },
    // A saved change to `mapId` restarts the window of every listener covering it.
    noteActivity(mapId, now = Date.now()) { for (const record of records.values()) if (!record.mapId || record.mapId === mapId) record.lastActivity = now; },
    // Who is listening now; listeners silent for hours are forgotten.
    status(now = Date.now()) {
      for (const [key, record] of records) if (now - record.lastSeen >= forgetMs) records.delete(key);
      const live = [...records.values()].filter(record => now - record.lastSeen < presenceMs);
      return { listening: live.length > 0, scopes: live.map(({ mapId, worker }) => ({ mapId, worker, listening: true })) };
    },
    listen: (record, windowMinutes, now = Date.now()) => listenStatus({ windowMinutes, lastActivity: record.lastActivity, now }),
  };
}
