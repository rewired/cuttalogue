// Native CUTTAlogue camera preview controller. Camera animation remains
// derived from shot.direction.camera; this module owns only transient view
// and transport state and recreates/disposes WebGL resources per opening.
(function (MSE) {
  'use strict';

  const { state, on } = MSE.state;
  const elements = {};
  let renderer = null;
  let currentShot = null;
  let plan = null;
  let viewMode = 'shot';
  let previewTime = 0;
  let isScrubbing = false;
  let localPlaybackFrame = null;
  let localPlaybackStartedAt = 0;
  let localPlaybackStartTime = 0;
  let projectIsPlaying = false;
  let sceneLoadToken = 0;
  let pathStatus = { text: '', warning: false };
  let sceneStatus = { text: '', warning: false };

  function cacheElements() {
    elements.open = document.getElementById('camera-preview-btn');
    elements.overlay = document.getElementById('camera-preview-modal');
    elements.close = document.getElementById('camera-preview-close-btn');
    elements.title = document.getElementById('camera-preview-title');
    elements.subtitle = document.getElementById('camera-preview-subtitle');
    elements.canvas = document.getElementById('camera-preview-canvas');
    elements.shotView = document.getElementById('camera-preview-shot-view');
    elements.freeView = document.getElementById('camera-preview-free-view');
    elements.scene = document.getElementById('camera-preview-scene-select');
    elements.diagnostics = document.getElementById('camera-preview-diagnostics');
    elements.empty = document.getElementById('camera-preview-empty');
    elements.time = document.getElementById('camera-preview-time');
    elements.lens = document.getElementById('camera-preview-lens');
    elements.segment = document.getElementById('camera-preview-segment');
    elements.play = document.getElementById('camera-preview-play-btn');
    elements.scrubber = document.getElementById('camera-preview-scrubber');
    elements.duration = document.getElementById('camera-preview-duration');
  }

  function selectedShot() {
    const id = MSE.context ? MSE.context.getSelectedShotId() : null;
    return id === null ? null : state.shots.find((shot) => shot.id === id) || null;
  }

  function shotDuration() {
    return currentShot ? MSE.shots.shotDuration(currentShot) : 0;
  }

  function isOpen() {
    return elements.overlay && !elements.overlay.hidden;
  }

  function compileCurrentShot() {
    if (!currentShot) return;
    const duration = shotDuration();
    const scene = MSE.scenes ? MSE.scenes.sceneForShot(currentShot) : null;
    const initialCamera = MSE.scenes ? MSE.scenes.cameraForScene(scene, currentShot.preview && currentShot.preview.initialCameraOverride) : null;
    plan = MSE.cameraPath.compile((currentShot.direction && currentShot.direction.camera) || [], {
      durationSeconds: duration,
      initialCamera,
      profile: scene && scene.motionProfile,
    });
    if (renderer) renderer.setPlan(plan);
    elements.scrubber.max = String(duration);
    elements.duration.textContent = `${duration.toFixed(2)} s`;
    const cameraSegments = (currentShot.direction && currentShot.direction.camera) || [];
    elements.empty.hidden = cameraSegments.some((segment) => segment.enabled !== false);
    const warningCount = plan.warnings.length;
    pathStatus = { text: warningCount
      ? `${warningCount} camera warning${warningCount === 1 ? '' : 's'}`
      : 'Camera path valid', warning: warningCount > 0 };
    updateDiagnostics();
  }

  function updateDiagnostics() {
    const parts = [pathStatus.text, sceneStatus.text].filter(Boolean);
    elements.diagnostics.textContent = parts.join(' · ');
    elements.diagnostics.classList.toggle('warning', pathStatus.warning || sceneStatus.warning);
  }

  function renderSceneSelect() {
    elements.scene.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = state.scenes.length ? 'No scene' : 'No scene assets imported';
    elements.scene.appendChild(none);
    state.scenes.forEach((scene) => {
      const option = document.createElement('option');
      option.value = scene.id;
      option.textContent = scene.name || scene.id;
      elements.scene.appendChild(option);
    });
    elements.scene.value = currentShot && currentShot.sceneId ? currentShot.sceneId : '';
  }

  async function loadCurrentScene() {
    const token = ++sceneLoadToken;
    if (!renderer || !currentShot || !MSE.sceneGeometry || !MSE.scenes) return;
    renderer.clearScene();
    const scene = MSE.scenes.sceneForShot(currentShot);
    if (!scene) {
      sceneStatus = { text: '', warning: false };
      updateDiagnostics();
      render();
      return;
    }
    sceneStatus = { text: 'Loading scene…', warning: false };
    updateDiagnostics();
    try {
      const geometry = await MSE.sceneGeometry.loadScene(scene, state.assets, MSE.project.getProjectId());
      if (token !== sceneLoadToken || !renderer) return;
      renderer.setSceneGeometry(geometry);
      const pointCount = geometry.pointCloud ? geometry.pointCloud.positions.length / 3 : 0;
      const blockoutEdges = geometry.blockout ? geometry.blockout.length / 6 : 0;
      const counts = [];
      if (pointCount) counts.push(`${pointCount.toLocaleString()} points`);
      if (blockoutEdges) counts.push(`${blockoutEdges.toLocaleString()} edges`);
      sceneStatus = { text: counts.length ? counts.join(', ') : 'Scene has no preview geometry', warning: !counts.length };
    } catch (error) {
      console.error(error);
      sceneStatus = { text: error.message, warning: true };
    }
    updateDiagnostics();
    render();
  }

  function render() {
    if (!renderer || !plan || !currentShot) return;
    previewTime = Math.max(0, Math.min(shotDuration(), previewTime));
    const pose = MSE.cameraPath.evaluate(plan, previewTime);
    renderer.render(pose, viewMode);
    elements.scrubber.value = String(previewTime);
    elements.time.textContent = previewTime.toFixed(2);
    elements.lens.textContent = pose.focalLengthMm.toFixed(1).replace(/\.0$/, '');
    const source = pose.segmentIndex === null
      ? null
      : ((currentShot.direction && currentShot.direction.camera) || [])[pose.segmentIndex];
    elements.segment.textContent = source ? (source.movement || 'Static shot').replaceAll('_', ' ') : 'No active segment';
  }

  function setViewMode(nextMode) {
    viewMode = nextMode;
    elements.shotView.classList.toggle('active', viewMode === 'shot');
    elements.freeView.classList.toggle('active', viewMode === 'free');
    render();
  }

  function projectRelativeTime() {
    if (!currentShot || !MSE.sync) return previewTime;
    return MSE.sync.getCurrentTime() - currentShot.startSeconds;
  }

  function stopLocalPlayback() {
    if (localPlaybackFrame !== null) cancelAnimationFrame(localPlaybackFrame);
    localPlaybackFrame = null;
    elements.play.textContent = projectIsPlaying ? 'Pause' : 'Play';
  }

  function localPlaybackTick(now) {
    if (!isOpen() || !currentShot) return stopLocalPlayback();
    previewTime = localPlaybackStartTime + (now - localPlaybackStartedAt) / 1000;
    if (previewTime >= shotDuration()) {
      previewTime = shotDuration();
      render();
      stopLocalPlayback();
      return;
    }
    render();
    localPlaybackFrame = requestAnimationFrame(localPlaybackTick);
  }

  function toggleLocalPlayback() {
    if (localPlaybackFrame !== null) {
      stopLocalPlayback();
      return;
    }
    if (previewTime >= shotDuration()) previewTime = 0;
    localPlaybackStartTime = previewTime;
    localPlaybackStartedAt = performance.now();
    elements.play.textContent = 'Pause';
    localPlaybackFrame = requestAnimationFrame(localPlaybackTick);
  }

  async function togglePlayback() {
    if (!currentShot) return;
    if (!MSE.sync || !MSE.sync.isTimelineReady()) {
      toggleLocalPlayback();
      return;
    }
    const projectTime = MSE.sync.getCurrentTime();
    if (projectTime < currentShot.startSeconds || projectTime >= currentShot.endSeconds) {
      MSE.sync.seekTo(currentShot.startSeconds);
    }
    await MSE.sync.togglePlayback();
  }

  function open() {
    currentShot = selectedShot();
    if (!currentShot) return;
    if (renderer) renderer.dispose();
    elements.overlay.hidden = false;
    elements.title.textContent = 'Camera preview';
    elements.subtitle.textContent = currentShot.name ? `Shot ${currentShot.id} — ${currentShot.name}` : `Shot ${currentShot.id}`;
    previewTime = Math.max(0, Math.min(shotDuration(), projectRelativeTime()));
    renderSceneSelect();
    try {
      renderer = new MSE.cameraPreviewRenderer.CameraPreviewRenderer(elements.canvas);
      compileCurrentShot();
      setViewMode('shot');
      loadCurrentScene();
    } catch (error) {
      console.error(error);
      elements.diagnostics.textContent = error.message;
      elements.diagnostics.classList.add('warning');
    }
  }

  function close() {
    sceneLoadToken += 1;
    stopLocalPlayback();
    if (renderer) renderer.dispose();
    renderer = null;
    plan = null;
    currentShot = null;
    elements.overlay.hidden = true;
  }

  function init() {
    cacheElements();
    elements.open.addEventListener('click', open);
    elements.close.addEventListener('click', close);
    elements.overlay.addEventListener('click', (event) => {
      if (event.target === elements.overlay) close();
    });
    elements.shotView.addEventListener('click', () => setViewMode('shot'));
    elements.freeView.addEventListener('click', () => setViewMode('free'));
    elements.play.addEventListener('click', togglePlayback);
    elements.scene.addEventListener('change', () => {
      if (currentShot && MSE.scenes) MSE.scenes.setShotScene(currentShot.id, elements.scene.value || null);
    });
    elements.scrubber.addEventListener('pointerdown', () => { isScrubbing = true; });
    elements.scrubber.addEventListener('pointerup', () => { isScrubbing = false; });
    elements.scrubber.addEventListener('input', () => {
      previewTime = Number(elements.scrubber.value) || 0;
      if (MSE.sync && MSE.sync.isTimelineReady()) MSE.sync.seekTo(currentShot.startSeconds + previewTime);
      render();
    });
    window.addEventListener('resize', () => { if (isOpen()) render(); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen()) close();
    });

    if (MSE.sync && MSE.sync.onPlayheadTick) {
      MSE.sync.onPlayheadTick(() => {
        if (!isOpen() || isScrubbing || localPlaybackFrame !== null) return;
        previewTime = projectRelativeTime();
        render();
      });
    }
  }

  on('playback-state-changed', (event) => {
    projectIsPlaying = !!event.detail.isPlaying;
    if (elements.play) elements.play.textContent = projectIsPlaying ? 'Pause' : 'Play';
  });
  on('shots-changed', (event) => {
    if (!isOpen() || !currentShot) return;
    currentShot = state.shots.find((shot) => shot.id === currentShot.id) || null;
    if (!currentShot) return close();
    compileCurrentShot();
    render();
    if (event.detail && event.detail.reason === 'scene') loadCurrentScene();
  });
  on('shot-selected', () => {
    if (!isOpen()) return;
    currentShot = selectedShot();
    if (!currentShot) return close();
    elements.subtitle.textContent = currentShot.name ? `Shot ${currentShot.id} — ${currentShot.name}` : `Shot ${currentShot.id}`;
    previewTime = Math.max(0, Math.min(shotDuration(), projectRelativeTime()));
    compileCurrentShot();
    renderSceneSelect();
    render();
    loadCurrentScene();
  });
  on('project-loaded', () => { if (isOpen()) close(); });
  on('scenes-changed', () => {
    if (!isOpen()) return;
    renderSceneSelect();
    compileCurrentShot();
    loadCurrentScene();
  });

  document.addEventListener('DOMContentLoaded', init);
  MSE.cameraPreview = { open, close };
})(window.MSE = window.MSE || {});
