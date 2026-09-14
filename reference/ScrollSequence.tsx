import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/* ---------------------------------------------------------------------------
 * MODE — how the sequence is driven
 *
 *   'page'    The page scrolls normally. A tall container holds a sticky,
 *             full-screen canvas, and the page's own scroll position picks the
 *             frame. Scrollbar, trackpad, keyboard, find-in-page and screen
 *             readers all behave as they normally would. This is the default,
 *             and it is required while the sequence is the hero of a longer
 *             page: 'virtual' locks the page, so nothing below it is reachable.
 *
 *   'virtual' The page does not scroll at all. The canvas is fixed to the
 *             viewport and wheel / touch / key input is captured and
 *             accumulated instead. Only sensible when the sequence is the
 *             whole page.
 *
 * Flip this one constant to switch. Everything below works in both modes.
 * ------------------------------------------------------------------------- */

const SCROLL_MODE: 'page' | 'virtual' = 'page';

/* ---------------------------------------------------------------------------
 * The frame sequence
 * ------------------------------------------------------------------------- */

/* === SET THESE FOR YOUR SEQUENCE ======================================== */

const TOTAL_FRAMES = 90;

/**
 * Where the frames are served from. Keep them in the static dir so the URL is
 * predictable and they are not run through the bundler.
 *
 * Deliver them SMALL. Source renders are usually 1920x1080 at ~900 KB, which is
 * ~80 MB for a 90-frame sequence and puts the page on a loading screen for a
 * minute. Run reference/optimise-frames.py first: 1600x900 at quality 72 is
 * ~106 KB a frame, under 10 MB for the sequence, with no visible loss at the
 * size a cover-fit canvas actually paints.
 */
const frameSrc = (n: number) => `/frames/frame_${String(n).padStart(3, '0')}.jpg`;

/**
 * How many frames must be decoded before the sequence becomes interactive.
 * The rest keep loading in the background.
 *
 * Even at under 10 MB the sequence is dozens of separate requests, so waiting on
 * the last one leaves a spell where scrolling does nothing at all. Holding input
 * hostage to the final frame is the one thing guaranteed to read as broken.
 * Set this to TOTAL_FRAMES for a strict preload-everything-first.
 */
const FRAMES_BEFORE_START = 12;

/* ---------------------------------------------------------------------------
 * SCROLL -> FRAME MAPPING
 *
 * Progress is a fraction from 0 to 1 spanning the whole sequence:
 *
 *     progress 0 -> frame 1        progress 1 -> frame 90
 *
 * In 'virtual' mode that fraction is accumulated wheel movement; in 'page' mode
 * it is how far the page has scrolled into the tall container. Either way the
 * sequence spans
 *
 *     travel = (SCROLL_LENGTH_VH / 100 - 1) viewport heights
 *
 * of scrolling — at 400vh, three screens' worth to get from frame 1 to frame 90.
 * Raise it to spend more scrolling on the same frames (slower); lower it to
 * spend less (faster). See the notes at the bottom of this file.
 *
 * Progress is kept as a fraction rather than in pixels so that resizing the
 * window cannot jump the animation.
 * ------------------------------------------------------------------------- */

const SCROLL_LENGTH_VH = 400;

/**
 * How quickly the painted frame chases the scroll position, per tick.
 *   Lower  (0.06) = heavier, more glide after you stop.
 *   Higher (0.25) = tighter, closer to raw scroll position.
 *   1      = no easing at all.
 */
const SMOOTHING = 0.14;

/**
 * Smoothing used when the viewer has asked for reduced motion. 1 means no
 * easing at all: the frame tracks the input exactly and nothing keeps moving
 * after they stop. The sequence still works — it just never drifts on its own,
 * which is the part of the effect the preference is actually about.
 */
const REDUCED_MOTION_SMOOTHING = 1;

/** Below this, scroll position and painted position are treated as having met. */
const SETTLE_EPSILON = 0.0002;

/** Under this width we load every Nth frame instead of the full sequence. */
const MOBILE_BREAKPOINT = 768;
const MOBILE_FRAME_STEP = 2;

/** Which frame stands in for the sequence when motion is not wanted. */
const STATIC_FRAME = 1;

