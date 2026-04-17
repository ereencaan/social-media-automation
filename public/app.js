/* =======================================================================
   Hitra frontend — vanilla JS SPA
   Views: dashboard, leads (kanban + drawer), posts, brand, settings.
   ======================================================================= */
'use strict';

// ---- tiny DOM helpers ----------------------------------------------------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
};
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));

// ---- API client ----------------------------------------------------------
async function api(path, { method = 'GET', body, query } = {}) {
  const url = new URL(path, window.location.origin);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.error) || res.statusText || 'Request failed';
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---- toast notifications -------------------------------------------------
function toast(message, kind = 'info', timeoutMs = 3500) {
  const stack = $('#toast-stack');
  const t = el('div', { class: `toast ${kind}` }, message);
  stack.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity 0.2s';
    setTimeout(() => t.remove(), 220);
  }, timeoutMs);
}

// ---- auth state ----------------------------------------------------------
const State = {
  user: null,
  route: 'dashboard',
};

async function loadSession() {
  try {
    State.user = await api('/api/auth/me');
    return true;
  } catch (e) {
    State.user = null;
    return false;
  }
}

function renderAuthScreen() {
  $('#auth-screen').classList.remove('hidden');
  $('#app-shell').classList.add('hidden');

  // Tabs
  $$('.auth-tabs .tab').forEach(btn => btn.onclick = () => {
    $$('.auth-tabs .tab').forEach(b => b.classList.toggle('active', b === btn));
    const isLogin = btn.dataset.tab === 'login';
    $('#login-form').classList.toggle('hidden', !isLogin);
    $('#register-form').classList.toggle('hidden', isLogin);
  });

  // Login
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const errBox = $('#login-error');
    errBox.classList.remove('show');
    const fd = new FormData(e.target);
    try {
      const user = await api('/api/auth/login', {
        method: 'POST',
        body: { email: fd.get('email'), password: fd.get('password') },
      });
      State.user = user;
      await bootApp();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
    }
  };

  // Register
  $('#register-form').onsubmit = async (e) => {
    e.preventDefault();
    const errBox = $('#register-error');
    errBox.classList.remove('show');
    const fd = new FormData(e.target);
    try {
      const user = await api('/api/auth/register', {
        method: 'POST',
        body: {
          email: fd.get('email'),
          password: fd.get('password'),
          name: fd.get('name') || undefined,
          orgName: fd.get('orgName'),
        },
      });
      State.user = user;
      toast('Welcome to Hitra 👋', 'success');
      await bootApp();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
    }
  };
}

// =======================================================================
//   APP SHELL — mount after auth
// =======================================================================
async function bootApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');

  const u = State.user;
  $('#sidebar-org').textContent = 'Workspace';
  $('#user-name').textContent = u.name || u.email;
  $('#user-email').textContent = u.email;
  const initial = ((u.name || u.email) || '?').trim()[0].toUpperCase();
  $('#user-avatar').textContent = initial;

  // Wire nav
  $$('.nav-item').forEach(item => {
    item.onclick = () => navigate(item.dataset.route);
  });

  // Logout
  $('#btn-logout').onclick = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    State.user = null;
    renderAuthScreen();
  };

  // Route from hash or default
  const initialRoute = (location.hash.replace('#', '') || 'dashboard');
  navigate(initialRoute, { replace: true });

  window.addEventListener('hashchange', () => {
    navigate(location.hash.replace('#', '') || 'dashboard', { replace: true });
  });
}

// ---- router --------------------------------------------------------------
const VIEWS = {};
function navigate(route, { replace = false } = {}) {
  if (!VIEWS[route]) route = 'dashboard';
  State.route = route;
  if (!replace) location.hash = route;
  else if (location.hash.replace('#','') !== route) {
    history.replaceState(null, '', '#' + route);
  }
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.route === route));
  const titles = {
    dashboard: 'Dashboard',
    leads: 'Leads',
    posts: 'Posts',
    brand: 'Brand',
    settings: 'Settings',
  };
  $('#page-title').textContent = titles[route] || route;
  $('#topbar-actions').innerHTML = '';
  $('#page').innerHTML = '';
  VIEWS[route]($('#page'));
}

