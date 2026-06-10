'use strict';

// ============================================================
// CONSTANTS
// ============================================================

const REPOS = [
  { owner: 'Bitshala-Incubator', name: 'silent-pay-wallet' },
  { owner: 'Bitshala-Incubator', name: 'silent-pay' },
  { owner: 'CypherCommons',      name: 'shroud-indexer' },
];

const GH_API        = 'https://api.github.com';
const LS_TOKEN      = 'spb-token';
const LS_GIST       = 'spb-gist';
const LS_STATE      = 'spb-state';   // local cache/fallback for state
const GIST_FILENAME = 'board.json';

const REPO_CSS = {
  'silent-pay-wallet': 'repo-wallet',
  'silent-pay':        'repo-sp',
  'shroud-indexer':    'repo-indexer',
};

// ============================================================
// CONFIG  (per-device, never leaves localStorage)
// ============================================================

const cfg = {
  get token()  { return localStorage.getItem(LS_TOKEN) || ''; },
  set token(v) { v ? localStorage.setItem(LS_TOKEN, v) : localStorage.removeItem(LS_TOKEN); },
  get gistId() { return localStorage.getItem(LS_GIST) || ''; },
  set gistId(v){ v ? localStorage.setItem(LS_GIST, v) : localStorage.removeItem(LS_GIST); },
};

// ============================================================
// BOARD STATE  (synced to/from Gist)
// ============================================================

let state = {
  v: 1,
  customTracks: [], // { id, name }[] — user-created tracks beyond the built-ins
  items:       [],  // GitHubItem[]
  ideas:       [],  // LocalIdea[]
  assignments: {},  // itemId → { track: string, done: bool }
  lastSync:    null,
  lastUpdated: null,
};

function loadStateFromStorage() {
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch {}
  if (!Array.isArray(state.customTracks)) state.customTracks = [];
}

function saveStateToStorage() {
  try { localStorage.setItem(LS_STATE, JSON.stringify(state)); } catch {}
}

function getAssignment(id) {
  return state.assignments[id] || { track: 'inbox', done: false };
}

function setAssignment(id, patch) {
  state.assignments[id] = { ...getAssignment(id), ...patch };
  scheduleSave();
  renderBoard();
}

// ============================================================
// GIST  API
// ============================================================

function ghHeaders(withAuth = true) {
  const h = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (withAuth && cfg.token) h['Authorization'] = `Bearer ${cfg.token}`;
  return h;
}

async function loadFromGist() {
  if (!cfg.gistId) return false;
  const resp = await fetch(`${GH_API}/gists/${cfg.gistId}`, { headers: ghHeaders(true) });
  if (!resp.ok) {
    if (resp.status === 404) throw new Error('Gist not found. Check your Gist ID in Settings.');
    throw new Error(`Failed to load board from Gist (${resp.status})`);
  }
  const gist = await resp.json();
  const raw  = gist.files?.[GIST_FILENAME]?.content;
  if (!raw) throw new Error(`Gist exists but has no ${GIST_FILENAME} file.`);
  const parsed = JSON.parse(raw);
  state = { ...state, ...parsed };
  if (!Array.isArray(state.customTracks)) state.customTracks = [];
  return true;
}

async function saveToGist() {
  if (!cfg.gistId) return;
  if (!cfg.token) { showToast('Add a GitHub token in Settings to save changes.', 'error'); return; }
  state.lastUpdated = new Date().toISOString();
  const resp = await fetch(`${GH_API}/gists/${cfg.gistId}`, {
    method: 'PATCH',
    headers: { ...ghHeaders(true), 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(state, null, 2) } } }),
  });
  if (!resp.ok) throw new Error(`Failed to save to Gist (${resp.status})`);
}

async function createNewGist() {
  if (!cfg.token) throw new Error('A GitHub token is required to create a Gist.');
  const resp = await fetch(`${GH_API}/gists`, {
    method: 'POST',
    headers: { ...ghHeaders(true), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: 'Silent Pay Project Board',
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify(state, null, 2) } },
    }),
  });
  if (!resp.ok) throw new Error(`Failed to create Gist (${resp.status}). Check token has 'gist' scope.`);
  const gist = await resp.json();
  return gist.id;
}