/**
 * Whether prefers-reduced-motion collapses the sequence to a single still.
 *
 * Off by default, deliberately. On Windows the preference is set by
 * Settings > Accessibility > Visual effects > Animation effects = Off (and the
 * legacy MinAnimate = 0) — a performance toggle plenty of people flip without
 * ever meaning "show me less motion on the web". Honouring it with a dead still
 * frame turns the feature off for them with no way back, which reads as a
 * broken page rather than as a considered accessibility choice.
 *
 * The preference is not ignored, though: see REDUCED_MOTION_SMOOTHING below.
 * Set this to true to restore the strict single-still behaviour.
 */
const REDUCED_MOTION_SHOWS_STILL = false;

/**
 * The building's share of the frame's width, measured off the renders, and the
 * margin left around it when the sequence is fitted to the subject rather than
 * the frame. GROUND is the render's own background, sampled from frame 001 —
 * it fills whatever the picture does not cover, so the join is invisible.
 */
const SUBJECT_WIDTH = 0.6;
const SUBJECT_MARGIN = 0.94;
const SUBJECT_ANCHOR_Y = 0.4;
/* Sample this from a corner of frame 001 — it must match the render's own
   background or the fallback fill shows as a band. */
const GROUND = '#ec944a';

/* === END OF THE PER-SEQUENCE SETTINGS =================================== */

/** Retina is worth painting; a 3x backing store is not worth the fill cost. */
const MAX_PIXEL_RATIO = 2;

/** The "scroll" hint has faded out by this fraction of the sequence. */
const HINT_FADE_PROGRESS = 0.06;

/** Geometry of the progress indicator shown in 'virtual' mode, in CSS pixels. */
const RAIL_HEIGHT = 160;
const THUMB_HEIGHT = 40;

const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1);

/**
 * Picks the frames to fetch. Decided once on mount: re-deciding on resize would
 * mean throwing away a finished download to start a different one mid-sequence.
 */
function chooseFrames(motionOff: boolean): number[] {
  if (motionOff) return [STATIC_FRAME];

  const step = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    .matches
    ? MOBILE_FRAME_STEP
    : 1;

  const frames: number[] = [];
  for (let n = 1; n <= TOTAL_FRAMES; n += step) frames.push(n);
  return frames;
}

/**
 * Wheel events arrive in three different units depending on browser and device.
 * Normalise them to pixels before they reach the accumulator. Without this,
 * Firefox (which reports lines) runs roughly 16x slower than Chrome.
 */
function wheelDeltaInPixels(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16; // lines
  if (e.deltaMode === 2) return e.deltaY * window.innerHeight; // pages
  return e.deltaY; // already pixels
}