// =======================================================================
//   VIEW: DASHBOARD
// =======================================================================
VIEWS.dashboard = async function dashboardView(root) {
  root.innerHTML = '<div class="loading"></div>';
  let leads = [], posts = [];
  try {
    [leads, posts] = await Promise.all([
      api('/api/leads').catch(() => []),
      api('/api/posts').catch(() => []),
    ]);
  } catch {}

  const count = (status) => leads.filter(l => l.status === status).length;
  const stats = [
    { title: 'Total leads', value: leads.length, hint: 'All pipeline stages' },
    { title: 'New', value: count('new'), hint: 'Awaiting first contact' },
    { title: 'Qualified', value: count('qualified'), hint: 'Ready to convert' },
    { title: 'Won', value: count('won'), hint: 'Closed deals' },
    { title: 'Posts', value: posts.length, hint: 'Content in workspace' },
  ];

  root.innerHTML = '';
  root.appendChild(el('div', { class: 'stats-grid' },
    ...stats.map(s => el('div', { class: 'card' },
      el('div', { class: 'card-title' }, s.title),
      el('div', { class: 'card-value' }, String(s.value)),
      el('div', { class: 'card-hint' }, s.hint),
    )),
  ));

  // Recent leads table
  const section = el('div', { class: 'card' });
  section.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Recent leads'),
    el('a', { class: 'section-sub', href: '#leads', onclick: (e) => { e.preventDefault(); navigate('leads'); } }, 'View all →'),
  ));

  if (!leads.length) {
    section.appendChild(el('div', { class: 'empty-state' },
      el('h3', {}, 'No leads yet'),
      el('p', {}, 'Add your first lead or wire up a webhook to start seeing activity here.'),
      el('button', { class: 'btn btn-primary', onclick: () => navigate('leads') }, 'Go to Leads'),
    ));
  } else {
    const recent = leads.slice(0, 5);
    const rows = recent.map(l => el('tr', { class: 'clickable', onclick: () => { navigate('leads'); setTimeout(() => openLeadDrawer(l.id), 50); } },
      el('td', {}, l.name || '—'),
      el('td', {}, l.email || l.phone || '—'),
      el('td', {}, renderBadge(l.status)),
      el('td', {}, l.source || 'manual'),
      el('td', {}, formatDate(l.created_at)),
    ));
    section.appendChild(el('div', { class: 'table-wrap' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Name'), el('th', {}, 'Contact'), el('th', {}, 'Status'),
          el('th', {}, 'Source'), el('th', {}, 'Created'))),
        el('tbody', {}, ...rows),
      ),
    ));
  }

  root.appendChild(section);
};

// =======================================================================
//   VIEW: LEADS (kanban)
// =======================================================================
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost'];

VIEWS.leads = async function leadsView(root) {
  // Topbar action: New lead
  const btnNew = el('button', { class: 'btn btn-primary', onclick: () => openNewLeadModal() }, '+ New lead');
  $('#topbar-actions').appendChild(btnNew);

  root.innerHTML = '<div class="loading"></div>';
  let leads = [];
  try { leads = await api('/api/leads'); } catch (e) { toast(e.message, 'error'); leads = []; }

  root.innerHTML = '';
  if (!leads.length) {
    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'empty-state' },
        el('h3', {}, 'Your CRM is empty'),
        el('p', {}, 'Add leads manually or connect a channel (Instagram DM, LinkedIn, webhook intake).'),
        el('button', { class: 'btn btn-primary', onclick: () => openNewLeadModal() }, 'Add first lead'),
      ),
    ));
    return;
  }

  const board = el('div', { class: 'kanban' });
  for (const status of LEAD_STATUSES) {
    const filtered = leads.filter(l => l.status === status);
    const col = el('div', { class: 'kanban-col' },
      el('div', { class: 'kanban-col-header' },
        el('div', { class: 'kanban-col-title' }, renderBadge(status)),
        el('div', { class: 'kanban-col-count' }, String(filtered.length)),
      ),
      el('div', { class: 'kanban-col-body' },
        ...filtered.map(renderLeadCard),
      ),
    );
    board.appendChild(col);
  }
  root.appendChild(board);
};

function renderLeadCard(lead) {
  return el('div', { class: 'lead-card', onclick: () => openLeadDrawer(lead.id) },
    el('div', { class: 'lead-card-name' }, lead.name || '(no name)'),
    el('div', { class: 'lead-card-meta' },
      lead.email ? el('span', {}, '✉ ' + lead.email) : null,
      lead.phone ? el('span', {}, '☎ ' + lead.phone) : null,
    ),
    el('div', { class: 'lead-card-footer' },
      el('span', {}, lead.source || 'manual'),
      el('span', {}, formatDate(lead.created_at, { dateOnly: true })),
    ),
  );
}

function renderBadge(status) {
  return el('span', { class: `badge badge-${status || 'new'}` }, status || 'new');
}

