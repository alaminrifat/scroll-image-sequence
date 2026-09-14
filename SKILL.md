---
name: scroll-image-sequence
description: Build a scroll-linked image sequence — a canvas animation where scroll position steps through preloaded frames, frame 0 to frame N, the way Apple's product pages reveal hardware. Use when the user asks for a scroll-driven or scroll-scrubbed image sequence, a frame-by-frame animation tied to scroll, an exploded or rotating product reveal, a pinned hero that animates as you scroll through it, or says "like Apple does it".
license: MIT-0
---

# Scroll-linked image sequence

A tall container, a sticky full-screen canvas, and a folder of frames. Scroll
position maps to a frame index; a `requestAnimationFrame` loop paints, and only
when the index actually changes.

The mechanism is easy. **Everything that goes wrong with it is invisible in the
code and looks identical to a dead page.** Read the failure modes before you
write anything — they are the whole reason this skill exists.

## Working implementation

[reference/ScrollSequence.tsx](reference/ScrollSequence.tsx) is a complete,
production-tested React + TypeScript component. Copy it, set the constants in
the marked block at the top, and it works. It handles both scroll modes,
preload, resize, mobile framing, and reduced motion.

[reference/optimise-frames.py](reference/optimise-frames.py) is the asset
pipeline. **Run it before building anything** — see failure mode 1.

## The five failure modes

Every one of these presents as "I scroll and nothing happens." None of them is
a bug in the scroll code. When a user reports that, work this list in order
instead of rewriting the mapping.

### 1. The frames are too heavy

Source renders are typically 1920×1080 at ~900 KB. Ninety of those is **~80 MB
of download and ~750 MB of decoded bitmap.** The page sits on a loading screen
for a minute, which is indistinguishable from broken.

Resize to 1600×900 at quality ~72 first: ~106 KB a frame, under 10 MB for the
sequence, no visible loss at the size a cover-fit canvas paints. Measured on
this technique: interactive in **1.7 s at 30 Mbps** instead of over a minute.

```
python optimise-frames.py     # writes public/frames/ from your originals
```

Keep the originals. Serve the optimised set.

### 2. `prefers-reduced-motion` is on and nobody knows

**This is the one that will cost you an afternoon.** On Windows,
`Settings → Accessibility → Visual effects → Animation effects = Off` sets
`prefers-reduced-motion: reduce`. It is a *performance* toggle; people flip it
without any thought about web animation. The registry tell is
`HKCU\Control Panel\Desktop\WindowMetrics\MinAnimate = 0`.

If you honour it by collapsing to a single still with no input listeners, those
users get a frozen image that ignores mouse and keyboard — and they will report
it as a broken scroll, repeatedly, while every test you run passes. Headless
browsers default to `no-preference`, so **your tests will never catch this.**

Check it on the user's machine before debugging anything else:

```js
matchMedia('(prefers-reduced-motion: reduce)').matches
```

The reference component defaults to `REDUCED_MOTION_SHOWS_STILL = false` and
honours the preference by removing the *inertia* instead
(`REDUCED_MOTION_SMOOTHING = 1`), so the frame tracks input exactly and nothing
drifts after you stop. The sequence still works; the unrequested movement is
what goes. That is the part of the effect the preference is actually about.

If a brief explicitly requires a single static frame, set the flag to `true` —
but then put a visible caption and a control on the still, never a bare frozen
image.

### 3. Input is gated on the preload finishing

If listeners are attached inside an effect that early-returns until every frame
has decoded, then scrolling does **literally nothing** for the whole load. Tens
of seconds of a page that ignores you.

Attach input at mount, keep scroll position in a ref outside the paint effect,
and go live after a dozen frames while the rest stream in. A frame that has not
decoded yet holds the previous one rather than blanking the canvas.

### 4. The loading state is invisible

A 1px rail in mid-grey on a near-black ground, 3% filled, is about five pixels
of dim colour. It reads as a dead page. Give the loader a large percentage, a
bar with real presence, a live frame count, and a minimum visible fill at 0%.

### 5. The hero is below the fold

If the sequence sits under a full-height intro section, the first thing on
screen is empty background and the animation never appears to exist. Put the
sequence first, or confirm the canvas is at `top: 0` on load.

## Choosing the scroll mode

The reference component has one constant that decides this. **Get it right
first; it is the difference between a working page and a trapped one.**

| | `'page'` | `'virtual'` |
|---|---|---|
| Page scrolls | yes | no |
| Mechanism | 400vh container, sticky canvas | fixed canvas, wheel/touch/keys captured |
| Content below reachable | yes | **no** |
| Scrollbar, find-in-page, screen readers | work normally | broken |

