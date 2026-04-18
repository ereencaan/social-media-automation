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

function wirePasswordToggles(root = document) {
  $$('.pw-toggle', root).forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.onclick = () => {
      const input = btn.parentElement.querySelector('input');
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.querySelector('.eye-on').classList.toggle('hidden', show);
      btn.querySelector('.eye-off').classList.toggle('hidden', !show);
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    };
  });
}

function renderAuthScreen() {
  $('#auth-screen').classList.remove('hidden');
  $('#app-shell').classList.add('hidden');
  wirePasswordToggles();

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
        body: {
          email: String(fd.get('email') || '').trim(),
          // Trim pasted whitespace (common when copying creds). Real
          // passwords with leading/trailing spaces are vanishingly rare.
          password: String(fd.get('password') || '').trim(),
        },
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
          email: String(fd.get('email') || '').trim(),
          password: String(fd.get('password') || '').trim(),
          name: (fd.get('name') || '').trim() || undefined,
          orgName: String(fd.get('orgName') || '').trim(),
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

  // Only fires on browser back/forward now — navigate() mutates history
  // directly without emitting hashchange, so there's no double-render.
  window.addEventListener('popstate', () => {
    navigate(location.hash.replace('#', '') || 'dashboard', { replace: true });
  });
}

// ---- router --------------------------------------------------------------
const VIEWS = {};
// Monotonic generation counter so async view renders can detect when they're
// stale (e.g. a second navigate() was called before the first one's awaits
// finished) and bail out instead of appending duplicate DOM.
let renderGen = 0;
State.renderGen = () => renderGen;

function navigate(route, { replace = false } = {}) {
  if (!VIEWS[route]) route = 'dashboard';
  State.route = route;

  // Update the hash WITHOUT triggering hashchange — we render directly below.
  const wanted = '#' + route;
  if (location.hash !== wanted) {
    if (replace) history.replaceState(null, '', wanted);
    else history.pushState(null, '', wanted);
  }

  renderGen++;
  const myGen = renderGen;

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
  // Views may await network before filling #page. If another navigate fires
  // in the meantime, renderGen will differ and the stale render will bail.
  Promise.resolve(VIEWS[route]($('#page'), myGen)).catch((err) => {
    console.error('[view ' + route + ']', err);
  });
}

// Helper views use to abort stale renders
function stale(myGen) { return myGen !== renderGen; }