// ---- new lead modal (reuses drawer) --------------------------------------
function openNewLeadModal() {
  const drawer = $('#drawer');
  const backdrop = $('#drawer-backdrop');
  drawer.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  backdrop.onclick = closeDrawer;

  drawer.innerHTML = '';
  drawer.appendChild(el('div', { class: 'drawer-header' },
    el('div', { class: 'drawer-title' }, 'New lead'),
    el('button', { class: 'icon-btn', onclick: closeDrawer }, '✕'),
  ));

  const form = el('form', { class: 'drawer-body' });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      name: fd.get('name') || null,
      email: fd.get('email') || null,
      phone: fd.get('phone') || null,
      source: fd.get('source') || 'manual',
      status: fd.get('status') || 'new',
      notes: fd.get('notes') || null,
    };
    try {
      await api('/api/leads', { method: 'POST', body });
      toast('Lead created', 'success');
      closeDrawer();
      navigate('leads', { replace: true });
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  form.appendChild(el('div', { class: 'field' },
    el('label', {}, 'Name', el('input', { type: 'text', name: 'name', placeholder: 'Jane Doe' })),
  ));
  form.appendChild(el('div', { class: 'row' },
    el('div', { class: 'field' },
      el('label', {}, 'Email', el('input', { type: 'email', name: 'email', placeholder: 'jane@example.com' })),
    ),
    el('div', { class: 'field' },
      el('label', {}, 'Phone', el('input', { type: 'tel', name: 'phone', placeholder: '+1 555 555 5555' })),
    ),
  ));
  form.appendChild(el('div', { class: 'row' },
    el('div', { class: 'field' },
      el('label', {}, 'Source',
        (() => {
          const s = el('select', { name: 'source' });
          ['manual','instagram_dm','linkedin','website','referral','other'].forEach(v =>
            s.appendChild(el('option', { value: v }, v)));
          return s;
        })(),
      ),
    ),
    el('div', { class: 'field' },
      el('label', {}, 'Status',
        (() => {
          const s = el('select', { name: 'status' });
          LEAD_STATUSES.forEach(v => s.appendChild(el('option', { value: v }, v)));
          return s;
        })(),
      ),
    ),
  ));
  form.appendChild(el('div', { class: 'field' },
    el('label', {}, 'Notes', el('textarea', { name: 'notes', placeholder: 'Context or next steps…' })),
  ));
  form.appendChild(el('div', { class: 'form-actions' },
    el('button', { type: 'button', class: 'btn btn-ghost', onclick: closeDrawer }, 'Cancel'),
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Create lead'),
  ));

  drawer.appendChild(form);
}

