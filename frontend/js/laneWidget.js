// Generic lane-row rendering + drag/resize/select engine, extracted out of
// direction.js once the Direction lane editor proved the hand-rolled
// (no WaveSurfer) approach out. Knows nothing about shots, cameras, or
// H3 - a "segment" is just any {startSeconds, endSeconds}-shaped object in
// a plain array, positioned as a % of domainDuration. All shot/H3-specific
// behavior (what a segment means, how it's labeled, how it's moved in the
// underlying data, snapping) is supplied by the caller through opts -
// see direction.js for the current (only) consumer.
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
  function wireSegmentDrag(target, segEl, seg, mode, index, domainDuration, opts) {
    target.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      // segEl is always the segment element itself (not the handle that may
      // have triggered this), so its parent is reliably the lane content.
      const content = segEl.parentElement;
      const pxPerSecond = content.getBoundingClientRect().width / domainDuration;
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
        segEl.style.left = `${(seg.startSeconds / domainDuration) * 100}%`;
        segEl.style.width = `${Math.max(0, (seg.endSeconds - seg.startSeconds) / domainDuration) * 100}%`;
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
          opts.onClickOnly();
        }
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  function buildSegmentEl(seg, index, domainDuration, opts) {
    const segEl = document.createElement('div');
    segEl.className = 'direction-segment';
    segEl.classList.toggle('selected', opts.isSelected(index));
    segEl.style.left = `${(seg.startSeconds / domainDuration) * 100}%`;
    segEl.style.width = `${Math.max(0, (seg.endSeconds - seg.startSeconds) / domainDuration) * 100}%`;
    segEl.textContent = opts.labelText(seg);
    segEl.title = `${seg.startSeconds.toFixed(2)}s – ${seg.endSeconds.toFixed(2)}s`;
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
    startHandle.className = 'direction-segment-handle direction-segment-handle-start';
    segEl.appendChild(startHandle);
    const endHandle = document.createElement('div');
    endHandle.className = 'direction-segment-handle direction-segment-handle-end';
    segEl.appendChild(endHandle);

    wireSegmentDrag(segEl, segEl, seg, 'move', index, domainDuration, opts);
    wireSegmentDrag(startHandle, segEl, seg, 'start', index, domainDuration, opts);
    wireSegmentDrag(endHandle, segEl, seg, 'end', index, domainDuration, opts);

    return segEl;
  }

  function nextSegmentStart(segments) {
    if (!segments.length) return 0;
    return Math.max(...segments.map((s) => s.endSeconds));
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
  //   moveSegment(index, timeValue) -> clamped value, or null to reject
  //   moveSegmentEdge(index, side, timeValue) -> clamped value, or null
  //   onSelect(index) -> called on release, click or drag alike
  //   onCommit() -> called once after a real drag settles
  //   onClickOnly() -> called instead of onCommit when nothing moved
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

    segments.forEach((seg, index) => content.appendChild(buildSegmentEl(seg, index, domainDuration, opts)));

    const lastEnd = nextSegmentStart(segments);
    if (lastEnd < duration - 1e-6) {
      const addEl = document.createElement('div');
      addEl.className = 'direction-segment-add';
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

  function appendOverhangBand(content, duration, domainDuration, title) {
    if (domainDuration <= duration + 1e-6) return;
    const band = document.createElement('div');
    band.className = 'direction-overhang-band';
    band.style.left = `${(duration / domainDuration) * 100}%`;
    band.style.width = `${((domainDuration - duration) / domainDuration) * 100}%`;
    if (title) band.title = title;
    content.appendChild(band);
  }

  MSE.laneWidget = {
    buildLaneRow,
    appendOverhangBand,
    nextSegmentStart,
  };
})(window.MSE = window.MSE || {});