**Use `'page'` whenever the sequence is a section of a longer page** — a hero
with anything under it. `'virtual'` locks the document, so nothing below it can
ever be reached.

Only use `'virtual'` when the sequence is the entire page. It costs real
scrolling, so add keyboard handling (arrows, PageUp/PageDown, space, Home, End)
or there is no way through the sequence without a wheel.

## The parts that matter

**Scroll never draws.** Scroll events fire far more often than the screen
refreshes. A rAF loop owns every paint:

```js
const tick = () => {
  if (!virtual) pos.target = targetFromPageScroll();
  pos.current += (pos.target - pos.current) * smoothing;   // ease, don't snap
  const next = Math.round(pos.current * (images.length - 1));
  if (next !== painted) paint(next);        // the only-repaint-on-change guard
  raf = virtual && pos.current === pos.target ? 0 : requestAnimationFrame(tick);
};
```

**Progress is a 0–1 fraction, never pixels.** Store the fraction and recompute
the pixel distance from the current viewport height, and resizing can't jump the
animation.

**Two positions, not one.** `target` is where input asked to be; `current` eases
toward it. That gap is what makes it read as motion rather than a filmstrip.
`SMOOTHING = 1` removes it entirely.

**Resize wipes the canvas.** Setting `canvas.width` clears it, so the current
frame must be repainted even though its index did not change — set
`painted = -1` before repainting or the change-guard suppresses it.

**Fit to the subject, not the frame.** A 16:9 render on a phone's 1:2 viewport
cover-fits into a strip of façade. The subject usually occupies only the middle
~60% of the frame, so scale to land *that* across the width:

```js
const cover   = Math.max(vw / iw, vh / ih);
const contain = Math.min(vw / iw, vh / ih);
const toSubject = (vw * SUBJECT_MARGIN) / (iw * SUBJECT_WIDTH);
const scale = Math.min(cover, Math.max(contain, toSubject));
```

On a wide desktop this resolves to plain cover-fit; only narrow viewports pull
it back. Fill the resulting gaps by stretching the image's **own edge rows** into
them — a flat colour leaves a visible band wherever the render is vignetted:

```js
if (y > 0) ctx.drawImage(img, 0, 0, iw, 2, x, 0, w, y);
const bottom = y + h;
if (bottom < vh) ctx.drawImage(img, 0, ih - 2, iw, 2, x, bottom, w, vh - bottom);
```

**Overlaid text needs a scrim in the render's own ground colour.** The subject
sits in the middle of every frame, so a headline across it is unreadable. A
gradient from the exact background colour settles the lower third into flat
ground — the subject appears to stand in it rather than be covered by a box.

## Tuning

Two constants, both at the top of the component:

- `SCROLL_LENGTH_VH` (400) — the sequence costs `(SCROLL_LENGTH_VH / 100 − 1)`
  screens of scrolling whatever the frame count. Raise for slower, lower for
  faster. Below ~200vh frames visibly skip.
- `SMOOTHING` (0.14) — raise toward 0.25 if it feels laggy after you stop, drop
  to 0.08 for a heavier glide, `1` for none.

For a different easing curve, change the one mapping line: `pos.current ** 2`
starts slow and accelerates.

## Verify it properly

Headless checks pass while the real browser fails, so test the things that
actually break. Do not just confirm it builds.

- **Run it with `reducedMotion: 'reduce'`** — this is the check everyone skips
  and it is where the bug lives.
- Fingerprint canvas pixels at several scroll positions; assert distinct frames.
- Scroll back up and assert the earlier frame's hash returns **exactly**.
- Assert `scrollHeight > innerHeight` in `'page'` mode; assert content below the
  hero is reachable.
- Throttle the network and confirm input works **before** the load completes.
- Resize and assert the canvas repainted at the new backing size.
- Check a 390px viewport: no horizontal overflow, whole subject visible.

```js
const hash = (p) => p.evaluate(() => {
  const c = document.querySelector('canvas');
  const d = c.getContext('2d').getImageData(0, 0, 300, 1).data;
  let h = 0; for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) >>> 0;
  return h;
});
```

## When not to use this

A frame sequence is a large amount of bandwidth for a linear animation. Prefer
it when the motion must be scrubbable and frame-accurate and the source is
rendered stills. If the content is a straight linear playback, a muted inline
video is smaller and simpler. If the motion is geometric rather than
photographic, CSS or SVG will be sharper at every size and a fraction of the
weight.

## License

MIT-0 (MIT No Attribution) — see [LICENSE](LICENSE). Use it, change it, ship it
commercially, no attribution required. A credit back to the original author is
appreciated but never demanded.