// ---- lead detail drawer --------------------------------------------------
async function openLeadDrawer(leadId) {
  const drawer = $('#drawer');
  const backdrop = $('#drawer-backdrop');
  drawer.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  backdrop.onclick = closeDrawer;
  drawer.innerHTML = '<div class="drawer-body"><div class="loading"></div></div>';

  let lead, activities = [];
  try {
    [lead, activities] = await Promise.all([
      api('/api/leads/' + leadId),
      api('/api/leads/' + leadId + '/activities').catch(() => []),
    ]);
  } catch (e) {
    toast(e.message, 'error');
    closeDrawer();
    return;
  }

  const renderDrawer = () => {
    drawer.innerHTML = '';
    drawer.appendChild(el('div', { class: 'drawer-header' },
      el('div', {},
        el('div', { class: 'drawer-title' }, lead.name || '(no name)'),
        el('div', { style: 'margin-top:4px' }, renderBadge(lead.status)),
      ),
      el('button', { class: 'icon-btn', onclick: closeDrawer }, '✕'),
    ));

    const body = el('div', { class: 'drawer-body' });

    // Status change
    const statusSection = el('div', { class: 'drawer-section' },
      el('h4', {}, 'Move to stage'),
      el('div', { style: 'display:flex; gap:6px; flex-wrap:wrap' },
        ...LEAD_STATUSES.map(s => el('button', {
          class: 'btn btn-sm ' + (s === lead.status ? 'btn-primary' : 'btn-ghost'),
          onclick: async () => {
            if (s === lead.status) return;
            try {
              lead = await api('/api/leads/' + leadId, { method: 'PUT', body: { status: s } });
              activities = await api('/api/leads/' + leadId + '/activities');
              toast('Moved to ' + s, 'success');
              renderDrawer();
            } catch (e) { toast(e.message, 'error'); }
          },
        }, s)),
      ),
    );
    body.appendChild(statusSection);

    // Contact info
    body.appendChild(el('div', { class: 'drawer-section' },
      el('h4', {}, 'Contact'),
      el('dl', { class: 'kv-list' },
        el('dt', {}, 'Email'),    el('dd', {}, lead.email || '—'),
        el('dt', {}, 'Phone'),    el('dd', {}, lead.phone || '—'),
        el('dt', {}, 'Source'),   el('dd', {}, lead.source || 'manual'),
        el('dt', {}, 'Ref'),      el('dd', {}, lead.source_ref || '—'),
        el('dt', {}, 'Created'),  el('dd', {}, formatDate(lead.created_at)),
      ),
    ));

    // Notes
    if (lead.notes) {
      body.appendChild(el('div', { class: 'drawer-section' },
        el('h4', {}, 'Notes'),
        el('div', { style: 'white-space:pre-wrap; font-size:13px' }, lead.notes),
      ));
    }

    // Add activity
    const addForm = el('form', { class: 'drawer-section' });
    addForm.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(addForm);
      try {
        await api('/api/leads/' + leadId + '/activities', {
          method: 'POST',
          body: { type: fd.get('type'), content: fd.get('content') },
        });
        addForm.reset();
        activities = await api('/api/leads/' + leadId + '/activities');
        toast('Activity added', 'success');
        renderDrawer();
      } catch (err) { toast(err.message, 'error'); }
    };
    addForm.appendChild(el('h4', {}, 'Log activity'));
    addForm.appendChild(el('div', { class: 'row' },
      el('div', { class: 'field' },
        el('label', {}, 'Type', (() => {
          const s = el('select', { name: 'type' });
          ['note','email','call','message','assignment'].forEach(v =>
            s.appendChild(el('option', { value: v }, v)));
          return s;
        })()),
      ),
      el('div', {}),
    ));
    addForm.appendChild(el('div', { class: 'field' },
      el('label', {}, 'Content',
        el('textarea', { name: 'content', required: true, placeholder: 'What happened?' })),
    ));
    addForm.appendChild(el('div', { style: 'text-align:right' },
      el('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, 'Add activity'),
    ));
    body.appendChild(addForm);

    // Timeline
    body.appendChild(el('div', { class: 'drawer-section' },
      el('h4', {}, `Activity (${activities.length})`),
      activities.length
        ? el('div', { class: 'activity-list' },
            ...activities.map(a => el('div', { class: 'activity-item' },
              el('div', { class: 'activity-top' },
                el('span', { class: 'activity-type' }, a.type),
                el('span', {}, formatDate(a.created_at)),
              ),
              el('div', { class: 'activity-content' }, a.content || '—'),
            )))
        : el('div', { class: 'empty-state', style: 'padding:20px' }, 'No activity yet.'),
    ));

    // Danger
    body.appendChild(el('div', { class: 'drawer-section' },
      el('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
        if (!confirm('Delete this lead? This cannot be undone.')) return;
        try {
          await api('/api/leads/' + leadId, { method: 'DELETE' });
          toast('Lead deleted', 'success');
          closeDrawer();
          navigate('leads', { replace: true });
        } catch (e) { toast(e.message, 'error'); }
      } }, 'Delete lead'),
    ));

    drawer.appendChild(body);
  };

  renderDrawer();
}

function closeDrawer() {
  $('#drawer').classList.add('hidden');
  $('#drawer-backdrop').classList.add('hidden');
}

