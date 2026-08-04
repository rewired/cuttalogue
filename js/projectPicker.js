// Project name field + a lightweight "Projects" dropdown to create a new
// project or switch to an existing one. There's no dirty-state tracking -
// switching discards unsaved edits the same way a page refresh already would.
(function (MSE) {
  'use strict';

  const { state, on } = MSE.state;

  const el = {};

  function cacheElements() {
    el.nameInput = document.getElementById('project-name-input');
    el.projectsBtn = document.getElementById('projects-btn');
    el.menu = document.getElementById('projects-menu');
    el.newBtn = document.getElementById('new-project-btn');
    el.list = document.getElementById('projects-list');
    el.listEmpty = document.getElementById('projects-list-empty');
  }

  function syncNameInput() {
    el.nameInput.value = state.name || '';
  }

  function formatUpdatedAt(unixSeconds) {
    if (!unixSeconds) return '';
    return new Date(unixSeconds * 1000).toLocaleString();
  }

  async function renderProjectsList() {
    el.list.querySelectorAll('.project-list-item').forEach((node) => node.remove());
    el.listEmpty.textContent = 'Loading...';
    el.listEmpty.style.display = '';

    let projects;
    try {
      projects = await MSE.project.listProjects();
    } catch (err) {
      console.error(err);
      el.listEmpty.textContent = 'Could not load project list - is the backend running?';
      return;
    }

    if (projects.length === 0) {
      el.listEmpty.textContent = 'No projects yet.';
      return;
    }
    el.listEmpty.style.display = 'none';

    const currentId = MSE.project.getProjectId();
    projects.forEach((project) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'project-list-item';
      if (project.id === currentId) row.classList.add('current');

      const name = document.createElement('span');
      name.className = 'project-list-item-name';
      name.textContent = project.name || '(untitled)';
      row.appendChild(name);

      const meta = document.createElement('span');
      meta.className = 'project-list-item-meta';
      meta.textContent = `${project.shotCount} shot${project.shotCount === 1 ? '' : 's'} · ${formatUpdatedAt(project.updatedAt)}`;
      row.appendChild(meta);

      row.addEventListener('click', async () => {
        if (project.id === currentId) {
          closeMenu();
          return;
        }
        row.disabled = true;
        try {
          await MSE.project.openProject(project.id);
          closeMenu();
        } catch (err) {
          console.error(err);
          el.listEmpty.textContent = 'Failed to open that project.';
          el.listEmpty.style.display = '';
        }
      });

      el.list.appendChild(row);
    });
  }

  function openMenu() {
    el.menu.hidden = false;
    renderProjectsList();
  }

  function closeMenu() {
    el.menu.hidden = true;
  }

  function wire() {
    el.nameInput.addEventListener('input', () => {
      state.name = el.nameInput.value;
    });

    el.projectsBtn.addEventListener('click', () => {
      if (el.menu.hidden) openMenu();
      else closeMenu();
    });

    el.newBtn.addEventListener('click', async () => {
      el.newBtn.disabled = true;
      try {
        await MSE.project.createNewProject();
        closeMenu();
      } catch (err) {
        console.error(err);
        el.listEmpty.textContent = 'Failed to create a new project - is the backend running?';
        el.listEmpty.style.display = '';
      } finally {
        el.newBtn.disabled = false;
      }
    });

    document.addEventListener('pointerdown', (e) => {
      if (!el.menu.hidden && !el.menu.contains(e.target) && e.target !== el.projectsBtn) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });

    on('project-loaded', syncNameInput);
  }

  function init() {
    cacheElements();
    syncNameInput();
    wire();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.projectPicker = {};
})(window.MSE = window.MSE || {});
