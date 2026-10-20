/**
 * The Twist intro, played inside the player before an episode starts.
 *
 * This is a port of the standalone `intro.html` animation: the mark draws
 * itself (a line opens into the gray arrow, its leg swings out as the red one),
 * a light sweeps across and the wordmark rises — while a small WebAudio score
 * (timpani, plucked strings, a bowed swell) plays under it. Everything here is
 * synthesised; no files, no video, no iframe: it *is* part of the player.
 */
import { useEffect, useRef } from 'react';

const TOTAL_SECONDS = 4.8;
const REDUCED_SECONDS = 0.9;
const RAD = Math.PI / 180;
const BETA = 63.435;

type Point = [number, number];

const GRAY = {
  dot: [[4.9, 0.1], [4.9, 0], [4.9, 0.1], [5.1, 0.1], [5.1, 0], [5.1, 0.1]] as Point[],
  line: [[4.9, 10], [4.9, 0], [4.9, 10], [5.1, 10], [5.1, 0], [5.1, 10]] as Point[],
  arrow: [[0, 10], [5, 0], [10, 10], [9, 10], [5, 2], [1, 10]] as Point[],
};
const BAR: Point[] = [[6, 0], [16, 0], [15.5, 1], [7.5, 1]];
const PV: Point = [6.75, 0.5];

/** The red leg in its own frame, swung by `q` (0 = flat in the bar, 1 = final). */
const leg = (q: number): Point[] => {
  const th = BETA * q * RAD;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const far = 9.25 + 1.147 * q;
  const farIn = 8.58 + 1.147 * q;
  const point = (a: number, b: number): Point => [PV[0] + a * c + b * s, PV[1] + a * s - b * c];
  return [point(-0.7826, -0.447), point(far, -0.447), point(farIn, 0.447), point(0.7826, 0.447)];
};

const poly = (points: Point[]) => points.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(' ');
const mix = (a: Point[], b: Point[], p: number): Point[] =>
  a.map((v, i) => [v[0] + (b[i][0] - v[0]) * p, v[1] + (b[i][1] - v[1]) * p]);

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
const easeInOutCubic = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const easeInOutQuad = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

/* ------------------------------- the score -------------------------------- */

type Audio = {
  play: (from: number) => void;
  stop: () => void;
  destroy: () => void;
};