// =======================================================================
//   VIEW: POSTS
// =======================================================================
VIEWS.posts = async function postsView(root) {
  root.innerHTML = '';

  // Generator card
  const gen = el('div', { class: 'generator' });
  gen.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Generate with AI'),
    el('div', { class: 'section-sub' }, 'Claude writes the caption, Flux/Runway renders the media.'),
  ));

  const form = el('form');
  form.appendChild(el('div', { class: 'field' },
    el('label', {}, 'Prompt',
      el('textarea', { name: 'prompt', required: true, placeholder: 'e.g. Announce our Q2 product launch with a confident, premium tone.' })),
  ));
  form.appendChild(el('div', { class: 'row' },
    el('div', { class: 'field' },
      el('label', {}, 'Platforms',
        (() => {
          const s = el('select', { name: 'platforms' });
          [
            ['instagram', 'Instagram'],
            ['linkedin', 'LinkedIn'],
            ['facebook', 'Facebook'],
          ].forEach(([v, t]) => s.appendChild(el('option', { value: v }, t)));
          return s;
        })(),
      ),
    ),
    el('div', { class: 'field' },
      el('label', {}, 'Format',
        (() => {
          const s = el('select', { name: 'format' });
          [
            ['image', 'Image (Flux)'],
            ['video', 'Video / Reel (Runway)'],
          ].forEach(([v, t]) => s.appendChild(el('option', { value: v }, t)));
          return s;
        })(),
      ),
    ),
  ));
  form.appendChild(el('div', { class: 'form-actions' },
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Generate'),
  ));

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const platform = fd.get('platforms');
    const format = fd.get('format');
    const endpoint = format === 'video' ? '/api/posts/generate-video' : '/api/posts/generate';
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> Generating…';
    try {
      await api(endpoint, { method: 'POST', body: { prompt: fd.get('prompt'), platforms: [platform] } });
      toast('Post generated', 'success');
      form.reset();
      navigate('posts', { replace: true });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate';
    }
  };
  gen.appendChild(form);
  root.appendChild(gen);

  // Post list
  let posts = [];
  try { posts = await api('/api/posts'); } catch (e) { toast(e.message, 'error'); }

  if (!posts.length) {
    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'empty-state' },
        el('h3', {}, 'No posts yet'),
        el('p', {}, 'Use the generator above to create your first piece of content.'),
      ),
    ));
    return;
  }

  const grid = el('div', { class: 'post-grid' });
  for (const p of posts) {
    grid.appendChild(el('div', { class: 'post-thumb' },
      p.drive_url ? el('img', { src: p.drive_url, alt: '' }) : el('div', { style: 'aspect-ratio:1; background:var(--bg-soft)' }),
      el('div', { class: 'post-thumb-body' },
        el('div', { class: 'post-thumb-caption' }, p.caption || p.prompt || ''),
        el('div', { class: 'lead-card-footer' },
          el('span', {}, p.status || 'draft'),
          el('span', {}, formatDate(p.created_at, { dateOnly: true })),
        ),
      ),
    ));
  }
  root.appendChild(grid);
};

// =======================================================================
//   VIEW: BRAND
// =======================================================================
VIEWS.brand = async function brandView(root) {
  root.innerHTML = '<div class="loading"></div>';
  let brand = null;
  try { brand = await api('/api/brand'); } catch (e) { /* brand route may not exist yet */ }
  brand = brand || {};

  root.innerHTML = '';
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Brand settings'),
    el('div', { class: 'section-sub' }, 'Applied to every post as an overlay.'),
  ));

  const form = el('form');
  const fields = [
    ['logo_url',      'Logo URL',     'https://…'],
    ['phone',         'Phone',        '+44 7407 040008'],
    ['website',       'Website',      'hitratech.co.uk'],
    ['primary_color', 'Primary color','#6366f1'],
  ];
  for (const [name, label, ph] of fields) {
    form.appendChild(el('div', { class: 'field' },
      el('label', {}, label,
        el('input', { type: 'text', name, placeholder: ph, value: brand[name] || '' })),
    ));
  }
  form.appendChild(el('div', { class: 'form-actions' },
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save'),
  ));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = Object.fromEntries(fd.entries());
    try {
      await api('/api/brand', { method: 'PUT', body });
      toast('Brand saved', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  card.appendChild(form);
  root.appendChild(card);
};

// =======================================================================
//   VIEW: SETTINGS
// =======================================================================
VIEWS.settings = async function settingsView(root) {
  const u = State.user;
  root.innerHTML = '';
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Account'),
    el('div', { class: 'section-sub' }, 'Your profile & workspace'),
  ));
  card.appendChild(el('dl', { class: 'kv-list' },
    el('dt', {}, 'Name'),       el('dd', {}, u.name || '—'),
    el('dt', {}, 'Email'),      el('dd', {}, u.email),
    el('dt', {}, 'Role'),       el('dd', {}, u.role),
    el('dt', {}, 'Org ID'),     el('dd', {}, u.orgId),
    el('dt', {}, 'Member since'), el('dd', {}, u.createdAt ? formatDate(u.createdAt) : '—'),
  ));
  card.appendChild(el('div', { class: 'form-actions' },
    el('button', { class: 'btn btn-danger', onclick: async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
      State.user = null;
      renderAuthScreen();
    } }, 'Log out'),
  ));
  root.appendChild(card);
};

// ---- date helper --------------------------------------------------------
function formatDate(s, { dateOnly = false } = {}) {
  if (!s) return '—';
  const d = new Date(s.replace ? s.replace(' ', 'T') + 'Z' : s);
  if (isNaN(d)) return s;
  if (dateOnly) return d.toLocaleDateString();
  return d.toLocaleString();
}

// =======================================================================
//   BOOTSTRAP
// =======================================================================
(async function main() {
  const ok = await loadSession();
  if (ok) await bootApp();
  else renderAuthScreen();
})();