// ============================================================
// DEBOUNCED SAVE
// ============================================================

let saveTimer   = null;
let saveStatusEl = null;

function scheduleSave() {
  saveStateToStorage(); // always persist locally, immediately
  if (!cfg.gistId) return; // no Gist configured yet → local only, no status needed
  setSaveStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await saveToGist();
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(''), 2500);
    } catch (err) {
      setSaveStatus('error');
      showToast(err.message, 'error');
    }
  }, 900);
}

function setSaveStatus(state) {
  if (!saveStatusEl) saveStatusEl = document.getElementById('save-status');
  const map = { saving: '↑ Saving…', saved: '✓ Saved', error: '✕ Save failed', '': '' };
  saveStatusEl.textContent = map[state] ?? '';
  saveStatusEl.className = `save-status ${state}`;
}

// ============================================================
// GITHUB SYNC
// ============================================================

async function fetchAllPages(url, headers) {
  const all = [];
  let next = url;
  while (next) {
    const resp = await fetch(next, { headers });
    if (!resp.ok) {
      const remaining = resp.headers.get('X-RateLimit-Remaining');
      if (resp.status === 403 && remaining === '0') {
        throw new Error('GitHub rate limit reached. Add a token in Settings to increase limits (5 000 req/hr).');
      }
      throw new Error(`GitHub API error ${resp.status} for ${next}`);
    }
    const data = await resp.json();
    all.push(...data);
    const link = resp.headers.get('Link') || '';
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    next = match ? match[1] : null;
  }
  return all;
}

async function syncGitHub() {
  const headers = ghHeaders(true);
  const freshItems = [];

  for (const repo of REPOS) {
    const base = `${GH_API}/repos/${repo.owner}/${repo.name}`;

    // Issues (state=all, latest 100 by updated)
    const rawIssues = await fetchAllPages(`${base}/issues?state=all&per_page=100&sort=updated&direction=desc`, headers);
    for (const iss of rawIssues) {
      if (iss.pull_request) continue; // PRs appear in issues endpoint — skip them
      freshItems.push(normalizeIssue(iss, repo));
    }

    // Pull requests (state=all, latest 100)
    const rawPRs = await fetchAllPages(`${base}/pulls?state=all&per_page=100&sort=updated&direction=desc`, headers);
    for (const pr of rawPRs) {
      freshItems.push(normalizePR(pr, repo));
    }
  }

  // Auto-move closed/merged items that are assigned to a track → done
  for (const item of freshItems) {
    if (item.githubState !== 'open') {
      const asgn = getAssignment(item.id);
      if (!asgn.done && asgn.track !== 'inbox') {
        state.assignments[item.id] = { ...asgn, done: true };
      }
    }
  }

  // Preserve manually-added items not found in the GitHub fetch
  const freshIds = new Set(freshItems.map(i => i.id));
  const manualItems = state.items.filter(i => i.isManual && !freshIds.has(i.id));

  state.items    = [...freshItems, ...manualItems];
  state.lastSync = new Date().toISOString();
}

function normalizeIssue(d, repo) {
  return {
    id:          `${repo.owner}/${repo.name}#${d.number}`,
    type:        'issue',
    repoName:    repo.name,
    number:      d.number,
    title:       d.title,
    url:         d.html_url,
    labels:      (d.labels || []).map(l => l.name),
    author:      d.user?.login ?? '?',
    githubState: d.state,           // 'open' | 'closed'
    updatedAt:   d.updated_at,
  };
}

function normalizePR(d, repo) {
  const githubState = d.merged_at ? 'merged' : d.state;
  return {
    id:          `${repo.owner}/${repo.name}#${d.number}`,
    type:        'pr',
    repoName:    repo.name,
    number:      d.number,
    title:       d.title,
    url:         d.html_url,
    labels:      (d.labels || []).map(l => l.name),
    author:      d.user?.login ?? '?',
    githubState,                    // 'open' | 'closed' | 'merged'
    updatedAt:   d.updated_at,
  };
}

// ============================================================
// MANUAL GITHUB ITEMS
// ============================================================