// =======================================================================
//   VIEW: DASHBOARD
// =======================================================================
VIEWS.dashboard = async function dashboardView(root, myGen) {
  root.innerHTML = '<div class="loading"></div>';
  let leads = [], posts = [];
  try {
    [leads, posts] = await Promise.all([
      api('/api/leads').catch(() => []),
      api('/api/posts').catch(() => []),
    ]);
  } catch {}
  if (stale(myGen)) return;

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

VIEWS.leads = async function leadsView(root, myGen) {
  // Topbar action: New lead
  const btnNew = el('button', { class: 'btn btn-primary', onclick: () => openNewLeadModal() }, '+ New lead');
  $('#topbar-actions').appendChild(btnNew);

  root.innerHTML = '<div class="loading"></div>';
  let leads = [];
  try { leads = await api('/api/leads'); } catch (e) { toast(e.message, 'error'); leads = []; }
  if (stale(myGen)) return;

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
VIEWS.posts = async function postsView(root, myGen) {
  root.innerHTML = '';

  // Pre-fetch the brand so we know whether a business profile is set up
  let brand = {};
  try { brand = await api('/api/brand'); } catch {}
  // Bail if the user navigated elsewhere while we were awaiting
  if (stale(myGen)) return;
  const hasBizProfile = !!(brand.business_name || brand.business_description || brand.industry);

  // Generator card
  const gen = el('div', { class: 'generator' });
  gen.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Generate with AI'),
    el('div', { class: 'section-sub' },
      hasBizProfile
        ? `On-brand mode: posts will match ${brand.business_name || 'your business'}.`
        : 'Set up your Business profile for on-brand content.',
    ),
  ));

  // Nudge to set up profile if missing
  if (!hasBizProfile) {
    gen.appendChild(el('div', { class: 'notice', style: 'margin-bottom:16px' },
      el('strong', {}, 'Heads up — '),
      'without a Business profile, AI produces generic content. ',
      el('a', { class: 'notice-link', href: '#brand', onclick: (e) => { e.preventDefault(); navigate('brand'); } },
        'Set up your business →'),
    ));
  }

  const form = el('form');
  form.appendChild(el('div', { class: 'field' },
    el('label', {}, 'What should this post be about?',
      el('textarea', { name: 'prompt', required: true, rows: 3,
        placeholder: hasBizProfile
          ? 'e.g. Valentine\'s day sale — 50% off this week.  (We\'ll make it fit your business automatically.)'
          : 'e.g. Announce our Q2 product launch with a confident, premium tone.',
      })),
  ));
  form.appendChild(el('div', { class: 'row' },
    el('div', { class: 'field' },
      el('label', {}, 'Platform',
        (() => {
          const s = el('select', { name: 'platforms' });
          [
            ['instagram', 'Instagram'],
            ['linkedin',  'LinkedIn'],
            ['facebook',  'Facebook'],
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

  // On-brand toggle — visible only if a business profile exists
  if (hasBizProfile) {
    form.appendChild(el('div', { class: 'field' },
      el('label', { class: 'switch-row' },
        el('input', { type: 'checkbox', name: 'onBrand', checked: 'checked' }),
        el('span', { class: 'switch' }),
        el('span', { class: 'switch-label' },
          el('strong', {}, 'On-brand'),
          el('span', { class: 'switch-hint' }, 'Tailored to your business profile. Turn off for a freestyle post.'),
        ),
      ),
    ));
  }

  // Orchestration / quality controls
  form.appendChild(el('div', { class: 'field' },
    el('label', { class: 'switch-row' },
      el('input', { type: 'checkbox', name: 'qualityGate', checked: 'checked' }),
      el('span', { class: 'switch' }),
      el('span', { class: 'switch-label' },
        el('strong', {}, 'Quality gate'),
        el('span', { class: 'switch-hint' }, 'Second AI reviews the draft, auto-refines if score < 75. Adds a few seconds.'),
      ),
    ),
  ));
  form.appendChild(el('div', { class: 'field' },
    el('label', {}, 'Parallel drafts',
      (() => {
        const s = el('select', { name: 'variants' });
        [
          ['1', '1 · fastest'],
          ['2', '2 · compare 2 drafts, pick the best'],
          ['3', '3 · best quality (slower, ~3× cost)'],
        ].forEach(([v, t]) => {
          const o = el('option', { value: v }, t);
          if (v === '1') o.selected = true;
          s.appendChild(o);
        });
        return s;
      })(),
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
    // Checkbox default: present iff checked. When toggle hidden (no profile),
    // onBrand is true but business context is empty anyway.
    const onBrand = hasBizProfile ? fd.get('onBrand') === 'on' : true;
    const qualityGate = fd.get('qualityGate') === 'on';
    const variants = Math.max(1, Math.min(3, Number(fd.get('variants')) || 1));
    const endpoint = format === 'video' ? '/api/posts/generate-video' : '/api/posts/generate';
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> Generating…';
    try {
      const result = await api(endpoint, {
        method: 'POST',
        body: { prompt: fd.get('prompt'), platforms: [platform], onBrand, qualityGate, variants },
      });
      const msg = result.quality
        ? `Post generated — quality ${result.quality.score}/100${result.quality.refined ? ' (auto-refined)' : ''}`
        : 'Post generated';
      toast(msg, 'success');
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
    const mediaWrap = el('div', { class: 'post-thumb-media' });
    if (p.drive_url) mediaWrap.appendChild(el('img', { src: p.drive_url, alt: '' }));
    else mediaWrap.appendChild(el('div', { style: 'aspect-ratio:1; background:var(--bg-soft)' }));
    if (p.quality && typeof p.quality.score === 'number') {
      mediaWrap.appendChild(renderQualityBadge(p.quality.score));
    }
    const card = el('div', { class: 'post-thumb', onclick: () => openPostPreview(p) },
      mediaWrap,
      el('div', { class: 'post-thumb-body' },
        el('div', { class: 'post-thumb-caption' }, p.caption || p.prompt || ''),
        el('div', { class: 'lead-card-footer' },
          el('span', {}, p.status || 'draft'),
          el('span', {}, formatDate(p.created_at, { dateOnly: true })),
        ),
      ),
    );
    grid.appendChild(card);
  }
  root.appendChild(grid);
};

// =======================================================================
//   QUALITY WIDGETS
// =======================================================================
function qualityTier(score) {
  if (score >= 85) return 'good';
  if (score >= 70) return 'ok';
  if (score >= 60) return 'warn';
  return 'bad';
}

function renderQualityBadge(score) {
  const tier = qualityTier(score);
  return el('div', { class: `quality-badge quality-${tier}`, title: `Quality score ${score}/100` },
    el('span', { class: 'quality-badge-num' }, String(score)),
    el('span', { class: 'quality-badge-lbl' }, '/100'),
  );
}

function renderQualityPanel(quality) {
  if (!quality) return null;
  const tier = qualityTier(quality.score);
  const axisLabel = {
    brand_fit: 'Brand fit',
    engagement: 'Engagement',
    clarity: 'Clarity',
    hashtag_quality: 'Hashtags',
    image_prompt: 'Image prompt',
  };
  const bars = Object.entries(quality.breakdown || {}).map(([k, v]) => {
    const pct = Math.max(0, Math.min(100, Number(v) || 0));
    return el('div', { class: 'axis' },
      el('div', { class: 'axis-label' },
        el('span', {}, axisLabel[k] || k),
        el('span', { class: 'axis-value' }, String(pct)),
      ),
      el('div', { class: 'axis-bar' },
        el('div', { class: `axis-fill tier-${qualityTier(pct)}`, style: `width:${pct}%` }),
      ),
    );
  });

  const wrap = el('div', { class: 'drawer-section quality-panel' });
  wrap.appendChild(el('h4', {}, 'Quality report'));
  wrap.appendChild(el('div', { class: 'quality-score-row' },
    el('div', { class: `quality-dial tier-${tier}`, style: `--p:${quality.score || 0}` },
      el('span', { class: 'quality-dial-num' }, String(quality.score || 0)),
      el('span', { class: 'quality-dial-lbl' }, '/100'),
    ),
    el('div', { class: 'quality-verdict' },
      el('div', { class: 'quality-verdict-text' }, quality.verdict || ''),
      quality.refined
        ? el('div', { class: 'quality-chip' }, '✨ Auto-refined')
        : null,
      quality.needsReview
        ? el('div', { class: 'quality-chip quality-chip-warn' }, '⚠ Needs review')
        : null,
    ),
  ));
  wrap.appendChild(el('div', { class: 'axes' }, ...bars));

  if (quality.issues && quality.issues.length) {
    wrap.appendChild(el('div', { class: 'quality-list' },
      el('div', { class: 'quality-list-title' }, 'Issues'),
      el('ul', {}, ...quality.issues.map(i => el('li', {}, i))),
    ));
  }
  if (quality.suggestions && quality.suggestions.length) {
    wrap.appendChild(el('div', { class: 'quality-list' },
      el('div', { class: 'quality-list-title' }, 'Suggestions'),
      el('ul', {}, ...quality.suggestions.map(s => el('li', {}, s))),
    ));
  }
  if (quality.refinementNotes) {
    wrap.appendChild(el('div', { class: 'quality-note' }, quality.refinementNotes));
  }
  return wrap;
}

// =======================================================================
//   POST PREVIEW MODAL — full-size social preview
// =======================================================================
function openPostPreview(post) {
  // Build once, destroy on close
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => {
    if (e.target === backdrop) closePostPreview();
  } });

  // Platforms: stored as JSON array in the DB, already parsed by API
  const platforms = Array.isArray(post.platforms) ? post.platforms : (() => {
    try { return JSON.parse(post.platforms || '[]'); } catch { return []; }
  })();
  const primary = platforms[0] || 'instagram';

  // State: which platform preview to render
  let currentPlatform = primary;

  const modal = el('div', { class: 'modal modal-post' });

  const render = () => {
    modal.innerHTML = '';

    // Header
    modal.appendChild(el('div', { class: 'modal-header' },
      el('div', { class: 'modal-title' }, 'Post preview'),
      el('button', { class: 'icon-btn', onclick: closePostPreview, 'aria-label': 'Close' }, '✕'),
    ));

    // Body: left = social preview, right = details
    const body = el('div', { class: 'modal-body post-preview' });

    // ---- LEFT: social frame ----
    const frame = el('div', { class: `social-frame social-${currentPlatform}` });

    // Platform-specific mock header
    if (currentPlatform === 'instagram') {
      frame.appendChild(el('div', { class: 'ig-header' },
        el('div', { class: 'ig-avatar' }, (State.user && (State.user.name || State.user.email) || '?')[0].toUpperCase()),
        el('div', { class: 'ig-meta' },
          el('div', { class: 'ig-username' }, State.user?.email?.split('@')[0] || 'yourbrand'),
          el('div', { class: 'ig-sublabel' }, 'Sponsored'),
        ),
        el('div', { style: 'margin-left:auto; color: var(--text-dim)' }, '⋯'),
      ));
    } else if (currentPlatform === 'linkedin') {
      frame.appendChild(el('div', { class: 'li-header' },
        el('div', { class: 'ig-avatar' }, (State.user && (State.user.name || State.user.email) || '?')[0].toUpperCase()),
        el('div', { class: 'ig-meta' },
          el('div', { class: 'ig-username' }, State.user?.name || State.user?.email || 'Your Brand'),
          el('div', { class: 'ig-sublabel' }, 'Company · Promoted'),
        ),
      ));
      // LinkedIn caption goes above image
      if (post.caption) frame.appendChild(el('div', { class: 'li-caption' }, post.caption));
    } else if (currentPlatform === 'facebook') {
      frame.appendChild(el('div', { class: 'li-header' },
        el('div', { class: 'ig-avatar' }, (State.user && (State.user.name || State.user.email) || '?')[0].toUpperCase()),
        el('div', { class: 'ig-meta' },
          el('div', { class: 'ig-username' }, State.user?.name || 'Your Page'),
          el('div', { class: 'ig-sublabel' }, 'Sponsored · 🌐'),
        ),
      ));
      if (post.caption) frame.appendChild(el('div', { class: 'li-caption' }, post.caption));
    }

    // Media
    if (post.drive_url) {
      const isVideo = /\.(mp4|mov|webm)$/i.test(post.drive_url);
      if (isVideo) {
        frame.appendChild(el('video', { src: post.drive_url, controls: '', class: 'social-media', autoplay: '', loop: '', muted: '', playsinline: '' }));
      } else {
        frame.appendChild(el('img', { src: post.drive_url, class: 'social-media', alt: post.caption || '' }));
      }
    }

    // Platform-specific footer
    if (currentPlatform === 'instagram') {
      frame.appendChild(el('div', { class: 'ig-actions' },
        el('span', {}, '♡'), el('span', {}, '💬'), el('span', {}, '📨'),
        el('span', { style: 'margin-left:auto' }, '🔖'),
      ));
      if (post.caption) frame.appendChild(el('div', { class: 'ig-caption' },
        el('strong', {}, State.user?.email?.split('@')[0] || 'yourbrand'), ' ', post.caption,
      ));
      if (post.hashtags) frame.appendChild(el('div', { class: 'ig-hashtags' }, post.hashtags));
    } else {
      // LinkedIn / Facebook bottom
      frame.appendChild(el('div', { class: 'li-actions' },
        el('span', {}, '👍 Like'), el('span', {}, '💬 Comment'), el('span', {}, '↗ Share'),
      ));
      if (post.hashtags) frame.appendChild(el('div', { class: 'ig-hashtags' }, post.hashtags));
    }

    body.appendChild(frame);

    // ---- RIGHT: details & actions ----
    const details = el('div', { class: 'post-details' });

    // Platform switcher (only show platforms that exist on the post)
    if (platforms.length > 1) {
      details.appendChild(el('div', { class: 'drawer-section' },
        el('h4', {}, 'Preview as'),
        el('div', { style: 'display:flex; gap:6px; flex-wrap:wrap' },
          ...platforms.map(p => el('button', {
            class: 'btn btn-sm ' + (p === currentPlatform ? 'btn-primary' : 'btn-ghost'),
            onclick: () => { currentPlatform = p; render(); },
          }, p)),
        ),
      ));
    }

    // Quality report (if available) — shown first so it's front-and-center
    const qp = renderQualityPanel(post.quality);
    if (qp) details.appendChild(qp);

    details.appendChild(el('div', { class: 'drawer-section' },
      el('h4', {}, 'Caption'),
      el('div', { class: 'editable-text', style: 'white-space:pre-wrap; font-size:14px; line-height:1.55' }, post.caption || '—'),
    ));

    if (post.hashtags) {
      details.appendChild(el('div', { class: 'drawer-section' },
        el('h4', {}, 'Hashtags'),
        el('div', { style: 'font-size:13px; color:var(--accent-hover); word-break:break-word' }, post.hashtags),
      ));
    }

    details.appendChild(el('div', { class: 'drawer-section' },
      el('h4', {}, 'Details'),
      el('dl', { class: 'kv-list' },
        el('dt', {}, 'Status'),     el('dd', {}, post.status || 'draft'),
        el('dt', {}, 'Platforms'),  el('dd', {}, platforms.join(', ') || '—'),
        el('dt', {}, 'Created'),    el('dd', {}, formatDate(post.created_at)),
        post.scheduled_at ? el('dt', {}, 'Scheduled') : null,
        post.scheduled_at ? el('dd', {}, formatDate(post.scheduled_at)) : null,
      ),
    ));

    // Actions
    const actions = el('div', { class: 'drawer-section', style: 'display:flex; gap:8px; flex-wrap:wrap' },
      el('a', {
        class: 'btn btn-ghost btn-sm',
        href: post.drive_url || '#', target: '_blank', rel: 'noopener noreferrer',
      }, '↗ Open media'),
      el('button', {
        class: 'btn btn-primary btn-sm',
        onclick: async () => {
          if (!confirm('Publish this post now to ' + platforms.join(', ') + '?')) return;
          try {
            await api('/api/posts/' + post.id + '/publish', { method: 'POST' });
            toast('Published', 'success');
            closePostPreview();
            navigate('posts', { replace: true });
          } catch (err) { toast(err.message, 'error'); }
        },
      }, '🚀 Publish now'),
      el('button', {
        class: 'btn btn-danger btn-sm',
        onclick: async () => {
          if (!confirm('Delete this post? This cannot be undone.')) return;
          try {
            await api('/api/posts/' + post.id, { method: 'DELETE' });
            toast('Post deleted', 'success');
            closePostPreview();
            navigate('posts', { replace: true });
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Delete'),
    );
    details.appendChild(actions);

    body.appendChild(details);
    modal.appendChild(body);
  };

  render();
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  document.body.style.overflow = 'hidden';

  // Esc to close
  const onKey = (e) => { if (e.key === 'Escape') closePostPreview(); };
  document.addEventListener('keydown', onKey);
  backdrop._onKey = onKey;
}

function closePostPreview() {
  const backdrop = $('.modal-backdrop');
  if (!backdrop) return;
  if (backdrop._onKey) document.removeEventListener('keydown', backdrop._onKey);
  backdrop.remove();
  document.body.style.overflow = '';
}

// =======================================================================
//   VIEW: BRAND
// =======================================================================
VIEWS.brand = async function brandView(root, myGen) {
  root.innerHTML = '<div class="loading"></div>';
  let brand = {};
  try { brand = await api('/api/brand'); } catch (e) { toast(e.message, 'error'); }
  if (stale(myGen)) return;
  brand = brand || {};

  root.innerHTML = '';

  // ---- LOGO CARD ----
  const logoCard = el('div', { class: 'card' });
  logoCard.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Logo'),
    el('div', { class: 'section-sub' }, 'Drag & drop or click to upload (PNG / JPG / WebP / SVG, ≤ 5 MB).'),
  ));

  const drop = el('div', { class: 'dropzone', tabindex: '0' });
  const fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', style: 'display:none' });
  const previewWrap = el('div', { class: 'logo-preview hidden' });
  const previewImg = el('img', { alt: 'Logo preview' });
  const removeBtn = el('button', { type: 'button', class: 'btn btn-danger btn-sm' }, 'Remove');
  previewWrap.appendChild(previewImg);
  previewWrap.appendChild(removeBtn);

  const dropHint = el('div', { class: 'dropzone-hint' },
    el('div', { style: 'font-size:28px; margin-bottom:6px' }, '⬆'),
    el('div', { style: 'font-weight:500' }, 'Drop your logo here'),
    el('div', { class: 'section-sub', style: 'margin-top:4px' }, 'or click to browse'),
  );

  drop.appendChild(dropHint);
  drop.appendChild(previewWrap);
  drop.appendChild(fileInput);
  logoCard.appendChild(drop);
  root.appendChild(logoCard);

  function showPreview(url) {
    previewImg.src = url;
    previewWrap.classList.remove('hidden');
    dropHint.classList.add('hidden');
  }
  function clearPreview() {
    previewImg.removeAttribute('src');
    previewWrap.classList.add('hidden');
    dropHint.classList.remove('hidden');
  }
  if (brand.logo_url) showPreview(brand.logo_url);

  drop.onclick = (e) => {
    if (e.target === removeBtn || removeBtn.contains(e.target)) return;
    fileInput.click();
  };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('dragover'); };
  drop.ondragleave = () => drop.classList.remove('dragover');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) uploadLogo(e.dataTransfer.files[0]);
  };
  fileInput.onchange = () => { if (fileInput.files[0]) uploadLogo(fileInput.files[0]); };

  async function uploadLogo(file) {
    if (file.size > 5 * 1024 * 1024) {
      toast('File exceeds 5 MB limit', 'error');
      return;
    }
    // Optimistic local preview before upload finishes
    const localUrl = URL.createObjectURL(file);
    showPreview(localUrl);
    drop.classList.add('uploading');

    const form = new FormData();
    form.append('logo', file);
    try {
      const res = await fetch('/api/brand/logo', {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      showPreview(data.logo_url);
      URL.revokeObjectURL(localUrl);
      toast('Logo uploaded', 'success');
    } catch (err) {
      toast(err.message, 'error');
      clearPreview();
    } finally {
      drop.classList.remove('uploading');
      fileInput.value = '';
    }
  }

  removeBtn.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm('Remove logo?')) return;
    try {
      await api('/api/brand/logo', { method: 'DELETE' });
      clearPreview();
      toast('Logo removed', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };

  // ---- DETAILS CARD ----
  const card = el('div', { class: 'card', style: 'margin-top:20px' });
  card.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Brand details'),
    el('div', { class: 'section-sub' }, 'Applied to every post as an overlay.'),
  ));

  const form = el('form');
  const row = (...kids) => el('div', { class: 'row' }, ...kids);

  // Field with a leading icon (emoji or SVG string)
  const iconField = (name, label, ph, icon, type = 'text') => el('div', { class: 'field' },
    el('label', {}, label,
      el('div', { class: 'field-icon' },
        el('span', { class: 'icon' }, icon),
        el('input', { type, name, placeholder: ph, value: brand[name] || '' }),
      ),
    ),
  );

  form.appendChild(row(
    iconField('phone',    'Phone',    '+44 7407 040008', '📞', 'tel'),
    iconField('whatsapp', 'WhatsApp', '+44 7407 040008', '💬', 'tel'),
  ));
  form.appendChild(row(
    iconField('website', 'Website', 'hitratech.co.uk', '🌐', 'url'),
    iconField('primary_color', 'Primary color', '#6366f1', '🎨'),
  ));
  form.appendChild(row(
    iconField('instagram_handle', 'Instagram', '@hitratech', '📷'),
    iconField('linkedin_handle',  'LinkedIn',  'hitratech',  '💼'),
  ));
  form.appendChild(row(
    iconField('facebook_handle', 'Facebook', 'hitratech', '👥'),
    el('div', { class: 'field' },
      el('label', {}, 'Overlay position',
        (() => {
          const s = el('select', { name: 'overlay_position' });
          [
            ['bottom-right', 'Bottom right'],
            ['bottom-left',  'Bottom left'],
            ['top-right',    'Top right'],
            ['top-left',     'Top left'],
          ].forEach(([v, t]) => {
            const o = el('option', { value: v }, t);
            if ((brand.overlay_position || 'bottom-right') === v) o.selected = true;
            s.appendChild(o);
          });
          return s;
        })(),
      ),
    ),
  ));

  form.appendChild(el('div', { class: 'form-actions' },
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save changes'),
  ));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = Object.fromEntries(fd.entries());
    try {
      await api('/api/brand', { method: 'PUT', body });
      toast('Brand saved', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
  card.appendChild(form);
  root.appendChild(card);

  // ---- BUSINESS PROFILE CARD ----
  const bizCard = el('div', { class: 'card', style: 'margin-top:20px' });
  bizCard.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Business profile'),
    el('div', { class: 'section-sub' }, 'AI uses this to make every post feel like it comes from YOUR business.'),
  ));

  // Autofill-from-website row
  const autoBar = el('div', { class: 'autofill-bar' });
  const urlInput = el('input', {
    type: 'url',
    placeholder: 'your-company.com',
    value: brand.website || '',
    style: 'flex:1; margin-top:0',
  });
  const autoBtn = el('button', { type: 'button', class: 'btn btn-ghost' }, '✨ Analyze my website');
  autoBar.appendChild(el('div', { class: 'field-icon', style: 'flex:1' },
    el('span', { class: 'icon' }, '🌐'),
    urlInput,
  ));
  autoBar.appendChild(autoBtn);
  bizCard.appendChild(autoBar);
  bizCard.appendChild(el('div', { class: 'section-sub', style: 'margin: -8px 0 16px' },
    'Point to your public website and we\'ll draft your business profile for you. You can review and edit everything before saving.',
  ));

  autoBtn.onclick = async () => {
    const url = urlInput.value.trim();
    if (!url) { toast('Enter a website URL first', 'error'); return; }
    autoBtn.disabled = true;
    autoBtn.innerHTML = '<span class="loading"></span> Analyzing…';
    try {
      const result = await api('/api/brand/autofill-from-website', {
        method: 'POST',
        body: { url },
      });
      const p = result.profile || {};
      // Fill the form fields without saving — user reviews then clicks Save
      const setVal = (name, val) => {
        const field = bizForm.querySelector(`[name="${name}"]`);
        if (field && val != null) field.value = val;
      };
      if (p.business_name)        setVal('business_name', p.business_name);
      if (p.industry)             setVal('industry', p.industry);
      if (p.business_description) setVal('business_description', p.business_description);
      if (p.target_audience)      setVal('target_audience', p.target_audience);
      if (p.tone_of_voice)        setVal('tone_of_voice', p.tone_of_voice);
      if (p.content_language)     setVal('content_language', p.content_language);
      toast('Profile drafted from ' + result.url + ' — review and save', 'success', 6000);
    } catch (err) {
      toast(err.message || 'Website analysis failed', 'error', 6000);
    } finally {
      autoBtn.disabled = false;
      autoBtn.textContent = '✨ Analyze my website';
    }
  };

  const bizForm = el('form');
  const bizRow = (...kids) => el('div', { class: 'row' }, ...kids);
  const textField = (name, label, ph) => el('div', { class: 'field' },
    el('label', {}, label,
      el('input', { type: 'text', name, placeholder: ph, value: brand[name] || '' })),
  );
  const textareaField = (name, label, ph, rows = 3) => el('div', { class: 'field' },
    el('label', {}, label,
      el('textarea', { name, placeholder: ph, rows }, brand[name] || '')),
  );
  const selectField = (name, label, options, current) => el('div', { class: 'field' },
    el('label', {}, label,
      (() => {
        const s = el('select', { name });
        s.appendChild(el('option', { value: '' }, '— Select —'));
        options.forEach(([v, t]) => {
          const o = el('option', { value: v }, t);
          if (current === v) o.selected = true;
          s.appendChild(o);
        });
        return s;
      })(),
    ),
  );

  bizForm.appendChild(bizRow(
    textField('business_name', 'Business name', 'Hitra Tech'),
    textField('industry', 'Industry / vertical', 'SaaS, Restaurant, Real estate…'),
  ));
  bizForm.appendChild(textareaField(
    'business_description',
    'What does your business do?',
    'e.g. We build AI-powered social media automation tools for small agencies…',
    3,
  ));
  bizForm.appendChild(textareaField(
    'target_audience',
    'Who are your customers?',
    'e.g. Marketing agencies with 1–20 employees, founders doing their own social media…',
    2,
  ));
  bizForm.appendChild(bizRow(
    selectField('tone_of_voice', 'Tone of voice', [
      ['professional', 'Professional'],
      ['friendly',     'Friendly'],
      ['playful',      'Playful'],
      ['bold',         'Bold / confident'],
      ['authoritative','Authoritative'],
      ['casual',       'Casual'],
      ['inspirational','Inspirational'],
    ], brand.tone_of_voice),
    selectField('content_language', 'Content language', [
      ['English',  'English'],
      ['Turkish',  'Türkçe'],
      ['German',   'Deutsch'],
      ['Spanish',  'Español'],
      ['French',   'Français'],
      ['Italian',  'Italiano'],
      ['Portuguese', 'Português'],
      ['Arabic',   'العربية'],
    ], brand.content_language),
  ));

  bizForm.appendChild(el('div', { class: 'form-actions' },
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save profile'),
  ));
  bizForm.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(bizForm);
    const body = Object.fromEntries(fd.entries());
    try {
      await api('/api/brand', { method: 'PUT', body });
      toast('Business profile saved', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
  bizCard.appendChild(bizForm);
  root.appendChild(bizCard);
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
