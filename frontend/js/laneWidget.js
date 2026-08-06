// Generic segment rendering + drag/resize/select engine, extracted out of
// direction.js once the Direction lane editor proved the hand-rolled
// (no WaveSurfer) approach out, then generalized further once the Shots
// track became its second consumer (see waveformSync.js). Knows nothing
// about shots, cameras, or H3 - a "segment" is just any {startSeconds,
// endSeconds}-shaped object in a plain array. It also knows nothing about
// *how* a segment's time maps to on-screen position: Direction's lanes are
// percentage-of-a-small-fixed-duration (buildLaneRow); the Shots track is
// pixels-per-second against a scrollable, zoomable song-length timeline
// (buildSegment, called directly by waveformSync.js). Both go through the
// same buildSegment/wireSegmentDrag core via a small "metrics" contract:
//   metrics.position(el, seg) -> sets el's left/width for its current times
//   metrics.pxPerSecond() -> real on-screen px per second, read once per drag
(function (MSE) {
  'use strict';

  // Pointerdown drives both click-to-select and drag: a `moved` flag (set
  // once the pointer has actually traveled a few px) decides on pointerup
  // whether this was a click (opts.onClickOnly - no data change) or a real
  // drag (opts.onCommit - after an optional opts.snapTime pass). Data is
  // mutated live on every pointermove via opts.moveSegment/moveSegmentEdge
  // for immediate visual feedback, but opts.onCommit (the single point at
  // which a caller would emit a change event) only fires once on release -
  // firing it on every move would let a re-render replace the DOM out from
  // under the drag in progress.
  function wireSegmentDrag(target, segEl, seg, mode, index, metrics, opts) {
    target.addEventListener('pointerdown', (e) => {
      // Left button only - a right-click here (opening a context menu, e.g.
      // Shots' delete) must not also register as a click-to-select/split via
      // onClickOnly below, nor start a drag on a middle-click.
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const pxPerSecond = metrics.pxPerSecond();
      const startX = e.clientX;
      const startStart = seg.startSeconds;
      const startEnd = seg.endSeconds;
      let moved = false;

      function applyMove(timeValue) {
        return mode === 'move'
          ? opts.moveSegment(index, timeValue)
          : opts.moveSegmentEdge(index, mode, timeValue);
      }

      function onMove(ev) {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        const deltaSeconds = dx / pxPerSecond;
        const timeValue = mode === 'move'
          ? startStart + deltaSeconds
          : (mode === 'start' ? startStart : startEnd) + deltaSeconds;
        // Free during the drag itself - snapping (if any) only applies once,
        // on release - so this always passes the raw pointer-derived time.
        if (applyMove(timeValue) === null) return;
        // seg is the live array element moveSegment/moveSegmentEdge mutated
        // in place, so both edges already reflect the clamped result here.
        metrics.position(segEl, seg);
      }
      function onUp(ev) {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        opts.onSelect(index);
        if (moved) {
          if (opts.snapTime) {
            const current = mode === 'move' || mode === 'start' ? seg.startSeconds : seg.endSeconds;
            applyMove(opts.snapTime(current, ev.altKey));
          }
          opts.onCommit();
        } else {
          opts.onClickOnly(ev, mode);
        }
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  // The lower-level per-consumer entry point: builds one draggable/
  // resizable segment element and wires it up, given a metrics contract
  // (see file header) and the same opts shape documented on buildLaneRow
  // below. Direction goes through buildLaneRow, which builds a percentage
  // metrics object internally; the Shots track (waveformSync.js) calls this
  // directly with a pixels-per-second metrics object since it has no lane
  // row/label/add-tile wrapper to render.
  function buildSegment(seg, index, metrics, opts) {
    const segEl = document.createElement('div');
    segEl.className = opts.className || 'lane-segment';
    segEl.classList.toggle('selected', opts.isSelected(index));
    if (opts.isDisabled) segEl.classList.toggle('disabled', opts.isDisabled(index));
    metrics.position(segEl, seg);
    if (opts.renderLabel) opts.renderLabel(segEl, seg);
    else segEl.textContent = opts.labelText(seg);
    segEl.title = opts.titleText ? opts.titleText(seg) : `${seg.startSeconds.toFixed(2)}s – ${seg.endSeconds.toFixed(2)}s`;
    // Read back by a caller's right-click context menu (see contextMenu.js)
    // to identify which segment was clicked, without a separate DOM->data
    // map - the widget doesn't interpret these, just copies them through.
    if (opts.datasetAttrs) {
      Object.keys(opts.datasetAttrs).forEach((key) => {
        segEl.dataset[key] = opts.datasetAttrs[key];
      });
    }
    segEl.dataset.index = String(index);

    const startHandle = document.createElement('div');
    startHandle.className = 'lane-segment-handle lane-segment-handle-start';
    segEl.appendChild(startHandle);
    const endHandle = document.createElement('div');
    endHandle.className = 'lane-segment-handle lane-segment-handle-end';
    segEl.appendChild(endHandle);

    wireSegmentDrag(segEl, segEl, seg, 'move', index, metrics, opts);
    wireSegmentDrag(startHandle, segEl, seg, 'start', index, metrics, opts);
    wireSegmentDrag(endHandle, segEl, seg, 'end', index, metrics, opts);

    return segEl;
  }

  // Inverse of percentMetrics.position: given a raw pointer clientX and the
  // lane content element it landed in, returns the shot-relative time it
  // corresponds to - used for actions anchored to a click position (e.g.
  // Direction's "split here") the same way waveformSync.js's own
  // shotsTimeAtClientX does for the Shots track.
  function timeAtClientX(contentEl, clientX, domainDuration) {
    const rect = contentEl.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const pct = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(domainDuration, pct * domainDuration));
  }

  function nextSegmentStart(segments) {
    if (!segments.length) return 0;
    return Math.max(...segments.map((s) => s.endSeconds));
  }

  function appendOverhangBand(content, duration, domainDuration, title) {
    if (domainDuration <= duration + 1e-6) return;
    const band = document.createElement('div');
    band.className = 'lane-overhang-band';
    band.style.left = `${(duration / domainDuration) * 100}%`;
    band.style.width = `${((domainDuration - duration) / domainDuration) * 100}%`;
    if (title) band.title = title;
    content.appendChild(band);
  }

  // Percentage-mode metrics: 0-100% spans domainDuration, measured against
  // the lane's actual rendered container width at drag-start (so it stays
  // correct even if the panel was resized since the last render).
  function percentMetrics(domainDuration, content) {
    return {
      pxPerSecond: () => content.getBoundingClientRect().width / domainDuration,
      position(el, seg) {
        el.style.left = `${(seg.startSeconds / domainDuration) * 100}%`;
        el.style.width = `${Math.max(0, (seg.endSeconds - seg.startSeconds) / domainDuration) * 100}%`;
      },
    };
  }

  // duration is the real content range - segments and the "+" add range
  // never go past it. domainDuration is what 0-100% actually spans
  // (duration, or wider when the caller wants trailing padding visible) -
  // every row a caller builds should use the same domainDuration so ticks/
  // segments/bands drawn by different calls still line up with each other.
  //
  // opts:
  //   labelText(seg) -> string shown on the segment
  //   isSelected(index) -> bool, for the .selected style
  //   isDisabled(index) -> bool, for the .disabled style (optional - omit if
  //     the caller's segments have no enabled/disabled concept)
  //   moveSegment(index, timeValue) -> clamped value, or null to reject
  //   moveSegmentEdge(index, side, timeValue) -> clamped value, or null
  //   onSelect(index) -> called on release, click or drag alike
  //   onCommit() -> called once after a real drag settles
  //   onClickOnly(ev, mode) -> called instead of onCommit when nothing moved -
  //     ev is the pointerup event (e.g. for reading click position), mode is
  //     'move'/'start'/'end' (which part was clicked)
  //   onDeselect() -> called on pointerdown in empty lane content
  //   onAdd() -> called when the "+" add tile is clicked
  //   addTitle -> tooltip text for the "+" add tile
  //   snapTime(currentValue, altKey) -> snapped value (optional - omit for
  //     no snapping)
  //   datasetAttrs -> plain object copied onto each segment's dataset
  //   overhangTitle -> tooltip text for the overhang band (optional)
  function buildLaneRow(label, segments, duration, domainDuration, opts) {
    const row = document.createElement('div');
    row.className = 'direction-lane-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'direction-lane-label';
    labelEl.textContent = label;
    labelEl.title = label;
    row.appendChild(labelEl);

    const content = document.createElement('div');
    content.className = 'direction-lane-content';
    content.addEventListener('pointerdown', (e) => {
      if (e.target !== content) return;
      opts.onDeselect();
    });
    row.appendChild(content);

    const metrics = percentMetrics(domainDuration, content);
    segments.forEach((seg, index) => content.appendChild(buildSegment(seg, index, metrics, opts)));

    const lastEnd = nextSegmentStart(segments);
    if (lastEnd < duration - 1e-6) {
      const addEl = document.createElement('div');
      addEl.className = 'lane-segment-add';
      addEl.textContent = '+';
      addEl.title = opts.addTitle || 'Add';
      addEl.style.left = `${(lastEnd / domainDuration) * 100}%`;
      addEl.style.width = `${((duration - lastEnd) / domainDuration) * 100}%`;
      addEl.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onAdd();
      });
      content.appendChild(addEl);
    }

    appendOverhangBand(content, duration, domainDuration, opts.overhangTitle);

    return row;
  }

  MSE.laneWidget = {
    buildLaneRow,
    buildSegment,
    appendOverhangBand,
    nextSegmentStart,
    timeAtClientX,
  };
})(window.MSE = window.MSE || {});
