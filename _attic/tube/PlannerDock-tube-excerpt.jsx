// EXCERPT, not a module. The two blocks that drew the planner's tube, lifted
// out of modules/core/planner/PlannerDock.jsx on 2026-09-20 exactly as they
// stood. Nothing imports this file and it will not compile on its own - it is
// here so the pour can be put back by hand without reading a diff.
//
// Block 1 went where `toggleCalendar` is defined, and Block 2 last inside the
// dock's returned tree, after the calendar's closing </div>. Both depend on
// things that also left: `tube.js` (buildTube, tubeSpans), the refs waterRef /
// tweenRef / tubeRef / mouthRef / pointRef, the constants SPOUT_GAP /
// SPOUT_JOIN / WATER_W, `parseBezier`, `pourR` and `tubeGlowOn`.
//
// ═══ BLOCK 1 — the pour machinery (was just below the calendar's avail state)

  // ── The tube (Ribbon Pour revision, 2026-09-09) ────────────────────
  // The strip is a TUBE. One closed circuit drawn as a single stroke: a ring
  // round the dial, down the right spout, round the open calendar, back up the
  // left spout to where it started. Clicking pours it open; clicking again
  // carries the liquid the rest of the way round. No day blocks and no now-mark
  // any more - the rows below ARE the day, and the tube is just the lid opening.
  //
  // ONE number drives it: `m`, how far the pour has got (0 shut, 1 poured). The
  // shared `tubeSpans` still accepts 0..2 for the dev toy, which runs the circuit
  // continuously; this surface only ever sends 0..1. And `m` is not a clock of
  // its own - it is the calendar body's MEASURED openness, so the only timing in
  // this animation is the max-height transition already on
  // `.planner-calendar-body`. Retime that in CSS and the tube follows for free,
  // and it can never disagree with the thing it is wrapping.
  // The LIQUID's own progress, 0..1, which is not the calendar's while a hand is
  // moving. Lives in a ref so it survives the effect being torn down and rebuilt on
  // every toggle - the water is mid-air at that moment and must not snap.
  const waterRef = useRef(0);
  // Where the liquid is HEADED, and the run it is making to get there: the value it
  // set out from and when. Only a pointer move re-aims it, so a hand that stops or
  // leaves the widget leaves `to` standing and the front holds that spot instead of
  // falling back to the calendar's own number (user-directed 2026-09-09). Also a ref
  // for the same reason `waterRef` is: a toggle tears the loop down mid-flight.
  //
  // `phase` is the OPENING RUN. An open used to aim the liquid at the foot of the pipe
  // flat out, and the first pointer move after it landed re-aimed the front with a
  // ZERO-length run - a teleport back up to the hand, which is the "goes all the way
  // down then jumps back" this replaced. A throw past the hand replaced that in turn
  // (2026-09-13) and was itself removed (2026-09-20). What is left is ONE leg: `settle`,
  // straight to wherever the hand is, on the calendar's own clock. It RE-READS the hand
  // every frame, so a moving hand bends the run instead of cancelling it; once it lands
  // the phase goes `free` and the hand writes the front directly again. A close is
  // `free` from the start - it has one place to go.
  const tweenRef = useRef({ from: 0, to: 0, t0: 0, ms: 0, ease: (x) => x, phase: 'free', aim: 0 });
  const grooveRef = useRef(null);   // ring 3 on the dial: the top ring's ruler
  const tubeRef = useRef([]);       // [top ring, laid wall, liquid, hit target]
  // An ARRAY ref, and the callbacks below re-seed it: Fast Refresh keeps the ref
  // object across an edit, so when this changed shape from a single element to a
  // list the preserved `.current` was still the old detached null and the first
  // callback threw "Cannot set properties of null" straight into the crash screen.
  const mouthRef = useRef([]);      // the slab that hugs the tube, one per laid span
  const outerR = useWidgetCorner(dockRef);

  // The static half of the overlay's geometry, MEASURED off the groove rather
  // than summed from insets: x, width, the home top/bottom, and the perimeter the
  // two dash floors are honest pixels against. Re-read whenever the tile resizes.
  const [home, setHome] = useState(null);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const groove = grooveRef.current;
    if (!dock || !groove) return undefined;
    const measure = () => {
      const d = dock.getBoundingClientRect();
      const g = groove.getBoundingClientRect();
      if (!g.width || !g.height) return;
      // The groove's box IS its path centre - no stroke correction, and NOT
      // because SVG works that way in general. It stopped painting on 2026-09-09
      // (the tube's wall replaced it) and a stroke at `transparent` is dropped from
      // getBoundingClientRect, so the box shrank by half a stroke on every side the
      // moment the colour went. The old `+ RIBBON_W / 2` was correct while the ring
      // was visible and silently wrong afterwards: it drew the tube's top ring 5.57
      // px narrower than the ring it replaced, and handed the same error on to the
      // calendar's margin. Proven, not reasoned: the path's own `d` starts at
      // 12.585 = RING_EDGE_GAP + RIBBON_W / 2, and getBBox().x and
      // getBoundingClientRect() BOTH read 12.6.
      const next = {
        x: g.left - d.left,
        w: g.width,
        top: g.top - d.top,
        bottom: g.bottom - d.top,
      };
      // NB the planned shortcut - "the dial's ring and the calendar are already on
      // the same x, so the pour needs no sideways travel" - is FALSE, and the live
      // rects said so on the first probe: the groove paints 1168.8..1412.6 while
      // the calendar body spans 1166..1415, about 2.6px out on each side. The two
      // 11px margins are taken from different references. So x and width are
      // interpolated between two MEASURED ends like everything else, and the
      // discrepancy costs one lerp instead of a misalignment nobody would spot.
      // The band the clock's plate carries ABOVE it, handed to the calendar BELOW
      // it so both ends of the dial read the same. MEASURED off the painted plate
      // and the calendar's own clip, never summed from the dial's constants: those
      // do not know about the pixel between the widget's edge and the dial's box,
      // and building it from them came out 1.2px short (photographed 2026-09-09).
      // Three real distances - the plate's own top band, the half stroke the frame
      // is centred by, and however far the clip's edge was pulled up onto the
      // plate by the dial's -RING_EDGE_GAP margin.
      const plate = dock.querySelector('rect[fill*="planner-face"]');
      const clip = calBodyRef.current;
      if (plate && clip) {
        const pr = plate.getBoundingClientRect();
        const cr = clip.getBoundingClientRect();
        // Two real distances, not three. The half stroke that used to be added here
        // paid for a frame CENTRED on the panel's top edge, which poked RIBBON_W / 2
        // above it. Since the frame became inset from the slab by its proud edge
        // (2026-09-09) nothing pokes, and the term was pure excess: the face showed
        // 7.1px between the two slabs against 4.3px everywhere round the outside -
        // read off the pixels, not the DOM, because the outer band is part tile
        // frame and the rects alone call it even when the eye does not.
        next.calGap = (pr.top - d.top) + (pr.bottom - cr.top);
        // WHERE THE WIDGET'S EDGE ACTUALLY IS, read off the clock's slab. The
        // calendar's slab is given the same inset (see the CSS var below), which
        // does two things at once: the two slabs finally line up on one straight
        // edge, and the grey shows round the calendar's frame by the same 5.8px it
        // shows round the dial's ring - WITHOUT moving the frame, which is the wrong
        // half of the problem to solve (user-directed 2026-09-09: insetting the
        // frame instead just made the calendar smaller).
        // Measured against the body's own containing block, because that is what a
        // margin on it is relative to. Nothing here reads the calendar's width, so
        // widening it cannot feed back into this.
        const host = clip.parentElement;
        if (host) next.slabInset = pr.left - host.getBoundingClientRect().left;
        // ...and how far that slab stands PROUD of the ring drawn on it. The
        // calendar's frame is inset from its own slab by the same amount, so the
        // grey shows round the frame exactly as it shows round the ring. The two
        // together are what leave the calendar's outline where it always was: the
        // slab grew outward by 3px and the frame moved inward by 3px, so the frame
        // lands back on its original line with a real margin outside it.
        next.proud = next.x - (pr.left - d.left);
      }
      setHome((prev) => (prev && Object.keys(next).every(k => prev[k] === next[k]) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(dock);
    ro.observe(groove);
    return () => ro.disconnect();
  }, []);

  // The corner. `cornerAt` returns the tile's own painted radius FLAT (the SAME
  // rule, corners.js) - the depth argument is carried but ignored, which is why
  // the strip is exactly as round wrapping the calendar as it was wrapping the
  // dial, and why the pour has no radius to interpolate. Passing 0 here rather
  // than restating the dial's depth keeps this honest: if corners.js ever swaps to
  // NESTED, the two ends of the pour must be re-derived deliberately, not silently
  // inherit a depth that stopped being true the moment the strip left the dial.
  const pourR = strokedCornerAt(outerR, 0, RIBBON_W);

  // The liquid glows exactly as the dial's session arc does (user-directed
  // 2026-09-09), off the SAME switch - the one animation setting that turns the
  // clock's ambient light off turns the tube's off with it. Its own filter id
  // rather than the dial's `dualRectGlow`: that one only exists while DualRingRect
  // is the mounted watchface, and a filter reference to a missing id paints nothing.
  const tubeGlowOn = settings.animations?.['clock-ambient'] !== false;

  useEffect(() => {
    const dock = dockRef.current;
    const body = calBodyRef.current;
    const panel = calPanelRef.current;
    if (!dock || !body || !panel || !home || !avail) return undefined;

    let raf = 0;
    let seeded = false;
    // The liquid travels on THE CALENDAR'S OWN transition (user-directed 2026-09-09:
    // "the app's default smooth animation"). Read off the panel rather than typed in,
    // so retiming that one CSS line retimes the pipe and the liquid together - the
    // pipe already follows it, being the panel's measured height. Reduced motion sets
    // `transition: none`, which lands here as a 0ms run: the front simply arrives.
    const clock = getComputedStyle(body);
    const tweenMs = (parseFloat(clock.transitionDuration) || 0) * 1000;
    const tweenBez = parseBezier(clock.transitionTimingFunction);
    // Shared with the click handler (see `pointRef`), so the position the calendar
    // was opened AT survives into this loop. Cleared of any stale `fresh` on mount:
    // a move that arrived before the toggle is not a steer of this pour.
    const pointer = pointRef.current;
    pointer.fresh = false;
    const frame = () => {
      const d = dock.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      // Measured openness. The CSS transition has already eased it - nothing here
      // re-eases, or the curve would be applied twice.
      // Shut is 0, poured is 1, and the same measured number runs it both ways -
      // the close is the open played backwards. That is the whole driver.
      const m = Math.min(1, Math.max(0, b.height / avail));

      // BOTH RINGS ARE MEASURED every frame. The top one off the dial's groove,
      // the bottom one off the calendar's inner PANEL - the panel, not the outer
      // clip, because the clip's edge is pulled up onto the clock's plate by the
      // dial's own -RING_EDGE_GAP margin. Half a stroke comes off each side of
      // both: getBoundingClientRect spans the PAINTED outer edge, and these rects
      // are the path's centre line.
      const pb = panel.getBoundingClientRect();
      const top = { x: home.x, y: home.top, w: home.w, h: home.bottom - home.top };
      // Inset by the slab's own proud edge (measured, see the home effect), not by
      // half a stroke - that left a 2.8px margin, which read as none at all.
      const proud = home.proud ?? RIBBON_W / 2;
      const bot = {
        x: pb.left + proud - d.left,
        y: pb.top + proud - d.top,
        w: Math.max(0, pb.width - 2 * proud),
        h: Math.max(0, pb.height - 2 * proud),
      };
      const geom = buildTube({
        top, bot, rad: pourR, spout: SPOUT_GAP * scale, join: SPOUT_JOIN * scale,
      });
      // THE BACKING, and it HUGS THE TUBE (user-directed 2026-09-09). Earlier
      // passes filled the band between the clock and the calendar with a rect -
      // first spout-wide, which left the slabs' rounded corners unbacked, then
      // slab-wide, which backed them by filling the whole band solid. Neither is
      // what the shape wants: the slab follows the pipe, it does not box it in.
      //
      // So it is the tube's OWN path, stroked at twice the slab's proud edge. A
      // stroke straddles its path, so an outer edge exactly `proud` out from the
      // pipe's centre line falls out for free - the same edge the plate already
      // has round the clock, now carried round every bend. Round caps and joins
      // give the pipe's own rounded ends that margin too.
      //
      // Dashed in step with the two strokes it backs, never drawn whole: the
      // circuit exists as a shape before the tube is laid along it (collapsed, it
      // is a squashed loop under the clock), and an undashed backing would paint
      // that as a dark blob with no pipe on it.
      for (const el of mouthRef.current) el?.setAttribute('stroke-width', String(2 * proud));

      // THE FRONT CHASES THE POINTER (user-directed 2026-09-09). The pipe above
      // follows the calendar's own eased height; the liquid gets a second number.
      // Where the pointer is on the tube is PROJECTED onto the path that is about to
      // be painted - the `d` is written here first, before it is read - rather than
      // inferred from the panel's height or from where the click landed. Turning that
      // into progress uses the same reach the pour itself measures, so the pointer's
      // place and the liquid's place can never be computed against different tubes.
      const hitPath = tubeRef.current[3];
      hitPath?.setAttribute('d', geom.d);
      const mouthRun = geom.fDown + geom.fBot / 2;
      const tw = tweenRef.current;
      const now = performance.now();
      if (!seeded) {
        seeded = true;
        // Every toggle rebuilds this loop, and a toggle is a destination of its own.
        // An OPEN sets off on `settle` and lets the block below aim it, every frame, at
        // whatever the hand is doing; a CLOSE has one place to go and goes there. Either
        // way a hand that never moves gets a complete journey, and both run on the
        // calendar's own clock and curve - there is no separate throw any more.
        tw.phase = calendarCollapsed ? 'free' : 'settle';
        tw.from = waterRef.current;
        tw.to = calendarCollapsed ? 0 : waterRef.current;
        tw.t0 = now;
        tw.ms = tweenMs;
        tw.ease = (x) => bezierEase(tweenBez, x);
        // A widget that was already at rest when this effect mounted starts with the
        // water where the pipe is; without it the first frame would haul the front
        // home from nothing. Mid-pour (a toggle) it deliberately does NOT snap.
        // No slingshot for a widget that was ALREADY open when this mounted (a reload,
        // a Fast Refresh, the sidebar coming back): nothing was clicked, so there is
        // no throw to make and the front just sits where the pipe is.
        if (Math.abs(m - (calendarCollapsed ? 0 : 1)) < 0.001) {
          waterRef.current = m;
          tw.from = m;
          tw.to = m;
          tw.phase = 'free';
        }
      }
      if (!calendarCollapsed && mouthRun > 0) {
        // ONE number serves both slugs because they move together: `fTop` is the right
        // mouth and runs forward, 0 is the left mouth and runs backward toward 1, and
        // the two branches are mirrors, so the right one is asked and the left follows.
        //
        // ONE RATE, WHOLE CIRCUIT (user-directed 2026-09-12). The hand's travel maps
        // EVENLY onto the pipe's own arc length - the same pipe-pixels per hand-pixel
        // on the drop, on the calendar's sides, and on the two flat stretches in the
        // band between the clock and the calendar. Nothing speeds up anywhere.
        //
        // It is NOT centred on the hand, and that is the accepted trade (user-directed
        // 2026-09-12, "go back to when it was off center but even movement"). Three
        // mappings that chased centring were tried and all three failed on the same
        // geometry. A pure HEIGHT search TELEPORTS: the circuit has two LEVEL stretches
        // (the ring's bottom edge, the calendar's top edge), each ~94px of pipe at ONE
        // y - measured and photographed 2026-09-11 at 94px of pipe per 3px of hand. A
        // HYBRID of height and a solved share of the pipe killed the teleport and
        // bought it back as a hand-coupled fast sweep across those same stretches. A
        // height search with the crossing put on a CLOCK instead lagged the hand.
        // Evenness is what survived all three.
        //
        // So the rate is LEAST-SQUARES FITTED to the slug middle's own height, every
        // move, off the live path. Sample where the middle actually sits at N evenly
        // spaced points of the pour, fit ONE straight line through those heights, and
        // invert it. The line's slope is a single pipe-per-pixel rate, so evenness is
        // untouched; what changes is that the line is the best straight answer to a
        // curve that bulges rather than a chord pinned to a corner of the bounding box
        // the middle never visits. The residual error now STRADDLES the hand - a little
        // high near the top, a little low near the bottom - instead of sitting above it
        // everywhere, which is the whole of the "off centre, too high" complaint.
        //
        // Every input is measured here: the heights come from the path that was written
        // this frame, so the calendar's easing height moves the fit with it.
        // Both ends are still measured off the live path every move: the top of the
        // tube's own box is the liquid home, the slug middle's foot at full pour is
        // the far end, and the calendar's height moves both because the box and the
        // path are re-read here.
        const len = hitPath.getTotalLength() || 1;
        const midHome = 0.75 * geom.fTop;
        const bb = hitPath.getBBox();
        const foot = hitPath.getPointAtLength((midHome + mouthRun) * len).y;
        const hand = Math.max(1, foot - bb.y);
        // Asked EVERY FRAME, not only when a move arrives: the slingshot's two legs
        // re-aim off it continuously, and the calendar's own height is still growing
        // under the hand while they run, so the same hand is a different place on the
        // pipe from one frame to the next.
        tw.aim = Math.min(1, Math.max(0, (pointer.y - d.top - bb.y) / hand));
        if (tw.phase === 'free' && pointer.fresh) {
          // A hand ARRIVING gets a run; a hand STEERING gets the front written straight
          // to it. Both go through the same tween - the steering case is a zero-length
          // one, which arrives on the frame it starts - so there is one code path here,
          // for this, for the toggle, and for the catch-up.
          const back = pointer.back;
          pointer.back = false;
          tw.phase = back ? 'settle' : 'free';
          tw.from = back ? waterRef.current : tw.aim;
          tw.to = tw.aim;
          tw.t0 = now;
          tw.ms = back ? tweenMs * SLING_CATCH : 0;
          tw.ease = (x) => bezierEase(tweenBez, x);
        } else if (tw.phase === 'settle') {
          // Only the DESTINATION moves - `from`, `t0` and `ms` stand - so a hand moving
          // mid-run bends the travel rather than cancelling it.
          tw.to = tw.aim;
        }
        pointer.fresh = false;
      }
      // The run itself, on the calendar's curve. Clamped to the pipe every frame: a
      // destination further down the tube than the pipe has been laid is simply the
      // pipe's own front until the pipe gets there, which is also what makes a pour
      // with no hand on it look exactly as it did before any of this existed.
      const p = tw.ms > 0 ? Math.min(1, (now - tw.t0) / tw.ms) : 1;
      waterRef.current = Math.min(m, tw.from + (tw.to - tw.from) * tw.ease(p));
      // A landed leg hands over to the next one. `from` is WHERE THE WATER ACTUALLY IS,
      // read back off the line above rather than assumed to be the leg's target: the
      // clamp to the pipe may have held it short, and starting the return from a place
      // the front never reached is the one way to put a jump back into this.
      if (p >= 1 && tw.phase !== 'free') {
        tw.phase = 'free';
        tw.from = waterRef.current;
        tw.t0 = now;
        tw.ms = 0;                                     // the hand writes the front directly now
        tw.ease = (x) => bezierEase(tweenBez, x);
      }

      const { wallFrom, wallTo, tail, head, tailL, headL } = tubeSpans(m, geom, waterRef.current);
      const run = Math.max(0, head - tail);
      for (const el of tubeRef.current) el?.setAttribute('d', geom.d);
      const [ring, wall, water, , waterL, glow, glowL] = tubeRef.current;
      // pathLength=1, so every number above is already a fraction of the whole
      // circuit. The top ring's pattern deliberately does NOT sum to 1 - it reads
      // "draw the first fTop, then a gap too long to repeat". The other two DO,
      // so a run of liquid crossing the end of the path reappears at the start
      // instead of being clipped there, which is what the second half of the lap
      // rides on.
      const [ringBack, wallBack] = mouthRef.current;
      for (const el of mouthRef.current) el?.setAttribute('d', geom.d);
      ringBack?.setAttribute('stroke-dasharray', `${geom.fTop} 1`);
      wallBack?.setAttribute('stroke-dasharray', `${wallTo - wallFrom} ${1 - (wallTo - wallFrom)}`);
      wallBack?.setAttribute('stroke-dashoffset', String(-wallFrom));
      ring?.setAttribute('stroke-dasharray', `${geom.fTop} 1`);
      wall?.setAttribute('stroke-dasharray', `${wallTo - wallFrom} ${1 - (wallTo - wallFrom)}`);
      wall?.setAttribute('stroke-dashoffset', String(-wallFrom));
      water?.setAttribute('stroke-dasharray', `${run} ${1 - run}`);
      water?.setAttribute('stroke-dashoffset', String(-tail));
      // The halo under it carries the SAME span - it is the same slug, blurred and
      // widened, exactly as the dial haloes its session arc (user-directed 2026-09-09).
      glow?.setAttribute('stroke-dasharray', `${run} ${1 - run}`);
      glow?.setAttribute('stroke-dashoffset', String(-tail));
      // The left branch's slug. Same stroke, same pattern, mirrored span - see
      // tubeSpans for why its positions are negative.
      const runL = Math.max(0, headL - tailL);
      waterL?.setAttribute('stroke-dasharray', `${runL} ${1 - runL}`);
      waterL?.setAttribute('stroke-dashoffset', String(-tailL));
      glowL?.setAttribute('stroke-dasharray', `${runL} ${1 - runL}`);
      glowL?.setAttribute('stroke-dashoffset', String(-tailL));

      // Reduced motion lands here on the first frame - `m` jumps straight to its end.
      const rest = Math.abs(m - (calendarCollapsed ? 0 : 1)) < 0.001;
      // The liquid is DONE when its own run has finished, NOT when it agrees with the
      // pipe: a front left partway down the tube by a hand that walked away is a
      // legitimate resting place now, and testing against `m` here would spin the loop
      // forever waiting for a catch-up that is never coming.
      // ... and a slingshot still mid-flight is a run of its own: the phase has to be
      // back to `free` before the loop is allowed to stop, or the return leg would be
      // cut off the moment the calendar finished opening under it.
      const done = rest && p >= 1 && tw.phase === 'free';
      raf = done ? 0 : requestAnimationFrame(frame);
    };

    // A move RESTARTS the loop. It stops itself once everything has settled, so
    // without this the front would follow the pointer only while the calendar
    // happened to still be easing. Listening only while the calendar is open keeps
    // every other pointer move in the app from waking a dead animation.
    //
    // ONLY A HAND ON THE WIDGET STEERS IT (user-directed 2026-09-09). The listener is
    // on the window because a pointer that leaves has to be seen leaving, but a move
    // outside the dock's own box is DROPPED rather than projected: the nearest point
    // on a path exists for every point on the screen, so without this gate a mouse
    // crossing the top of the app would project onto the ring and haul the liquid
    // home. Dropped, the last destination stands and the front stays where it was left.
    const onMove = (e) => {
      const r = dock.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right
        || e.clientY < r.top || e.clientY > r.bottom) { pointer.away = true; return; }
      // A hand that LEFT and came back somewhere else is not steering, it is arriving
      // (user-directed 2026-09-13). Dropping the outside moves is what makes the
      // difference visible: the hand crosses half the widget while unwatched, so the
      // first move back inside is a jump, and the straight-through write below paints
      // it as a teleport. Flagged here, it gets the same short glide the slingshot's
      // return uses instead. Only the FIRST move back is flagged; once the front has
      // caught up, steering is immediate again.
      if (pointer.away) { pointer.away = false; pointer.back = true; }
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.fresh = true;
      if (!raf) raf = requestAnimationFrame(frame);
    };
    if (!calendarCollapsed) window.addEventListener('pointermove', onMove, { passive: true });

    raf = requestAnimationFrame(frame);
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [calendarCollapsed, home, avail, pourR, scale]);

// ═══ BLOCK 2 — the overlay svg (was last in the returned tree)

      {/* ── The tube ───────────────────────────────────────
          Ring 3's PAINT, moved out of the dial's svg on 2026-09-08 and rebuilt as
          a real tube 2026-09-09. It has to be here, last, because it wraps the
          calendar rows and the dial's svg is earlier in DOM order - anything drawn
          there paints behind them.

          Four strokes sharing ONE `d`, all of it written per frame by the loop
          above through `setAttribute` - the same 60fps escape hatch the dial's own
          arc uses. Nothing here carries geometry: this JSX only says what each
          stroke is MADE of. */}
      <svg
        aria-hidden={false}
        width="100%" height="100%"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
      >
        {tubeGlowOn && (
          <defs>
            {/* The dial's recipe, unchanged: DualRingRect.jsx blurs its halo at
                stdDeviation 1.9 inside a box grown 50% every way so the bloom is not
                clipped at the edges of it. */}
            <filter id="tubeGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.9"/>
            </filter>
          </defs>
        )}
        {/* The slab the tube rides on - drawn FIRST, so every stroke paints over
            it. Two of them, carrying the same dash patterns as the ring and the
            wall below, so the slab exists exactly where the pipe does. The width
            is set per frame from the measured proud edge; see the loop. */}
        <path ref={(el) => { (mouthRef.current ||= [])[0] = el; }} fill="none" pathLength={1}
          stroke="var(--planner-face)" strokeLinecap="round" strokeLinejoin="round"/>
        <path ref={(el) => { (mouthRef.current ||= [])[1] = el; }} fill="none" pathLength={1}
          stroke="var(--planner-face)" strokeLinecap="round" strokeLinejoin="round"/>
        {/* The top ring is always drawn - it IS the band the dial wore before any
            of this, wearing the stroke it wore inside DualRingRect. */}
        <path ref={(el) => { tubeRef.current[0] = el; }} pathLength={1} fill="none"
          stroke="var(--clock-stroke-bg)" strokeWidth={RIBBON_W} strokeLinecap="round"/>
        {/* The wall LAID AHEAD of the liquid on the way out and retracted behind it
            on the way back. Same stroke, because it is the same tube - just the
            part of it that did not exist a moment ago. */}
        <path ref={(el) => { tubeRef.current[1] = el; }} pathLength={1} fill="none"
          stroke="var(--clock-stroke-bg)" strokeWidth={RIBBON_W} strokeLinecap="round"/>
        {/* THE HALO, one per slug, drawn UNDER the liquid it belongs to - the dial's
            treatment for its session arc, copied 1-1 (user-directed 2026-09-09): the
            same span, 2.2x the width, a third of the opacity, blurred. `.tube-water`
            again, so the halo is whatever colour the liquid currently is, hover flip
            included. Off entirely when the clock's ambient light is off. */}
        {tubeGlowOn && (
          // ONE group, not two glowing paths (user-reported 2026-09-10: "when two
          // points of the liquid touch the glow amplifies and creates a noticeable
          // point in the middle"). Two separately-faded strokes ADD where they meet -
          // at the mouths, where the two slugs are end to end, that doubled the halo
          // into a bright knot. Grouped, both strokes render opaque into one buffer,
          // where the overlap is the union of two identical colours rather than a sum,
          // and the blur and the fade are applied ONCE to the result.
          <g opacity="0.32" filter="url(#tubeGlow)">
            <path ref={(el) => { tubeRef.current[5] = el; }} pathLength={1} fill="none"
              className="tube-water" strokeWidth={WATER_W * 2.2} strokeLinecap="round"/>
            <path ref={(el) => { tubeRef.current[6] = el; }} pathLength={1} fill="none"
              className="tube-water" strokeWidth={WATER_W * 2.2} strokeLinecap="round"/>
          </g>
        )}
        {/* The liquid. Accent, so the widget gains a permanently coloured ring it
            did not have before (user-directed). `.tube-water` is the dev toy's own
            class reused unchanged: it also flips the liquid white while the tile is
            hovered, which is what stops it vanishing into the accent flood. */}
        <path ref={(el) => { tubeRef.current[2] = el; }} pathLength={1} fill="none"
          className="tube-water" strokeWidth={WATER_W} strokeLinecap="round"/>
        {/* The left branch's liquid. Two elements because the two slugs are two
            separate spans of the same path, and one stroke can carry one. */}
        <path ref={(el) => { tubeRef.current[4] = el; }} pathLength={1} fill="none"
          className="tube-water" strokeWidth={WATER_W} strokeLinecap="round"/>
        {/* The click target follows the whole PIPE rather than the liquid, so the
            control is live along the entire run whether that stretch is wet or dry.
            The dial keeps its own button regardless (DualRingRect) - a hand goes
            back to where it clicked, not where the paint went. */}
        <path
          ref={(el) => { tubeRef.current[3] = el; }}
          fill="none" stroke="transparent"
          strokeWidth={RIBBON_W + 6} strokeLinecap="round"
          role="button" tabIndex={0}
          aria-label="Toggle day calendar"
          style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
          onClick={toggleCalendar}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            toggleCalendar(e);
          }}/>
      </svg>