const createScore = (volume: number): Audio => {
  let ctx: AudioContext | null = null;
  let out: GainNode | null = null;
  let wave: PeriodicWave | null = null;
  let noise: AudioBuffer | null = null;
  let bus: GainNode | null = null;
  let wetG: GainNode | null = null;
  let conv: ConvolverNode | null = null;
  const live: AudioScheduledSourceNode[] = [];

  const track = <T extends AudioScheduledSourceNode>(node: T) => {
    live.push(node);
    return node;
  };

  const ensure = () => {
    if (ctx) return ctx;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;

    ctx = new Ctor();
    const sampleRate = ctx.sampleRate;

    out = ctx.createGain();
    out.gain.value = volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 30;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.4;
    out.connect(comp);
    comp.connect(ctx.destination);

    // A damped hall: noise that fades and darkens as it rings.
    const length = Math.floor(sampleRate * 3.2);
    const impulse = ctx.createBuffer(2, length, sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      let lp = 0;
      for (let i = 0; i < length; i += 1) {
        const x = i / length;
        const a = 0.55 * Math.pow(1 - x, 1.6) + 0.03;
        lp += (Math.random() * 2 - 1 - lp) * a;
        data[i] = lp * Math.pow(1 - x, 2.2) * (i < sampleRate * 0.012 ? i / (sampleRate * 0.012) : 1);
      }
    }

    // Bowed-string timbre: soft harmonic roll-off, no buzzy saw edge.
    const harmonics = 14;
    const re = new Float32Array(harmonics);
    const im = new Float32Array(harmonics);
    for (let n = 1; n < harmonics; n += 1) im[n] = 1 / Math.pow(n, 1.35);
    wave = ctx.createPeriodicWave(re, im);

    noise = ctx.createBuffer(1, sampleRate, sampleRate);
    const noiseData = noise.getChannelData(0);
    for (let i = 0; i < sampleRate; i += 1) noiseData[i] = Math.random() * 2 - 1;

    conv = ctx.createConvolver();
    conv.buffer = impulse;
    return ctx;
  };

  /** Felt-mallet timpani: a few head modes, each with its own decay. */
  const drum = (c: AudioContext, at: number, f: number, dur: number, vol: number) => {
    const busNode = bus!;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    lp.connect(busNode);

    (
      [
        [1, 1, 1],
        [1.5, 0.5, 0.6],
        [2, 0.36, 0.42],
        [2.5, 0.2, 0.3],
        [3, 0.1, 0.2],
      ] as const
    ).forEach(([ratio, amount, decay]) => {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f * ratio * 1.12, at);
      o.frequency.exponentialRampToValueAtTime(f * ratio, at + 0.08);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol * amount, at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur * decay);
      o.connect(g);
      g.connect(lp);
      track(o);
      o.start(at);
      o.stop(at + dur * decay + 0.05);
    });

    const source = c.createBufferSource();
    source.buffer = noise;
    const nl = c.createBiquadFilter();
    nl.type = 'lowpass';
    nl.frequency.value = 650;
    const ng = c.createGain();
    ng.gain.setValueAtTime(vol * 0.5, at);
    ng.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    source.connect(nl);
    nl.connect(ng);
    ng.connect(busNode);
    track(source);
    source.start(at);
    source.stop(at + 0.08);
  };

  /** Plucked string (Karplus–Strong, with the pick softened). */
  const pluck = (c: AudioContext, at: number, f: number, dur: number, vol: number) => {
    const sampleRate = c.sampleRate;
    const length = Math.floor(sampleRate * dur);
    const period = Math.max(2, Math.round(sampleRate / f));
    const buffer = c.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    const ring = new Float32Array(period);

    let p = 0;
    for (let i = 0; i < period; i += 1) {
      p += (Math.random() * 2 - 1 - p) * 0.4;
      ring[i] = p;
    }
    for (let i = 0, k = 0; i < length; i += 1, k = (k + 1) % period) {
      data[i] = ring[k] * 2.2;
      ring[k] = (ring[k] + ring[(k + 1) % period]) * 0.4985;
    }

    const source = c.createBufferSource();
    source.buffer = buffer;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, at);
    g.gain.linearRampToValueAtTime(0, at + dur);
    source.connect(lp);
    lp.connect(g);
    g.connect(bus!);
    track(source);
    source.start(at);
  };

  /** Bowed strings: two players per note, slow bow, late vibrato, a little drift. */
  const strings = (
    c: AudioContext,
    at: number,
    notes: [number, number][],
    att: number,
    hold: number,
    rel: number,
    vol: number
  ) => {
    const end = at + att + hold + rel;
    const busNode = bus!;

    notes.forEach(([f, lv]) => {
      [-1, 1].forEach((side) => {
        const o = c.createOscillator();
        o.setPeriodicWave(wave!);
        o.frequency.value = f * Math.pow(2, (side * (3 + Math.random() * 3)) / 1200);

        const lfo = c.createOscillator();
        lfo.frequency.value = 4.8 + Math.random() * 0.8;
        const lg = c.createGain();
        lg.gain.setValueAtTime(0, at);
        lg.gain.linearRampToValueAtTime(f * 0.003, at + att + 0.3);
        lfo.connect(lg);
        lg.connect(o.frequency);

        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 0.5;
        lp.frequency.setValueAtTime(500, at);
        lp.frequency.exponentialRampToValueAtTime(2600, at + att);
        lp.frequency.exponentialRampToValueAtTime(900, end);

        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(vol * lv, at + att);
        g.gain.setValueAtTime(vol * lv, at + att + hold);
        g.gain.exponentialRampToValueAtTime(0.0001, end);
        o.connect(lp);
        lp.connect(g);

        if (c.createStereoPanner) {
          const panner = c.createStereoPanner();
          panner.pan.value = side * 0.3;
          g.connect(panner);
          panner.connect(busNode);
        } else {
          g.connect(busNode);
        }

        track(o);
        track(lfo);
        o.start(at);
        lfo.start(at);
        o.stop(end + 0.1);
        lfo.stop(end + 0.1);
      });
    });
  };

  /** D major, a swell that leans into "ta … dum". */
  const SCORE: { t: number; run: (c: AudioContext, at: number) => void }[] = [
    {
      t: 0.15,
      run: (c, at) => {
        pluck(c, at, 220, 1.8, 0.12);
        strings(c, at, [[73.42, 1], [110, 0.8], [146.83, 0.6]], 2.3, 0, 1.2, 0.018);
      },
    },
    { t: 0.65, run: (c, at) => pluck(c, at, 293.66, 1.5, 0.09) },
    { t: 1.2, run: (c, at) => pluck(c, at, 369.99, 1.5, 0.08) },
    { t: 1.85, run: (c, at) => drum(c, at, 110, 0.7, 0.32) },
    {
      t: 2.45,
      run: (c, at) => {
        drum(c, at, 73.42, 2.8, 0.6);
        strings(c, at, [[73.42, 1], [110, 0.85], [146.83, 0.8], [185, 0.45], [220, 0.6], [293.66, 0.45]], 0.22, 0.5, 2.4, 0.03);
      },
    },
    { t: 2.65, run: (c, at) => pluck(c, at, 587.33, 1.9, 0.07) },
  ];

  const stop = () => {
    if (!bus || !ctx) return;
    const currentBus = bus;
    const currentWet = wetG;
    const currentConv = conv;
    const nodes = live.slice();

    currentBus.gain.cancelScheduledValues(ctx.currentTime);
    currentBus.gain.setTargetAtTime(0, ctx.currentTime, 0.012);
    window.setTimeout(() => {
      nodes.forEach((node) => {
        try {
          node.stop();
        } catch {
          /* already ended */
        }
      });
      try {
        currentBus.disconnect();
        currentWet?.disconnect();
        currentConv?.disconnect();
      } catch {
        /* ignore */
      }
    }, 150);

    live.length = 0;
    bus = null;
  };

  const play = (from: number) => {
    const c = ensure();
    if (!c) return;
    if (c.state === 'suspended') void c.resume();
    stop();

    bus = c.createGain();
    wetG = c.createGain();
    wetG.gain.value = 0.36;
    bus.connect(out!);
    bus.connect(wetG);
    wetG.connect(conv!);
    conv!.connect(out!);

    const t0 = c.currentTime + 0.06;
    SCORE.forEach((event) => {
      if (event.t - from >= 0) event.run(c, t0 + (event.t - from));
    });
  };

  const destroy = () => {
    stop();
    void ctx?.close().catch(() => undefined);
    ctx = null;
  };

  return { play, stop, destroy };
};

