import { useEffect, useState } from 'react';

import { desktop, type SpeedResult } from './desktop';
import { isSpeedTestPaused, useSpeedTestPaused } from './speedtest';

/**
 * The connection reading shown in the title bar.
 *
 * It displays the latest estimate from the shared speed test, and — only until
 * something has been measured — takes a single small sample so the number is
 * not permanently blank. Clicking the reading pauses the background test
 * entirely (`useSpeedTestPaused`), which is also what stops the bootstrap
 * sample from ever running again.
 */
const BOOTSTRAP_MS = 20_000;
const REFRESH_MS = 15_000;

export type ConnectionReading = {
  mbps: number;
  /** False until the first estimate arrives. */
  measured: boolean;
  /** True while the viewer has paused the background test. */
  paused: boolean;
};

export const useConnectionSpeed = (enabled: boolean): ConnectionReading => {
  const [reading, setReading] = useState<{ mbps: number; measured: boolean }>({
    mbps: 0,
    measured: false,
  });
  const paused = useSpeedTestPaused();

  useEffect(() => {
    if (!enabled || !desktop.available()) return;
    let active = true;
    const started = Date.now();

    const poll = async () => {
      try {
        const result: SpeedResult = await desktop.speedEstimate();
        if (!active) return;
        if (result.samples > 0) {
          setReading({ mbps: result.mbps, measured: true });
          return;
        }
        // Nothing measured yet: one sample, never while the test is paused.
        if (!isSpeedTestPaused() && Date.now() - started < BOOTSTRAP_MS) {
          const fresh = await desktop.measureSpeed();
          if (active && fresh.samples > 0) setReading({ mbps: fresh.mbps, measured: true });
        }
      } catch {
        /* the bar simply keeps its last value */
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled, paused]);

  return { ...reading, paused };
};

/** Formats megabits per second the way connection indicators usually do. */
export const formatSpeed = (mbps: number) => {
  if (!Number.isFinite(mbps) || mbps <= 0) return '—';
  if (mbps >= 100) return `${Math.round(mbps)} Mbps`;
  if (mbps >= 10) return `${mbps.toFixed(0)} Mbps`;
  return `${mbps.toFixed(1)} Mbps`;
};