async function fetchGHItemByUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull(?:s)?)\/(\d+)/);
  if (!match) throw new Error('Invalid GitHub URL. Expected: github.com/owner/repo/issues/N or …/pull/N');
  const [, owner, repoName, pathType, numStr] = match;
  const type       = pathType.startsWith('pull') ? 'pr' : 'issue';
  const apiPath    = type === 'pr' ? 'pulls' : 'issues';
  const resp = await fetch(`${GH_API}/repos/${owner}/${repoName}/${apiPath}/${numStr}`, { headers: ghHeaders(true) });
  if (!resp.ok) throw new Error(`GitHub error ${resp.status} — check the URL and your token.`);
  const data = await resp.json();
  const repo = { owner, name: repoName };
  return type === 'pr' ? normalizePR(data, repo) : normalizeIssue(data, repo);
}

function addManualGHItem(item, track, done = false) {
  item = { ...item, isManual: true };
  const idx = state.items.findIndex(i => i.id === item.id);
  if (idx >= 0) state.items[idx] = item;
  else          state.items.push(item);
  state.assignments[item.id] = { track, done };
  scheduleSave();
  renderBoard();
}

// ============================================================
// IDEAS  (local notes, persisted in Gist)
// ============================================================

function addIdea(track, title, body, repo) {
  const idea = {
    id:        `idea-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    track,
    title,
    body:      body || '',
    repo:      repo || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.ideas.push(idea);
  scheduleSave();
  renderBoard();
}

function updateIdea(id, patch) {
  const idx = state.ideas.findIndex(i => i.id === id);
  if (idx === -1) return;
  state.ideas[idx] = { ...state.ideas[idx], ...patch, updatedAt: new Date().toISOString() };
  scheduleSave();
  renderBoard();
}

function deleteIdea(id) {
  state.ideas = state.ideas.filter(i => i.id !== id);
  scheduleSave();
  renderBoard();
}

// ============================================================
// DYNAMIC TRACKS
// ============================================================

function makeTrackBoardHTML(trackId) {
  return `
    <div class="col" id="col-${trackId}-ideas">
      <div class="col-header col-header-ideas"><span class="col-title">Ideas</span><span class="col-count"></span></div>
      <button class="new-idea-btn" data-track="${trackId}">+ New idea</button>
      <div class="col-body"></div>
      <p class="col-empty">No ideas yet.</p>
    </div>
    <div class="col" id="col-${trackId}-issues">
      <div class="col-header col-header-issues"><span class="col-title">Issues</span><span class="col-count"></span></div>
      <button class="new-gh-btn type-issue" data-type="issue" data-track="${trackId}">+ Add issue</button>
      <div class="col-body"></div>
      <p class="col-empty">Assign from Inbox or add manually.</p>
    </div>
    <div class="col" id="col-${trackId}-prs">
      <div class="col-header col-header-prs"><span class="col-title">Pull Requests</span><span class="col-count"></span></div>
      <button class="new-gh-btn type-pr" data-type="pr" data-track="${trackId}">+ Add PR</button>
      <div class="col-body"></div>
      <p class="col-empty">Assign from Inbox or add manually.</p>
    </div>
    <div class="col col-done" id="col-${trackId}-done">
      <div class="col-header col-header-done"><span class="col-title">Done</span><span class="col-count"></span></div>
      <button class="new-gh-btn type-done" data-type="done" data-track="${trackId}">+ Add done item</button>
      <div class="col-body"></div>
      <p class="col-empty">Completed items appear here.</p>
    </div>
  `;
}

// Sync the DOM to match state.customTracks — called on init and whenever tracks change.
function buildCustomTracks() {
  const nav    = document.getElementById('track-nav');
  const boards = document.getElementById('boards-container');

  // Remove stale custom track tabs and board sections
  nav.querySelectorAll('.track-tab.custom-track').forEach(el => el.remove());
  boards.querySelectorAll('.board.custom-track').forEach(el => el.remove());
  document.getElementById('add-track-btn')?.remove();

  for (const track of state.customTracks) {
    // --- Tab ---
    const btn = document.createElement('button');
    btn.className = 'track-tab custom-track';
    btn.dataset.tab = track.id;
    btn.appendChild(document.createTextNode(track.name));

    const badge = document.createElement('span');
    badge.className = 'tab-badge';
    badge.id = `badge-${track.id}`;
    btn.appendChild(badge);

    const closeSpan = document.createElement('span');
    closeSpan.className = 'track-close';
    closeSpan.dataset.trackId = track.id;
    closeSpan.title = 'Remove track';
    closeSpan.textContent = '×';
    btn.appendChild(closeSpan);

    nav.appendChild(btn);

    // --- Board section ---
    const section = document.createElement('section');
    section.className = 'board custom-track';
    section.id = `board-${track.id}`;
    section.innerHTML = makeTrackBoardHTML(track.id);
    boards.appendChild(section);
  }

  // "+" button always at the far right of the nav
  const addBtn = document.createElement('button');
  addBtn.className = 'track-tab track-add-btn';
  addBtn.id = 'add-track-btn';
  addBtn.title = 'Add new track';
  addBtn.textContent = '+';
  nav.appendChild(addBtn);
}

function addTrack(name) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id   = slug + '-' + Math.random().toString(36).slice(2, 6);
  state.customTracks.push({ id, name: name.trim() });
  scheduleSave();
  buildCustomTracks();
  renderBoard();
  // Switch to the newly created tab
  document.querySelector(`[data-tab="${id}"]`)?.click();
}

function confirmDeleteTrack(id) {
  const track = state.customTracks.find(t => t.id === id);
  if (!track) return;
  const itemCount  = state.items.filter(i => getAssignment(i.id).track === id).length;
  const ideaCount  = state.ideas.filter(i => i.track === id).length;
  const total      = itemCount + ideaCount;
  const detail     = total > 0
    ? ` It has ${total} item(s) — issues/PRs will move back to Inbox, ideas will be deleted.`
    : '';
  if (!confirm(`Delete track "${track.name}"?${detail}`)) return;
  deleteTrack(id);
}

function deleteTrack(id) {
  // Move GitHub items back to Inbox
  for (const item of state.items) {
    if (getAssignment(item.id).track === id) {
      state.assignments[item.id] = { track: 'inbox', done: false };
    }
  }
  // Remove ideas belonging to this track
  state.ideas = state.ideas.filter(i => i.track !== id);
  // Remove the track
  state.customTracks = state.customTracks.filter(t => t.id !== id);
  scheduleSave();
  buildCustomTracks();
  // If we just deleted the active tab, fall back to inbox
  if (!document.querySelector('.track-tab.active')) {
    document.querySelector('[data-tab="inbox"]')?.click();
  }
  renderBoard();
}

// ============================================================
// RENDERING
// ============================================================

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)   return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d < 30)   return `${d}d ago`;
  const m = Math.floor(d / 30);
  if (m < 12)   return `${m}mo ago`;
  return `${Math.floor(m / 12)}y ago`;
}

function renderBoard() {
  // Clear all column bodies
  document.querySelectorAll('.col-body').forEach(el => { el.innerHTML = ''; });

  // Place each GitHub item in the right column
  for (const item of state.items) {
    const asgn = getAssignment(item.id);
    let colId;
    if (asgn.track === 'inbox') {
      colId = `col-inbox-${item.type}s`;
    } else if (asgn.done) {
      colId = `col-${asgn.track}-done`;
    } else {
      colId = `col-${asgn.track}-${item.type}s`;
    }
    const col = document.getElementById(colId);
    col?.querySelector('.col-body')?.appendChild(makeGHCard(item, asgn));
  }

  // Place each idea in the right column (done ideas go to the Done column)
  for (const idea of state.ideas) {
    const colId = idea.done ? `col-${idea.track}-done` : `col-${idea.track}-ideas`;
    const col = document.getElementById(colId);
    col?.querySelector('.col-body')?.appendChild(makeIdeaCard(idea));
  }

  updateCounts();
  updateBadges();
  updateSyncStatus();
}

function makeGHCard(item, asgn) {
  const div = document.createElement('div');
  div.className = `card card-gh${item.githubState !== 'open' ? ' card-closed' : ''}`;
  div.dataset.id = item.id;

  const repoCls  = REPO_CSS[item.repoName] || '';
  const typeLabel = item.type === 'pr' ? 'PR' : 'Issue';

  let stateTag = '';
  if (item.githubState === 'merged') stateTag = '<span class="state-tag merged">⌥ Merged</span>';
  else if (item.githubState === 'closed') stateTag = '<span class="state-tag closed">✕ Closed</span>';

  const labelsHtml = item.labels.slice(0, 3)
    .map(l => `<span class="gh-label">${escHtml(l)}</span>`).join('');

  let actions = '';
  if (asgn.track === 'inbox') {
    actions = `
      <button class="act-btn act-assign-ui"   data-action="assign" data-id="${item.id}" data-track="ui-revamp">→ UI Revamp</button>
      <button class="act-btn act-assign-feat" data-action="assign" data-id="${item.id}" data-track="features">→ Features</button>
    `;
  } else if (asgn.done) {
    actions = `<button class="act-btn" data-action="undone" data-id="${item.id}">↩ Reopen</button>`;
  } else {
    actions = `
      <button class="act-btn act-done"  data-action="done"  data-id="${item.id}">✓ Done</button>
      <button class="act-btn"           data-action="inbox" data-id="${item.id}">← Inbox</button>
    `;
  }

  div.innerHTML = `
    <div class="card-tags">
      <span class="repo-tag ${repoCls}">${escHtml(item.repoName)}</span>
      <span class="type-tag type-${item.type}">${typeLabel}${item.number ? ` #${item.number}` : ''}</span>
      ${stateTag}
    </div>
    <div class="card-title">${escHtml(item.title)}</div>
    ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
    <div class="card-foot">
      <span class="card-meta">@${escHtml(item.author)} · ${timeAgo(item.updatedAt)}</span>
      <a class="card-ext-link" href="${item.url}" target="_blank" rel="noopener noreferrer">↗ GitHub</a>
    </div>
    <div class="card-actions">${actions}</div>
  `;
  return div;
}

function makeIdeaCard(idea) {
  const div = document.createElement('div');
  div.className = 'card card-idea';
  div.dataset.id = idea.id;

  const repoCls = REPO_CSS[idea.repo] || '';
  const preview = idea.body ? idea.body.slice(0, 120) + (idea.body.length > 120 ? '…' : '') : '';

  const doneBtn = idea.done
    ? `<button class="act-btn" data-action="undone-idea" data-id="${idea.id}">↩ Reopen</button>`
    : `<button class="act-btn act-done" data-action="done-idea" data-id="${idea.id}">✓ Done</button>`;

  div.innerHTML = `
    <div class="card-tags">
      ${idea.repo ? `<span class="repo-tag ${repoCls}">${escHtml(idea.repo)}</span>` : ''}
      <span class="type-tag type-idea">Idea</span>
    </div>
    <div class="card-title">${escHtml(idea.title)}</div>
    ${preview ? `<div class="card-body-preview">${escHtml(preview)}</div>` : ''}
    <div class="card-foot">
      <span class="card-meta">${timeAgo(idea.createdAt)}</span>
      <div style="display:flex;gap:4px">
        <button class="act-btn" data-action="edit-idea" data-id="${idea.id}">✎ Edit</button>
        <button class="act-btn act-danger" data-action="delete-idea" data-id="${idea.id}">✕</button>
      </div>
    </div>
    <div class="card-actions">${doneBtn}</div>
  `;
  return div;
}

function updateCounts() {
  document.querySelectorAll('.col').forEach(col => {
    const count = col.querySelector('.col-body')?.children.length ?? 0;
    const countEl = col.querySelector('.col-count');
    if (countEl) {
      countEl.textContent = count > 0 ? count : '';
      countEl.style.display = count > 0 ? '' : 'none';
    }
    const emptyEl = col.querySelector('.col-empty');
    if (emptyEl) emptyEl.classList.toggle('visible', count === 0);
  });
}

function updateBadges() {
  const counts = {};
  for (const item of state.items) {
    const asgn = getAssignment(item.id);
    if (!asgn.done) counts[asgn.track] = (counts[asgn.track] || 0) + 1;
  }
  for (const idea of state.ideas) {
    if (!idea.done) counts[idea.track] = (counts[idea.track] || 0) + 1;
  }
  // Update every badge element that exists in the DOM (static + dynamic)
  document.querySelectorAll('.tab-badge[id^="badge-"]').forEach(el => {
    const count = counts[el.id.slice(6)] || 0; // strip "badge-" prefix
    el.textContent = count || '';
    el.style.display = count > 0 ? '' : 'none';
  });
}

function updateSyncStatus() {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = state.lastSync ? `Synced ${timeAgo(state.lastSync)}` : 'Not yet synced';
}

// ============================================================
// TABS
// ============================================================

function initTabs() {
  // Single delegated listener on the nav — covers static and dynamically added tabs
  document.getElementById('track-nav').addEventListener('click', e => {
    // "+" add-track button
    if (e.target.closest('#add-track-btn')) {
      openTrackModal();
      return;
    }
    // "×" close button on custom tracks
    const closeBtn = e.target.closest('.track-close');
    if (closeBtn) {
      e.stopPropagation();
      confirmDeleteTrack(closeBtn.dataset.trackId);
      return;
    }
    // Tab switch
    const tab = e.target.closest('.track-tab');
    if (!tab || tab.id === 'add-track-btn') return;
    document.querySelectorAll('.track-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const id = tab.dataset.tab;
    document.querySelectorAll('.board').forEach(b => {
      b.classList.toggle('show', b.id === `board-${id}`);
    });
  });
}

// ============================================================
// CARD ACTIONS  (event delegation)
// ============================================================

function initCardActions() {
  document.addEventListener('click', e => {
    const newIdeaBtn = e.target.closest('.new-idea-btn');
    if (newIdeaBtn) { openIdeaModal(newIdeaBtn.dataset.track); return; }

    const newGHBtn = e.target.closest('.new-gh-btn');
    if (newGHBtn) { openGHItemModal(newGHBtn.dataset.type, newGHBtn.dataset.track); return; }

    const actBtn = e.target.closest('[data-action]');
    if (!actBtn) return;
    const { action, id, track } = actBtn.dataset;

    switch (action) {
      case 'assign':
        setAssignment(id, { track, done: false });
        break;
      case 'inbox':
        setAssignment(id, { track: 'inbox', done: false });
        break;
      case 'done':
        setAssignment(id, { done: true });
        break;
      case 'undone':
        setAssignment(id, { done: false });
        break;
      case 'done-idea':
        updateIdea(id, { done: true });
        break;
      case 'undone-idea':
        updateIdea(id, { done: false });
        break;
      case 'edit-idea': {
        const idea = state.ideas.find(i => i.id === id);
        if (idea) openIdeaModal(idea.track, idea);
        break;
      }
      case 'delete-idea':
        if (confirm('Delete this idea? This cannot be undone.')) deleteIdea(id);
        break;
    }
  });
}

// ============================================================
// IDEA MODAL
// ============================================================

let ideaModal;

function openIdeaModal(track, idea = null) {
  document.getElementById('idea-id').value           = idea?.id    || '';
  document.getElementById('idea-track').value        = track;
  document.getElementById('idea-title-input').value  = idea?.title || '';
  document.getElementById('idea-body-input').value   = idea?.body  || '';
  document.getElementById('idea-repo-input').value   = idea?.repo  || '';
  document.getElementById('idea-modal-title').textContent = idea ? 'Edit Idea' : 'New Idea';
  ideaModal.showModal();
}

function initIdeaModal() {
  ideaModal = document.getElementById('idea-modal');
  document.getElementById('close-idea-modal').addEventListener('click', () => ideaModal.close());
  document.getElementById('cancel-idea').addEventListener('click', () => ideaModal.close());
  document.getElementById('idea-form').addEventListener('submit', e => {
    e.preventDefault();
    const id    = document.getElementById('idea-id').value;
    const track = document.getElementById('idea-track').value;
    const title = document.getElementById('idea-title-input').value.trim();
    const body  = document.getElementById('idea-body-input').value.trim();
    const repo  = document.getElementById('idea-repo-input').value;
    if (!title) return;
    if (id) updateIdea(id, { title, body, repo });
    else    addIdea(track, title, body, repo);
    ideaModal.close();
  });
}

// ============================================================
// SETTINGS MODAL
// ============================================================

let settingsModal;

function openSettings() {
  const tokenInput = document.getElementById('cfg-token');
  const gistInput  = document.getElementById('cfg-gist');
  tokenInput.value = cfg.token;
  gistInput.value  = cfg.gistId;
  updateShareHint(cfg.gistId);
  settingsModal.showModal();
}

function updateShareHint(gistId) {
  const el = document.getElementById('share-hint');
  if (!el) return;
  el.style.display = gistId ? '' : 'none';
}

function initSettingsModal() {
  settingsModal = document.getElementById('settings-modal');

  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('close-settings').addEventListener('click', () => settingsModal.close());
  document.getElementById('cancel-settings').addEventListener('click', () => settingsModal.close());

  document.getElementById('toggle-token').addEventListener('click', () => {
    const inp = document.getElementById('cfg-token');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    document.getElementById('toggle-token').textContent = inp.type === 'password' ? '👁' : '🙈';
  });

  document.getElementById('create-gist-btn').addEventListener('click', async () => {
    const tokenVal = document.getElementById('cfg-token').value.trim();
    if (!tokenVal) { showToast('Enter your GitHub token first.', 'error'); return; }
    cfg.token = tokenVal; // temporarily so createNewGist can use it
    const btn = document.getElementById('create-gist-btn');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const id = await createNewGist();
      document.getElementById('cfg-gist').value = id;
      updateShareHint(id);
      showToast('Gist created! Save settings to use it.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create new';
    }
  });

  document.getElementById('save-settings').addEventListener('click', async () => {
    const tokenVal = document.getElementById('cfg-token').value.trim();
    const gistVal  = document.getElementById('cfg-gist').value.trim();
    cfg.token  = tokenVal;
    cfg.gistId = gistVal;
    settingsModal.close();

    if (gistVal) {
      showLoading('Loading board from Gist…');
      try {
        await loadFromGist();
        renderBoard();
        showToast('Board loaded.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        hideLoading();
      }
    }
  });
}

// ============================================================
// SYNC BUTTON
// ============================================================

function initSyncButton() {
  const btn = document.getElementById('sync-btn');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '↻ Syncing…';
    try {
      await syncGitHub();
      scheduleSave();
      renderBoard();
      showToast(`Synced ${state.items.length} items from GitHub.`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Sync';
    }
  });
}

// ============================================================
// TOASTS
// ============================================================

function showToast(msg, type = 'info') {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  requestAnimationFrame(() => { requestAnimationFrame(() => el.classList.add('show')); });
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 4500);
}

// ============================================================
// LOADING VEIL
// ============================================================

function showLoading(msg = 'Loading…') {
  const veil = document.getElementById('loading-veil');
  document.getElementById('loading-msg').textContent = msg;
  veil.style.display = 'flex';
}

function hideLoading() {
  document.getElementById('loading-veil').style.display = 'none';
}

// ============================================================
// GITHUB ITEM MODAL
// ============================================================

let ghItemModal;
let ghFetchedItem = null;

function openGHItemModal(type, track) {
  const isDone = type === 'done';
  document.getElementById('gh-item-type').value  = isDone ? 'issue' : type; // 'done' type defaults to issue
  document.getElementById('gh-item-track').value = track;
  document.getElementById('gh-item-done').value  = isDone ? '1' : '';
  document.getElementById('gh-modal-title').textContent =
    isDone ? 'Add Done Item' : type === 'pr' ? 'Add Pull Request' : 'Add Issue';
  document.getElementById('gh-item-url').value   = '';
  document.getElementById('gh-item-title').value = '';
  const hint = document.getElementById('gh-fetch-hint');
  hint.textContent = 'Paste the URL and click Fetch to auto-fill, or enter the title manually.';
  hint.className   = 'field-hint';
  ghFetchedItem    = null;
  ghItemModal.showModal();
  document.getElementById('gh-item-url').focus();
}

function initGHItemModal() {
  ghItemModal = document.getElementById('gh-item-modal');
  document.getElementById('close-gh-modal').addEventListener('click',  () => ghItemModal.close());
  document.getElementById('cancel-gh-item').addEventListener('click', () => ghItemModal.close());

  document.getElementById('fetch-gh-btn').addEventListener('click', async () => {
    const url     = document.getElementById('gh-item-url').value.trim();
    const hint    = document.getElementById('gh-fetch-hint');
    const fetchBtn = document.getElementById('fetch-gh-btn');
    fetchBtn.disabled    = true;
    fetchBtn.textContent = 'Fetching…';
    hint.textContent     = '';
    hint.className       = 'field-hint';
    try {
      ghFetchedItem = await fetchGHItemByUrl(url);
      document.getElementById('gh-item-title').value = ghFetchedItem.title;
      // Override type to match what was actually fetched
      document.getElementById('gh-item-type').value = ghFetchedItem.type;
      hint.textContent = `✓ Found: ${ghFetchedItem.repoName} #${ghFetchedItem.number} (${ghFetchedItem.githubState})`;
      hint.className   = 'field-hint gh-fetch-ok';
    } catch (err) {
      hint.textContent = `✕ ${err.message}`;
      hint.className   = 'field-hint gh-fetch-err';
    } finally {
      fetchBtn.disabled    = false;
      fetchBtn.textContent = 'Fetch';
    }
  });

  document.getElementById('gh-item-form').addEventListener('submit', e => {
    e.preventDefault();
    const type  = document.getElementById('gh-item-type').value;
    const track = document.getElementById('gh-item-track').value;
    const done  = !!document.getElementById('gh-item-done').value;
    const title = document.getElementById('gh-item-title').value.trim();
    if (!title) return;

    let item = ghFetchedItem;
    if (!item) {
      // No fetch → build a minimal item from the URL (or just a title-only placeholder)
      const url   = document.getElementById('gh-item-url').value.trim();
      const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull(?:s)?)\/(\d+)/);
      if (match) {
        const [, owner, repoName, , numStr] = match;
        item = {
          id:          `${owner}/${repoName}#${numStr}`,
          type,
          repoName,
          number:      parseInt(numStr),
          title,
          url,
          labels:      [],
          author:      '?',
          githubState: 'open',
          updatedAt:   new Date().toISOString(),
        };
      } else {
        // No URL → create a freeform placeholder (useful for "done" items)
        const slug = `manual-${Date.now()}`;
        item = {
          id:          slug,
          type,
          repoName:    '',
          number:      null,
          title,
          url:         '',
          labels:      [],
          author:      '?',
          githubState: done ? 'closed' : 'open',
          updatedAt:   new Date().toISOString(),
        };
      }
    }

    addManualGHItem(item, track, done);
    ghItemModal.close();
  });
}