/* ------------------------------ the component ----------------------------- */

export const IntroAnimation = ({
  onEnded,
  volume = 0.9,
}: {
  onEnded: () => void;
  volume?: number;
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const grayRef = useRef<SVGPolygonElement>(null);
  const barRef = useRef<SVGPolygonElement>(null);
  const legRef = useRef<SVGPolygonElement>(null);
  const beamRef = useRef<HTMLDivElement>(null);
  const wordRef = useRef<HTMLDivElement>(null);
  const endedRef = useRef(onEnded);

  useEffect(() => {
    endedRef.current = onEnded;
  }, [onEnded]);

  useEffect(() => {
    const host = hostRef.current;
    const wordmark = wordRef.current;
    if (!host || !wordmark) return;

    const letters = Array.from(wordmark.querySelectorAll<HTMLElement>('span'));

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const total = reduce ? REDUCED_SECONDS : TOTAL_SECONDS;
    const score = createScore(volume);

    const draw = (gray: Point[], grayOpacity: number, rot: number, barOpacity: number, q: number) => {
      grayRef.current?.setAttribute('points', poly(gray));
      grayRef.current?.setAttribute('transform', `rotate(${rot.toFixed(3)} 5 0)`);
      if (grayRef.current) grayRef.current.style.opacity = grayOpacity.toFixed(3);
      barRef.current?.setAttribute('points', poly(BAR));
      if (barRef.current) barRef.current.style.opacity = barOpacity.toFixed(3);
      legRef.current?.setAttribute('points', poly(leg(q)));
      if (legRef.current) legRef.current.style.opacity = seg(q, 0, 0.15).toFixed(3);
    };

    const render = (time: number) => {
      const t = clamp(time, 0, total);
      const width = host.clientWidth || 1000;

      const grayPath =
        t < 0.65
          ? mix(GRAY.dot, GRAY.line, easeOutCubic(seg(t, 0.15, 0.65)))
          : mix(GRAY.line, GRAY.arrow, easeInOutCubic(seg(t, 0.65, 1.2)));
      const rot = -BETA * (1 - easeInOutCubic(seg(t, 1.2, 1.85)));
      const q = easeInOutCubic(seg(t, 1.75, 2.45));
      draw(grayPath, seg(t, 0.1, 0.24), rot, seg(t, 1.24, 1.34), q);

      const beamProgress = easeInOutQuad(seg(t, 2.35, 3.35));
      if (beamRef.current) {
        beamRef.current.style.transform = `translateX(${(-0.18 * width + beamProgress * 1.18 * width).toFixed(1)}px)`;
        beamRef.current.style.opacity = (Math.sin(Math.PI * beamProgress) * 0.6).toFixed(3);
      }

      letters.forEach((letter, index) => {
        const e = easeOutCubic(seg(t, 2.55 + index * 0.09, 3.15 + index * 0.09));
        letter.style.transform = `translateY(${((1 - e) * 110).toFixed(1)}%)`;
      });

      const spacing = 0.42 + 0.45 * (1 - easeOutCubic(seg(t, 2.55, 3.8)));
      wordmark.style.letterSpacing = `${spacing.toFixed(3)}em`;
      wordmark.style.marginRight = `${(-spacing).toFixed(3)}em`;
      wordmark.style.fontSize = `${Math.max(14, width * 0.055).toFixed(2)}px`;
    };

    // Reduced motion: no animation, straight to the episode.
    if (reduce) {
      const done = window.setTimeout(() => endedRef.current(), 80);
      return () => {
        window.clearTimeout(done);
        score.destroy();
      };
    }

    render(0);
    score.play(0);

    let raf = 0;
    let last = performance.now();
    let time = 0;

    const loop = (now: number) => {
      time += Math.min(0.05, (now - last) / 1000);
      last = now;
      if (time >= total) {
        render(total);
        score.stop();
        endedRef.current();
        return;
      }
      render(time);
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);

    const onResize = () => render(time);
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      score.destroy();
    };
  }, [volume]);

  return (
    <div ref={hostRef} className="twist-intro absolute inset-0 z-20 bg-black" role="presentation">
      <div className="twist-intro-stack" aria-hidden="true">
        <div className="twist-intro-logo">
          <svg viewBox="0 0 16 10" className="twist-intro-svg">
            <polygon ref={grayRef} fill="#cdcece" />
            <polygon ref={barRef} fill="var(--accent, #d4433c)" />
            <polygon ref={legRef} fill="var(--accent, #d4433c)" />
          </svg>
        </div>
        <div ref={wordRef} className="twist-intro-word">
          {['T', 'W', 'I', 'S', 'T'].map((letter, index) => (
            <span key={index} className="twist-intro-ch">
              <span>{letter}</span>
            </span>
          ))}
        </div>
      </div>
      <div ref={beamRef} className="twist-intro-beam" aria-hidden="true" />
      <button
        type="button"
        onClick={() => endedRef.current()}
        className="focus:outline-none absolute bottom-3 right-3 rounded bg-black/60 px-3 py-1.5 font-body text-xs text-white/75 transition duration-200 hover:bg-black/80 hover:text-white"
      >
        Skip intro
      </button>
    </div>
  );
};
