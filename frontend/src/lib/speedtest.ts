import { useEffect, useRef, useState } from 'react';

import { desktop, type SpeedResult } from './desktop';

/**
 * How often the connection is re-measured while something is playing.
 *
 * The test never runs when nothing is playing or the player is paused: it would
 * compete with the stream for bandwidth and measure an idle link for no reason.
 */
const INTERVAL_MS = 45_000;
/** Wait this long after playback starts before the first probe. */
const FIRST_DELAY_MS = 8_000;

/* --------------------------------------------------------------------------
 * Pause switch
 *
 * The counter in the title bar is a button: clicking it pauses all background
 * measurement until it is clicked again. The state is module-level (plus
 * localStorage) so the title bar, the player and the connection reading all
 * agree, and it survives a reload.
 * ----------------------------------------------------------------------- */

const PAUSE_KEY = 'twist:speed-paused';

const readPaused = () => {
  try {
    return localStorage.getItem(PAUSE_KEY) === '1';
  } catch {
    return false;
  }
};

let paused = typeof window === 'undefined' ? false : readPaused();
const listeners = new Set<(value: boolean) => void>();

export const isSpeedTestPaused = () => paused;

export const setSpeedTestPaused = (value: boolean) => {
  if (paused === value) return;
  paused = value;
  try {
    if (value) localStorage.setItem(PAUSE_KEY, '1');
    else localStorage.removeItem(PAUSE_KEY);
  } catch {
    /* storage is optional */
  }
  for (const listener of listeners) listener(value);
};

/** Subscribes a component to the pause switch. */
export const useSpeedTestPaused = () => {
  const [value, setValue] = useState(paused);
  useEffect(() => {
    const listener = (next: boolean) => setValue(next);
    listeners.add(listener);
    // Another window may have changed it.
    listener(readPaused());
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
};

export type SpeedState = {
  /** Latest estimate in megabits per second (0 until measured). */
  mbps: number;
  /** Bytes the current estimate was measured from. */
  bytes: number;
  /** False while a probe is in flight. */
  idle: boolean;
};

/**
 * Measures the connection periodically while `playing` is true, and stops the
 * moment playback pauses, the viewer pauses the test, or the player unmounts.
 */
export const useSpeedTest = (playing: boolean, enabled: boolean): SpeedState => {
  const [state, setState] = useState<SpeedState>({ mbps: 0, bytes: 0, idle: true });
  const pausedNow = useSpeedTestPaused();
  const inFlight = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!enabled || pausedNow || !desktop.available()) return;
    let active = true;

    const measure = async () => {
      // The switch may have been flipped while a probe was queued.
      if (inFlight.current || isSpeedTestPaused()) return;
      inFlight.current = true;
      setState((current) => ({ ...current, idle: false }));
      try {
        const result: SpeedResult = await desktop.measureSpeed();
        if (active) setState({ mbps: result.mbps, bytes: result.bytes, idle: true });
      } catch {
        if (active) setState((current) => ({ ...current, idle: true }));
      } finally {
        inFlight.current = false;
      }
    };

    const schedule = (delay: number) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (!active) return;
        void measure();
        schedule(INTERVAL_MS);
      }, delay);
    };

    if (playing) schedule(FIRST_DELAY_MS);
    else window.clearTimeout(timer.current);

    return () => {
      active = false;
      window.clearTimeout(timer.current);
    };
  }, [playing, enabled, pausedNow]);

  // Leaving the page mid-probe must not leave the UI saying "measuring".
  useEffect(
    () => () => {
      inFlight.current = false;
    },
    []
  );

  return state;
};