// ============================================================
// TRACK MODAL
// ============================================================

let trackModal;

function openTrackModal() {
  document.getElementById('track-name-input').value = '';
  trackModal.showModal();
  document.getElementById('track-name-input').focus();
}

function initTrackModal() {
  trackModal = document.getElementById('track-modal');
  document.getElementById('close-track-modal').addEventListener('click', () => trackModal.close());
  document.getElementById('cancel-track').addEventListener('click', () => trackModal.close());
  document.getElementById('track-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('track-name-input').value.trim();
    if (!name) return;
    addTrack(name);
    trackModal.close();
  });
}

// ============================================================
// INIT
// ============================================================

async function init() {
  loadStateFromStorage(); // restore cached state (ideas, assignments, items) synchronously

  initTabs();         // event delegation — must run before any tabs exist
  buildCustomTracks(); // append custom track tabs + boards from state
  initCardActions();
  initIdeaModal();
  initGHItemModal();
  initTrackModal();
  initSettingsModal();
  initSyncButton();
  renderBoard(); // render from cache immediately — no flash of empty board

  if (!cfg.gistId) {
    showToast('Welcome! Open ⚙ Settings to connect your GitHub Gist.', 'info');
    return;
  }

  // Silently refresh from Gist in background (don't block on the veil unless cache is empty)
  const hasCache = state.items.length > 0 || state.ideas.length > 0;
  if (!hasCache) showLoading('Loading board…');
  try {
    await loadFromGist();
    saveStateToStorage();
    buildCustomTracks(); // remote state may have custom tracks not yet in DOM
    renderBoard();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    hideLoading();
  }
}

document.addEventListener('DOMContentLoaded', init);
