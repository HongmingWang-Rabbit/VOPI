/**
 * Parse duration string (e.g., "15m", "7d", "1h") to milliseconds
 *
 * Supported units:
 * - s: seconds
 * - m: minutes
 * - h: hours
 * - d: days
 * - w: weeks
 *
 * @param duration Duration string like "15m", "7d", "2h", "2w"
 * @returns Duration in milliseconds
 * @throws Error if duration format is invalid
 *
 * @example
 * parseDuration('15m') // 900000 (15 minutes in ms)
 * parseDuration('7d')  // 604800000 (7 days in ms)
 * parseDuration('2h')  // 7200000 (2 hours in ms)
 * parseDuration('2w')  // 1209600000 (2 weeks in ms)
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhdw])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Expected format like "15m", "7d", "2h", "2w"`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    case 'w':
      return value * 7 * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Format milliseconds to human-readable duration string
 *
 * @param ms Duration in milliseconds
 * @returns Human-readable duration string
 *
 * @example
 * formatDuration(900000) // "15m"
 * formatDuration(7200000) // "2h"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d`;
}
