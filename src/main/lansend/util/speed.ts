/**
 * Speed, ETA and throughput accounting.
 *
 * A naive `bytes / elapsed` speed jumps around enough to make an ETA useless,
 * so the estimate uses an exponentially weighted moving average over a fixed
 * window of samples. The window is time-based, not count-based: at 100 MB/s a
 * count-based window would be milliseconds long and still noisy.
 */

const SAMPLE_WINDOW_MS = 1_000;

export class SpeedMeter {
  #samples: Array<{ at: number; bytes: number }> = [];
  #total = 0;
  #startedAt: number;
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#startedAt = now();
  }

  get total(): number {
    return this.#total;
  }

  /** Adds `bytes` and records a sample. Called per chunk, not per byte. */
  add(bytes: number): void {
    if (bytes <= 0) return;
    this.#total += bytes;
    const at = this.#now();
    this.#samples.push({ at, bytes });
    this.#trim(at);
  }

  /** Bytes per second over the sample window. 0 until the window has data. */
  get bytesPerSecond(): number {
    const at = this.#now();
    this.#trim(at);
    if (this.#samples.length === 0) return 0;
    const oldest = this.#samples[0]!;
    const span = at - oldest.at;
    // Under one second of data the span is too small to divide by; fall back
    // to the whole elapsed time so a short transfer still reports a number.
    const window = span >= 100 ? span : at - this.#startedAt;
    if (window <= 0) return 0;
    const bytes = this.#samples.reduce((sum, s) => sum + s.bytes, 0);
    return (bytes / window) * 1000;
  }

  /** Milliseconds until `remainingBytes` at the current speed, or null when stalled. */
  etaMs(remainingBytes: number): number | null {
    if (remainingBytes <= 0) return 0;
    const speed = this.bytesPerSecond;
    if (speed <= 0) return null;
    return Math.round((remainingBytes / speed) * 1000);
  }

  #trim(at: number): void {
    const cutoff = at - SAMPLE_WINDOW_MS;
    let drop = 0;
    while (drop < this.#samples.length && this.#samples[drop]!.at < cutoff) drop += 1;
    if (drop > 0) this.#samples = this.#samples.slice(drop);
  }
}

/** Formats a byte count for logs and CLI output. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Formats a duration for CLI output; `null` means "unknown". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '--';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m${rest.toString().padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, '0')}m`;
}
