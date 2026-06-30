/**
 * Velocity scoring — the "is this even happening?" signal (P5).
 *
 * Velocity is items/hour over a recent window, NOT raw volume: three angry
 * posts with no acceleration is noise; a cluster filling up in the last hour is
 * an event. We rank by this rate so a small-but-surging narrative outranks a
 * large-but-stale one.
 */

const HOUR_MS = 3_600_000;

/**
 * Items/hour across the recent window. We count items in the last `windowHours`
 * and divide by the elapsed span (capped at the window, floored at 1h so a
 * single fresh burst doesn't divide by ~0 into a meaningless spike).
 */
export function computeVelocity(
  timestamps: Date[],
  now: Date = new Date(),
  windowHours = 6,
): number {
  if (timestamps.length === 0) return 0;
  const cutoff = now.getTime() - windowHours * HOUR_MS;
  const recent = timestamps.filter((t) => t.getTime() >= cutoff);
  if (recent.length === 0) return 0;

  const oldest = Math.min(...recent.map((t) => t.getTime()));
  const spanHours = Math.max((now.getTime() - oldest) / HOUR_MS, 1);
  return recent.length / spanHours;
}
