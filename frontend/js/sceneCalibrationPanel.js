// Native CUTTAlogue calibration editor embedded in the camera preview.
(function (MSE) {
  'use strict';

  const { state, on } = MSE.state;
  const elements = {};
  let shotId = null;

  function currentShot() {
    return state.shots.find((shot) => shot.id === shotId) || null;
  }

  function currentScene() {
    return MSE.scenes.sceneForShot(currentShot());
  }

  function heading(text) {
    const node = document.createElement('h3');
    node.className = 'scene-calibration-section-title';
    node.textContent = text;
    return node;
  }

  function numberInput(value, label, onChange, step = '0.1') {
    const wrapper = document.createElement('label');
    wrapper.className = 'scene-calibration-field';
    const caption = document.createElement('span');
    caption.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = step;
    input.value = String(value);
    input.addEventListener('change', () => {
      const next = Number(input.value);
      if (Number.isFinite(next)) onChange(next);
      else input.value = String(value);
    });
    wrapper.append(caption, input);
    return wrapper;
  }

  function vectorEditor(label, vector, onChange) {
    const wrapper = document.createElement('div');
    wrapper.className = 'scene-calibration-vector';
    const title = document.createElement('span');
    title.textContent = label;
    wrapper.appendChild(title);
    const inputs = vector.map((value, index) => {
      const field = numberInput(value, ['X', 'Y', 'Z'][index], () => {
        const next = inputs.map((entry) => Number(entry.querySelector('input').value));
        if (next.every(Number.isFinite)) onChange(next);
      });
      wrapper.appendChild(field);
      return field;
    });
    return wrapper;
  }

  function renderCamera(scene) {
    const group = document.createElement('div');
    group.className = 'scene-calibration-group';
    group.appendChild(heading('Default camera'));
    const camera = scene.defaultCamera;
    group.appendChild(vectorEditor('Position', camera.position, (position) => {
      MSE.scenes.updateSceneCalibration(scene.id, { defaultCamera: { position } });
    }));
    group.appendChild(vectorEditor('Target', camera.target, (target) => {
      MSE.scenes.updateSceneCalibration(scene.id, { defaultCamera: { target } });
    }));
    group.appendChild(numberInput(camera.focalLengthMm, 'Focal length (mm)', (focalLengthMm) => {
      MSE.scenes.updateSceneCalibration(scene.id, { defaultCamera: { focalLengthMm: Math.max(1, focalLengthMm) } });
    }, '1'));
    return group;
  }

  function renderMotion(scene) {
    const group = document.createElement('div');
    group.className = 'scene-calibration-group';
    group.appendChild(heading('Motion scale'));
    group.appendChild(numberInput(scene.unitsPerMeter || 1, 'Scene units / metre', (unitsPerMeter) => {
      MSE.scenes.updateSceneCalibration(scene.id, { unitsPerMeter });
    }));
    const fields = [
      ['defaultDistanceMeters', 'Default distance (m)'],
      ['smallDistanceMeters', 'Small distance (m)'],
      ['largeDistanceMeters', 'Large distance (m)'],
      ['defaultAngleDegrees', 'Default angle (°)'],
      ['smallAngleDegrees', 'Small angle (°)'],
      ['largeAngleDegrees', 'Large angle (°)'],
    ];
    fields.forEach(([key, label]) => {
      const fallback = MSE.cameraPath.DEFAULT_PROFILE[key];
      group.appendChild(numberInput(scene.motionProfile[key] ?? fallback, label, (value) => {
        MSE.scenes.updateSceneCalibration(scene.id, { motionProfile: { [key]: Math.max(0.0001, value) } });
      }));
    });
    return group;
  }

  function anchorRow(scene, name, anchor) {
    const row = document.createElement('div');
    row.className = 'scene-anchor-row';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = name;
    nameInput.setAttribute('aria-label', 'Anchor name');
    const coordinates = anchor.position.map((value, index) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.1';
      input.value = String(value);
      input.setAttribute('aria-label', `Anchor ${['X', 'Y', 'Z'][index]}`);
      return input;
    });
    function save() {
      const nextPosition = coordinates.map((input) => Number(input.value));
      if (nextPosition.every(Number.isFinite)) MSE.scenes.upsertAnchor(scene.id, name, nameInput.value, nextPosition);
    }
    nameInput.addEventListener('change', save);
    coordinates.forEach((input) => input.addEventListener('change', save));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => MSE.scenes.removeAnchor(scene.id, name));
    row.append(nameInput, ...coordinates, remove);
    return row;
  }

  function renderAnchors(scene) {
    const group = document.createElement('div');
    group.className = 'scene-calibration-group scene-calibration-wide';
    group.appendChild(heading('Named anchors'));
    const labels = document.createElement('div');
    labels.className = 'scene-anchor-labels';
    labels.textContent = 'Name                 X          Y          Z';
    group.appendChild(labels);
    Object.entries(scene.anchors || {}).forEach(([name, anchor]) => group.appendChild(anchorRow(scene, name, anchor)));
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = 'Add anchor';
    add.addEventListener('click', () => {
      let suffix = 1;
      let name = 'anchor';
      while (scene.anchors && scene.anchors[name]) name = `anchor_${++suffix}`;
      MSE.scenes.upsertAnchor(scene.id, null, name, [0, 1.5, 0]);
    });
    group.appendChild(add);
    return group;
  }

  function renderBindings(scene, shot) {
    const group = document.createElement('div');
    group.className = 'scene-calibration-group scene-calibration-wide';
    group.appendChild(heading('Shot target bindings'));
    const targetNames = [...new Set(((shot.direction && shot.direction.camera) || [])
      .map((segment) => String(segment.target || '').trim()).filter(Boolean))];
    const anchorNames = Object.keys(scene.anchors || {});
    if (!targetNames.length) {
      const hint = document.createElement('span');
      hint.className = 'placeholder-hint';
      hint.textContent = 'Camera segments in this shot do not name any targets yet.';
      group.appendChild(hint);
      return group;
    }
    targetNames.forEach((targetName) => {
      const row = document.createElement('label');
      row.className = 'scene-binding-row';
      const caption = document.createElement('span');
      caption.textContent = targetName;
      const select = document.createElement('select');
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'Unbound';
      select.appendChild(empty);
      anchorNames.forEach((anchorName) => {
        const option = document.createElement('option');
        option.value = anchorName;
        option.textContent = anchorName;
        select.appendChild(option);
      });
      select.value = (shot.preview.targetBindings || {})[targetName] || (anchorNames.includes(targetName) ? targetName : '');
      select.addEventListener('change', () => MSE.scenes.setTargetBinding(shot.id, targetName, select.value));
      row.append(caption, select);
      group.appendChild(row);
    });
    return group;
  }

  function render() {
    if (!elements.content) return;
    elements.content.innerHTML = '';
    const shot = currentShot();
    const scene = currentScene();
    elements.toggle.disabled = !scene;
    if (!scene || !shot) {
      elements.panel.hidden = true;
      elements.toggle.setAttribute('aria-expanded', 'false');
      return;
    }
    elements.content.append(renderCamera(scene), renderMotion(scene), renderAnchors(scene), renderBindings(scene, shot));
  }

  function setShot(shot) {
    shotId = shot ? shot.id : null;
    render();
  }

  function init() {
    elements.toggle = document.getElementById('camera-preview-calibrate-btn');
    elements.panel = document.getElementById('scene-calibration-panel');
    elements.content = document.getElementById('scene-calibration-content');
    elements.toggle.addEventListener('click', () => {
      if (elements.toggle.disabled) return;
      elements.panel.hidden = !elements.panel.hidden;
      elements.toggle.setAttribute('aria-expanded', String(!elements.panel.hidden));
      if (!elements.panel.hidden) render();
    });
    render();
  }

  on('scenes-changed', render);
  on('shots-changed', render);
  document.addEventListener('DOMContentLoaded', init);
  MSE.sceneCalibrationPanel = { setShot };
})(window.MSE = window.MSE || {});