export default function ScrollSequence({ children }: { children?: ReactNode }) {
  // Both read matchMedia, so they must be computed on the client only — a lazy
  // initialiser keeps that work out of the render path and runs it just once.
  // Settable, not fixed: the viewer can opt into the motion from the still.
  const [reduceMotion, setReduceMotion] = useState(
    () =>
      REDUCED_MOTION_SHOWS_STILL &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const frames = useMemo(() => chooseFrames(reduceMotion), [reduceMotion]);

  /**
   * The OS preference itself, independent of whether it collapses the sequence
   * to a still. Used to drop the inertia so nothing drifts after input stops.
   */
  const [prefersReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  /** Enough frames are in to start painting; the rest may still be arriving. */
  const [ready, setReady] = useState(false);
  const [decoded, setDecoded] = useState(0);

  const sectionRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  /** Frames land here as they decode; holes are simply not painted yet. */
  const imagesRef = useRef<HTMLImageElement[]>([]);

  /**
   * Scroll position, held outside the paint effect so that input can move it
   * before the first frame has even decoded. Input that arrives during loading
   * is not thrown away — it is waiting when the picture appears.
   */
  const posRef = useRef({ target: 0, current: 0 });
  /** Set by the paint loop while it is live; input uses it to start the loop. */
  const wakeRef = useRef<(() => void) | null>(null);

  // Reduced motion is a single still, so it never needs the tall container or
  // the input capture, whichever mode is selected.
  const virtual = SCROLL_MODE === 'virtual' && !reduceMotion;

  /* -------------------------------------------------------------------------
   * 'virtual' mode only: stop the page scrolling. Done here rather than in CSS
   * so the component puts the page back exactly as it found it on unmount.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    if (!virtual) return;
    const { overflow, overscrollBehavior } = document.body.style;
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';
    return () => {
      document.body.style.overflow = overflow;
      document.body.style.overscrollBehavior = overscrollBehavior;
    };
  }, [virtual]);

  /* -------------------------------------------------------------------------
   * Preload. Frames are placed as they arrive and the sequence goes live once
   * the opening run is in, so input never waits on the whole 79 MB.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    let settled = 0;

    // The frame set changes if the viewer opts into the motion, so the loader
    // has to come back rather than showing a stale 100%.
    setReady(false);
    setDecoded(0);

    const slots: HTMLImageElement[] = Array.from({ length: frames.length });
    imagesRef.current = slots;

    const threshold = Math.min(FRAMES_BEFORE_START, frames.length);

    frames.forEach((n, i) => {
      const img = new Image();
      img.src = frameSrc(n);

      // decode() keeps the JPEG work off the main thread. A frame that fails to
      // load still counts as settled, otherwise one 404 stalls the sequence.
      img
        .decode()
        .catch(() => undefined)
        .then(() => {
          if (cancelled) return;
          if (img.naturalWidth) slots[i] = img;
          settled += 1;
          setDecoded(settled);
          // Go live as soon as the opening frames are in, so the first scroll
          // has something to move through.
          if (settled >= threshold) setReady(true);
        });
    });

    return () => {
      cancelled = true;
    };
  }, [frames]);

  /* -------------------------------------------------------------------------
   * Input. Deliberately NOT gated on `ready`: listeners go on at mount, so the
   * wheel is live from the first moment rather than after the last decode.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    if (!virtual) return;

    /** Pixels of scrolling that carry the sequence from first frame to last. */
    const travel = () => window.innerHeight * (SCROLL_LENGTH_VH / 100 - 1);

    const advance = (pixels: number) => {
      const t = travel();
      if (t <= 0) return;
      posRef.current.target = clamp01(posRef.current.target + pixels / t);
      wakeRef.current?.();
    };

    // passive: false, because the whole point is to stop the page scrolling.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      advance(wheelDeltaInPixels(e));
    };

    let lastTouchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const y = e.touches[0].clientY;
      // Dragging up advances, as if the finger were pushing a long page upward.
      advance(lastTouchY - y);
      lastTouchY = y;
    };

    // Without a wheel there would be no way through the sequence at all, so the
    // usual scrolling keys have to keep working.
    const onKeyDown = (e: KeyboardEvent) => {
      const screen = window.innerHeight;
      switch (e.key) {
        case 'ArrowDown': advance(screen * 0.15); break;
        case 'ArrowUp': advance(-screen * 0.15); break;
        case 'PageDown':
        case ' ': advance(screen * 0.9); break;
        case 'PageUp': advance(-screen * 0.9); break;
        case 'Home': posRef.current.target = 0; wakeRef.current?.(); break;
        case 'End': posRef.current.target = 1; wakeRef.current?.(); break;
        default: return;
      }
      e.preventDefault();
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [virtual]);

  /* -------------------------------------------------------------------------
   * Easing and painting.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    if (!ready) return;

    const canvas = canvasRef.current;
    const section = sectionRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !section || !ctx) return;

    const images = imagesRef.current;
    const pos = posRef.current;

    /** Index currently on screen; -1 means "whatever is there is stale". */
    let painted = -1;
    let raf = 0;

    const paint = (index: number) => {
      const img = images[index];
      // A frame that has not decoded yet simply holds the previous one rather
      // than blanking the canvas; `painted` is left alone so it repaints later.
      if (!img || !img.naturalWidth) return;

      // CSS pixels — ctx is already scaled by the device pixel ratio in resize().
      const vw = canvas.clientWidth;
      const vh = canvas.clientHeight;

      const iw = img.naturalWidth;
      const ih = img.naturalHeight;

      // Fit to the SUBJECT, not to the frame. The building occupies only the
      // middle SUBJECT_WIDTH of a 16:9 render, so cover-fitting a phone's tall
      // viewport crops it to a strip of façade. Aiming instead to land the
      // building across the width keeps the whole thing visible, and the extra
      // space fills with the render's own ground colour so no seam shows.
      const cover = Math.max(vw / iw, vh / ih);
      const contain = Math.min(vw / iw, vh / ih);
      const toSubject = (vw * SUBJECT_MARGIN) / (iw * SUBJECT_WIDTH);
      // Never zoom past cover, never shrink below contain. On a wide desktop
      // this resolves to plain cover-fit; only narrow viewports pull it back.
      const scale = Math.min(cover, Math.max(contain, toSubject));

      const w = iw * scale;
      const h = ih * scale;
      // Slack above the picture is smaller than slack below, so the building
      // sits a little high and leaves the lower band to the headline.
      const y = h < vh ? (vh - h) * SUBJECT_ANCHOR_Y : (vh - h) / 2;

      const x = (vw - w) / 2;

      // A flat fill under the picture is only a backstop for odd ratios; the
      // render's ground is gently vignetted, so a flat colour leaves a visible
      // line where it meets the image. The gaps are filled instead by stretching
      // the picture's own top and bottom rows into them — its exact pixels, so
      // there is no seam to see.
      ctx.fillStyle = GROUND;
      ctx.fillRect(0, 0, vw, vh);

      if (y > 0) ctx.drawImage(img, 0, 0, iw, 2, x, 0, w, y);
      const bottom = y + h;
      if (bottom < vh) {
        ctx.drawImage(img, 0, ih - 2, iw, 2, x, bottom, w, vh - bottom);
      }

      ctx.drawImage(img, x, y, w, h);
      painted = index;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      // The canvas is sized by CSS; the backing store follows it at dpr, so the
      // image stays sharp while the drawing code keeps working in CSS pixels.
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Setting width/height wipes the canvas, so the current frame has to be
      // laid down again even though its index did not change. Progress is held
      // as a fraction, so nothing needs rescaling here.
      const frame = painted < 0 ? 0 : painted;
      painted = -1;
      paint(frame);
    };

    resize();
    window.addEventListener('resize', resize);

    // Reduced motion: one frame, painted once. No easing, no loop.
    if (reduceMotion) {
      return () => window.removeEventListener('resize', resize);
    }

    // Honour the preference by removing the glide, not the sequence.
    const smoothing = prefersReduced ? REDUCED_MOTION_SMOOTHING : SMOOTHING;

    const travel = () => window.innerHeight * (SCROLL_LENGTH_VH / 100 - 1);

    /**
     * 'page' mode: read the target straight off the page's scroll position.
     * -top is how far into the container we have scrolled — 0 when its top edge
     * meets the top of the viewport, `travel` when the sticky canvas lets go.
     */
    const targetFromPageScroll = () => {
      const t = travel();
      if (t <= 0) return 0;
      return clamp01(-section.getBoundingClientRect().top / t);
    };

    const tick = () => {
      if (!virtual) pos.target = targetFromPageScroll();

      // Ease toward the target rather than snapping to it. Momentum in, glide
      // out — this is what makes it read as motion rather than as a filmstrip.
      pos.current += (pos.target - pos.current) * smoothing;
      if (Math.abs(pos.target - pos.current) < SETTLE_EPSILON) {
        pos.current = pos.target;
      }

      // Progress -> frame index. Change this line to change the curve:
      // pos.current * pos.current, for instance, starts slow and accelerates.
      const next = Math.round(pos.current * (images.length - 1));
      if (next !== painted) paint(next); // the only-repaint-on-change guard

      // Hint and indicator follow the eased position continuously, written
      // straight to the DOM so they cost no React re-renders.
      if (hintRef.current) {
        hintRef.current.style.opacity = String(
          Math.max(0, 1 - pos.current / HINT_FADE_PROGRESS),
        );
      }
      if (thumbRef.current) {
        const y = pos.current * (RAIL_HEIGHT - THUMB_HEIGHT);
        thumbRef.current.style.transform = `translateY(${y}px)`;
      }

      // 'virtual' idles out once the picture has caught up, and input wakes it.
      // 'page' keeps running while the section is on screen, because the scroll
      // position it reads can change at any moment without notifying us.
      raf =
        virtual && pos.current === pos.target ? 0 : requestAnimationFrame(tick);
    };

    const wake = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    // Hand the loop to the input effect, which may have been waiting on it.
    wakeRef.current = wake;

    let observer: IntersectionObserver | undefined;
    if (virtual) {
      wake(); // paint the first frame and settle the indicator
    } else {
      // Scroll events fire far more often than the screen refreshes, so they
      // never draw. The rAF loop owns every paint and runs only while the
      // section is on screen.
      observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            wake();
          } else if (raf) {
            cancelAnimationFrame(raf);
            raf = 0;
          }
        },
        { rootMargin: '100px' },
      );
      observer.observe(section);
    }

    return () => {
      wakeRef.current = null;
      observer?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [ready, reduceMotion, virtual, prefersReduced]);

  // Frames keep arriving after the sequence goes live, so the readout tracks
  // the background load rather than gating it.
  const percent = Math.round((decoded / frames.length) * 100);

  return (
    <div
      ref={sectionRef}
      // 'virtual': fixed to the viewport, with touch handling taken over.
      // 'page': a tall container the page scrolls through.
      className={
        virtual
          ? 'bg-orange fixed inset-0 touch-none overflow-hidden'
          : 'relative'
      }
      style={
        virtual
          ? undefined
          : { height: reduceMotion ? '100vh' : `${SCROLL_LENGTH_VH}vh` }
      }
    >
      <div
        className={
          virtual
            ? 'h-full w-full'
            : 'bg-orange sticky top-0 h-screen w-full overflow-hidden'
        }
      >
        <canvas ref={canvasRef} className="block h-full w-full" />

        {/* Anything the hero wants to lay over the sequence, inside the pinned
            layer so it holds still with the picture rather than scrolling off. */}
        {children}

        {/* Reduced motion is honoured by default, but a still frame that ignores
            every input is indistinguishable from a broken page. Say why, and
            offer the motion to anyone who actually wants it. */}
        {ready && reduceMotion && (
          <div className="absolute inset-x-0 bottom-8 flex flex-col items-center gap-3 px-6 text-center">
            <p className="text-ink/70 text-sm">
              Reduced motion is on, so this is showing a single frame.
            </p>
            <button
              type="button"
              onClick={() => setReduceMotion(false)}
              className="border-ink/40 text-ink hover:bg-ink hover:text-orange border px-5 py-2 text-sm transition-colors"
            >
              Play the sequence
            </button>
          </div>
        )}

        {ready && !reduceMotion && (
          <div
            ref={hintRef}
            className="pointer-events-none absolute inset-x-0 bottom-10 flex justify-center"
          >
            <span className="text-ink/55 text-sm">Keep scrolling</span>
          </div>
        )}

        {/* Only in 'virtual' mode — in 'page' mode the browser's own scrollbar
            already tells the viewer where they are. */}
        {ready && virtual && (
          <div
            className="pointer-events-none absolute top-1/2 right-5 w-px -translate-y-1/2 overflow-hidden bg-white/20 mix-blend-difference"
            style={{ height: RAIL_HEIGHT }}
            aria-hidden="true"
          >
            <div
              ref={thumbRef}
              className="w-px bg-white"
              style={{ height: THUMB_HEIGHT }}
            />
          </div>
        )}

        {/* A 1px rail in #6b6b6b on near-black is indistinguishable from a dead
            page, which is exactly how this read while the frames downloaded.
            It is now unambiguously a loading screen: big readable count, a bar
            with real presence, and a pulse so it is visibly alive even at 0%. */}
        {!ready && (
          <div
            className="bg-orange absolute inset-0 flex flex-col items-center justify-center gap-5"
            role="status"
            aria-live="polite"
          >
            <p className="t-figure text-ink text-6xl">{percent}%</p>
            <div className="bg-ink/20 h-[3px] w-64 max-w-[70vw] overflow-hidden">
              <div
                className="bg-ink h-full transition-[width] duration-200 ease-out"
                style={{ width: `${Math.max(percent, 2)}%` }}
              />
            </div>
            <p className="text-ink/60 animate-pulse text-sm tabular-nums">
              Loading {decoded} of {frames.length} frames
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Tuning
 *
 * Too fast — the sequence runs out after one flick of the wheel:
 *   raise SCROLL_LENGTH_VH (500-600vh). More scrolling spent per frame.
 *
 * Too slow — you scroll and scroll and the building barely moves:
 *   lower SCROLL_LENGTH_VH (250-300vh). Less scrolling spent per frame.
 *
 * Feels laggy or swimmy after you stop:
 *   raise SMOOTHING toward 0.25, or to 1 to remove the easing entirely.
 *   Feels abrupt and mechanical: lower it to 0.08.
 *
 * Rough rule: the sequence costs (SCROLL_LENGTH_VH / 100 - 1) screens of
 * scrolling, whatever the frame count. 400vh = 3 screens for all 90 frames.
 * ------------------------------------------------------------------------- */
