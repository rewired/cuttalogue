// Generic right-click context menu: the Shots track (waveformSync.js) and
// the Direction lane editor (direction.js) each had their own hand-rolled
// copy of this exact show/hide/dismiss dance - same positioning, same
// outside-click/Escape/scroll dismissal, same hide-on-shots-changed. This is
// the one implementation both wire up. Started life as delete-only; Direction
// grew a need for split/duplicate/toggle-enabled/merge alongside delete, so
// this takes a small list of actions instead of a single hardcoded button -
// a caller that only needs delete just passes a one-item list.
(function (MSE) {
  'use strict';

  const { on } = MSE.state;

  // container: element to listen for 'contextmenu' on (bubbled/delegated -
  //   doesn't need to be the exact element clicked).
  // resolveTarget(e): given the contextmenu event, returns whatever value
  //   identifies what was right-clicked (a shot id, a {kind, index} shape,
  //   anything), or null/undefined if the click didn't land on an actionable
  //   thing - in which case the menu stays hidden.
  // menuEl: the .context-menu markup (position set via style.left/top,
  //   visibility via style.display).
  // actions: [{ btn, onClick(target) }] - btn is the menu's own <button>
  //   element; onClick fires with the resolved target when it's clicked.
  function create({ container, resolveTarget, menuEl, actions }) {
    let target = null;

    function hide() {
      menuEl.style.display = 'none';
      target = null;
    }

    container.addEventListener('contextmenu', (e) => {
      const resolved = resolveTarget(e);
      if (resolved === null || resolved === undefined) {
        hide();
        return;
      }
      e.preventDefault();
      target = resolved;
      menuEl.style.left = `${e.clientX}px`;
      menuEl.style.top = `${e.clientY}px`;
      menuEl.style.display = 'block';
    });

    actions.forEach(({ btn, onClick }) => {
      btn.addEventListener('click', () => {
        if (target !== null) onClick(target);
        hide();
      });
    });

    document.addEventListener('pointerdown', (e) => {
      if (menuEl.style.display !== 'none' && !menuEl.contains(e.target)) hide();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hide();
    });
    window.addEventListener('scroll', hide, true);
    on('shots-changed', hide);

    return { hide };
  }

  MSE.contextMenu = { create };
})(window.MSE = window.MSE || {});
