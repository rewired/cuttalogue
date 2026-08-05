// The "fiddly" per-asset editing (tags, description, [Describe image],
// delete) lives in this modal, separate from the context panel's Assets
// tab, since that's occasional housekeeping, not the every-click
// assign/remove workflow the tab is used for constantly. Assigning assets
// to shots stays in the tab - it has no concept of "the selected shot" here.
//
// Master-detail layout: a compact thumbnail grid on the left to pick an
// asset, a roomy detail panel on the right for whichever one is selected -
// the description text especially needs real space, not a 3-row textarea
// squeezed into a 140px-wide grid card.
(function (MSE) {
  'use strict';

  const { state, on } = MSE.state;

  const el = {};
  let selectedAssetId = null;

  function cacheElements() {
    el.openBtn = document.getElementById('asset-library-open-btn');
    el.menuOpenBtn = document.getElementById('asset-library-menu-btn');
    el.overlay = document.getElementById('asset-library-screen');
    el.closeBtn = document.getElementById('asset-library-close-btn');
    el.fileInput = document.getElementById('asset-library-file-input');
    el.tagFilter = document.getElementById('asset-library-tag-filter');
    el.status = document.getElementById('asset-library-status');
    el.empty = document.getElementById('asset-library-empty');
    el.grid = document.getElementById('asset-library-grid');
    el.detail = document.getElementById('asset-library-detail');
  }

  function assetPreviewUrl(asset) {
    const projectId = MSE.project.getProjectId();
    const path = asset.thumbnailPath || (asset.type === 'image' ? asset.relativePath : null);
    if (!projectId || !path) return null;
    return `/project-files/${projectId}/${path}`;
  }

  function assetTypeLabel(type) {
    if (type === 'audio') return 'AUDIO';
    if (type === 'video') return 'VIDEO';
    if (type === 'other') return 'FILE';
    return 'IMAGE';
  }

  function selectAsset(assetId) {
    selectedAssetId = assetId;
    renderGrid();
    renderDetail();
  }

  function renderGridCard(asset) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'asset-card asset-card-pick';
    card.classList.toggle('selected', asset.id === selectedAssetId);

    const previewUrl = assetPreviewUrl(asset);
    if (previewUrl) {
      const img = document.createElement('img');
      img.src = previewUrl;
      img.alt = asset.fileName;
      card.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'asset-icon';
      placeholder.textContent = assetTypeLabel(asset.type);
      card.appendChild(placeholder);
    }

    const name = document.createElement('div');
    name.className = 'asset-filename';
    name.title = asset.fileName;
    name.textContent = asset.fileName;
    card.appendChild(name);

    card.addEventListener('click', () => selectAsset(asset.id));
    return card;
  }

  function renderGrid() {
    const filterText = el.tagFilter.value.trim().toLowerCase();
    const filtered = state.assets.filter((asset) => {
      if (!filterText) return true;
      return (asset.tags || []).some((tag) => tag.toLowerCase().includes(filterText));
    });
    el.grid.innerHTML = '';
    el.empty.style.display = state.assets.length === 0 ? '' : 'none';
    filtered.forEach((asset) => el.grid.appendChild(renderGridCard(asset)));
  }

  function renderDetail() {
    el.detail.innerHTML = '';
    const asset = MSE.assets.findAsset(selectedAssetId);
    if (!asset) {
      selectedAssetId = null;
      const empty = document.createElement('p');
      empty.className = 'placeholder-hint';
      empty.id = 'asset-library-detail-empty';
      empty.textContent = 'Select an asset on the left to see its details.';
      el.detail.appendChild(empty);
      return;
    }

    const previewUrl = assetPreviewUrl(asset);
    if (previewUrl) {
      const img = document.createElement('img');
      img.className = 'asset-detail-preview';
      img.src = previewUrl;
      img.alt = asset.fileName;
      el.detail.appendChild(img);
    }

    const name = document.createElement('h3');
    name.className = 'asset-detail-filename';
    name.textContent = asset.fileName;
    el.detail.appendChild(name);

    const tagLabel = document.createElement('div');
    tagLabel.className = 'asset-description-label';
    tagLabel.textContent = 'Tags';
    el.detail.appendChild(tagLabel);

    const tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.className = 'asset-tag-input';
    tagInput.placeholder = 'tags, comma, separated';
    tagInput.value = (asset.tags || []).join(', ');
    tagInput.addEventListener('change', () => {
      const tags = tagInput.value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      MSE.assets.setAssetTags(asset.id, tags);
    });
    el.detail.appendChild(tagInput);

    if (asset.type === 'image') {
      const descLabel = document.createElement('div');
      descLabel.className = 'asset-description-label';
      descLabel.textContent = 'Description';
      el.detail.appendChild(descLabel);

      const descArea = document.createElement('textarea');
      descArea.className = 'asset-description asset-description-large';
      descArea.rows = 12;
      descArea.placeholder = 'Description...';
      descArea.value = asset.description || '';
      descArea.addEventListener('change', () => {
        MSE.assets.setAssetDescription(asset.id, descArea.value);
      });
      el.detail.appendChild(descArea);

      const describeBtn = document.createElement('button');
      describeBtn.type = 'button';
      describeBtn.className = 'asset-describe-btn';
      describeBtn.textContent = 'Describe image';
      el.detail.appendChild(describeBtn);

      const describeStatus = document.createElement('span');
      describeStatus.className = 'asset-describe-status';
      describeStatus.hidden = true;
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      describeStatus.appendChild(spinner);
      describeStatus.appendChild(document.createTextNode('Working...'));
      el.detail.appendChild(describeStatus);

      // Streams deltas straight into this textarea without going through
      // setAssetDescription (and its assets-changed event) on every token -
      // that would rebuild the whole grid and detail panel on every streamed
      // word. The state is mutated directly instead, then persisted with one
      // real event once streaming finishes.
      describeBtn.addEventListener('click', async () => {
        const projectId = MSE.project.getProjectId();
        if (!projectId) return;
        describeBtn.disabled = true;
        describeStatus.hidden = false;
        descArea.value = '';
        const assetRef = MSE.assets.findAsset(asset.id);
        let firstDelta = true;
        try {
          const { jobId } = await MSE.api.describeAsset(projectId, asset.id);
          await MSE.api.watchJob(jobId, (event) => {
            if (event.delta) {
              if (firstDelta) {
                describeStatus.hidden = true;
                firstDelta = false;
              }
              descArea.value += event.delta;
              if (assetRef) assetRef.description = descArea.value;
            }
          });
          MSE.assets.setAssetDescription(asset.id, descArea.value);
        } catch (err) {
          console.error(err);
          descArea.value = `Describe failed: ${err.message}`;
        } finally {
          describeBtn.disabled = false;
          describeStatus.hidden = true;
        }
      });
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'asset-delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      if (!window.confirm(`Delete "${asset.fileName}"? This also unassigns it from every shot.`)) return;
      MSE.assets.removeAsset(asset.id);
    });
    el.detail.appendChild(deleteBtn);
  }

  function render() {
    renderGrid();
    renderDetail();
  }

  function openScreen() {
    el.overlay.hidden = false;
    el.status.textContent = '';
    render();
  }

  function closeScreen() {
    el.overlay.hidden = true;
  }

  function wire() {
    el.openBtn.addEventListener('click', openScreen);
    el.menuOpenBtn.addEventListener('click', openScreen);
    el.closeBtn.addEventListener('click', closeScreen);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.overlay.hidden) closeScreen();
    });

    el.tagFilter.addEventListener('input', renderGrid);

    el.fileInput.addEventListener('change', async () => {
      const files = el.fileInput.files;
      if (!files || files.length === 0) return;
      const projectId = MSE.project.getProjectId();
      if (!projectId) {
        el.status.textContent = 'Backend unavailable - cannot import assets.';
        el.fileInput.value = '';
        return;
      }
      el.status.textContent = `Importing ${files.length} file(s)...`;
      try {
        const result = await MSE.api.uploadAssets(projectId, files);
        MSE.assets.addAssets(result.assets);
        el.status.textContent = `Imported ${result.assets.length} file(s).`;
      } catch (err) {
        console.error(err);
        el.status.textContent = 'Import failed - is the backend running?';
      } finally {
        el.fileInput.value = '';
      }
    });

    on('assets-changed', () => {
      if (!el.overlay.hidden) render();
    });
  }

  function init() {
    cacheElements();
    wire();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.assetLibrary = { openScreen, closeScreen };
})(window.MSE = window.MSE || {});
