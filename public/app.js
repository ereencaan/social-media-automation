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
    // 402 = "you need to upgrade / past quota". Open the upgrade modal
    // automatically so every quota-gated route gets the right UX without
    // each call site needing to handle 402 by hand. The thrown error still
    // bubbles so the call site can decide what to do (toast, restore form,
    // etc.) — we just guarantee the modal renders.
    if (res.status === 402 && typeof openUpgradeModal === 'function') {
      try { openUpgradeModal(data || {}); } catch { /* ignore modal failures */ }
    }
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
  // Background jobs that should outlive view navigation. Keyed by a uuid.
  // Each entry: { id, label, status: 'running'|'done'|'error', startedAt }
  activeJobs: new Map(),
};

// ---- background-job UI ----------------------------------------------------
// A persistent floating pill, mounted once at app boot (not per-view), that
// shows running jobs (Generate, Plan auto-build, …). Lets the user navigate
// freely without the in-flight work getting cancelled or hidden.
function renderJobPill() {
  let host = document.getElementById('job-pill-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'job-pill-host';
    document.body.appendChild(host);
  }
  host.innerHTML = '';
  if (!State.activeJobs.size) return;
  for (const job of State.activeJobs.values()) {
    const pill = document.createElement('div');
    pill.className = 'job-pill ' + (job.status === 'error' ? 'job-pill-error' : 'job-pill-running');
    pill.innerHTML = job.status === 'running'
      ? `<span class="job-pill-dot"></span><span>${job.label}</span>`
      : `<span>${job.label}</span>`;
    host.appendChild(pill);
  }
}

function startJob(label) {
  const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
  State.activeJobs.set(id, { id, label, status: 'running', startedAt: Date.now() });
  renderJobPill();
  return id;
}
function updateJob(id, patch) {
  const j = State.activeJobs.get(id);
  if (!j) return;
  Object.assign(j, patch);
  renderJobPill();
  // Auto-clear finished jobs after a short pause so the user sees the pill flip.
  if (patch.status && patch.status !== 'running') {
    setTimeout(() => { State.activeJobs.delete(id); renderJobPill(); }, 4000);
  }
}

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

  // Stripe redirect handling: success / cancel land back here with a query
  // param. We toast the result and strip the param so a refresh doesn't
  // re-fire it.
  if (location.search.includes('billing=')) {
    const q = new URLSearchParams(location.search);
    const status = q.get('billing');
    if (status === 'success') {
      toast('Subscription active. Welcome aboard!', 'success', 6000);
      // Bust the cached billing/me — server has already synced from the
      // webhook by the time the redirect lands, but the cached value the
      // dashboard fetched at boot will be stale.
      _plansCache = null;
    } else if (status === 'canceled') {
      toast('Checkout canceled. No charge.', 'info');
    }
    // Strip the query string while preserving the hash route.
    history.replaceState(null, '', location.pathname + location.hash);
  }

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
    calendar: 'Content calendar',
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
  let leads = [], posts = [], billing = null;
  try {
    [leads, posts, billing] = await Promise.all([
      api('/api/leads').catch(() => []),
      api('/api/posts').catch(() => []),
      api('/api/billing/me').catch(() => null),
    ]);
  } catch {}
  if (stale(myGen)) return;

  const count = (status) => leads.filter(l => l.status === status).length;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const newThisWeek = leads.filter(l => {
    const t = l.created_at ? new Date(l.created_at.replace(' ', 'T') + 'Z').getTime() : 0;
    return t >= weekAgo;
  }).length;
  const stats = [
    { title: 'Total leads', value: leads.length, hint: 'All pipeline stages' },
    { title: 'New this week', value: newThisWeek, hint: 'Last 7 days, all sources' },
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

  // Trial countdown banner — appears in the last 3 days only.
  if (billing?.inTrial && billing.trialEndsAt) {
    const days = Math.ceil((new Date(billing.trialEndsAt) - Date.now()) / (24 * 3600 * 1000));
    if (days <= 3 && days >= 0) {
      const banner = el('div', { class: 'trial-banner' },
        el('span', {}, `Trial ends in ${days} day${days === 1 ? '' : 's'}.`),
        el('a', {
          class: 'trial-banner-cta',
          href: '#settings',
          onclick: (e) => { e.preventDefault(); navigate('settings'); },
        }, 'Manage billing →'),
      );
      root.appendChild(banner);
    }
  }

  // Usage indicator — visible to everyone with a plan, helps avoid surprise
  // 402s mid-flow. Hidden for unlimited tiers (Agency / Enterprise).
  if (billing && billing.quotas) {
    const showAny = ['posts', 'ai_calls', 'leads']
      .some(m => billing.quotas[m] !== -1);
    if (showAny) {
      const usageCard = el('div', { class: 'card' });
      usageCard.appendChild(el('div', { class: 'section-header' },
        el('h2', {}, 'This month'),
        el('a', {
          class: 'section-sub',
          href: '#settings',
          onclick: (e) => { e.preventDefault(); navigate('settings'); },
        }, 'Manage plan →'),
      ));
      const bars = el('div', { class: 'usage-bars' });
      for (const metric of ['posts', 'ai_calls', 'leads']) {
        bars.appendChild(renderUsageBar(metric, billing.usage[metric] || 0, billing.quotas[metric]));
      }
      usageCard.appendChild(bars);
      root.appendChild(usageCard);
    }
  }

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
      el('td', {}, renderSourceBadge(l.source)),
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
    // Fetch the live intake URL so the user can copy-paste it straight
    // from the empty state.
    let intakeUrl = '';
    try { const r = await api('/api/leads/intake/token'); intakeUrl = r.url || ''; } catch {}
    if (stale(myGen)) return;

    const card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'empty-state' },
      el('h3', {}, 'Your CRM is empty'),
      el('p', {}, 'Leads can land here automatically from Instagram DMs, Facebook Page messages, or any tool that POSTs to your webhook.'),
    ));

    const channels = el('div', { class: 'intake-channels' },
      el('div', { class: 'intake-channel' },
        el('div', { class: 'intake-channel-head' },
          el('span', { class: 'intake-channel-icon' }, '📷'),
          el('strong', {}, 'Instagram & Facebook'),
        ),
        el('p', {}, 'Connect your IG Business account and Page — every new DM becomes a lead automatically.'),
        el('button', { class: 'btn btn-sm', onclick: () => navigate('settings') }, 'Connect accounts'),
      ),
      el('div', { class: 'intake-channel' },
        el('div', { class: 'intake-channel-head' },
          el('span', { class: 'intake-channel-icon' }, '🔗'),
          el('strong', {}, 'Webhook / Zapier / Forms'),
        ),
        el('p', {}, 'POST JSON to your intake URL from Typeform, Zapier, or any HTML form.'),
        intakeUrl ? el('div', { class: 'intake-url-field intake-url-field-sm' },
          el('code', { class: 'intake-url' }, intakeUrl),
          el('button', {
            class: 'btn btn-sm',
            onclick: () => navigator.clipboard.writeText(intakeUrl).then(() => toast('Copied', 'success')),
          }, 'Copy'),
        ) : null,
      ),
      el('div', { class: 'intake-channel' },
        el('div', { class: 'intake-channel-head' },
          el('span', { class: 'intake-channel-icon' }, '✍'),
          el('strong', {}, 'Manual entry'),
        ),
        el('p', {}, 'Quickly add a lead from a phone call, event, or referral.'),
        el('button', { class: 'btn btn-primary btn-sm', onclick: () => openNewLeadModal() }, '+ Add lead'),
      ),
    );
    card.appendChild(channels);
    root.appendChild(card);
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
      renderSourceBadge(lead.source),
      el('span', {}, formatDate(lead.created_at, { dateOnly: true })),
    ),
  );
}

// Source badge: icon + short label + colored chip so the origin channel
// is scannable at a glance in the kanban.
const SOURCE_META = {
  instagram_dm:     { icon: '📷', label: 'Instagram', cls: 'src-instagram' },
  facebook_message: { icon: '👥', label: 'Facebook',  cls: 'src-facebook'  },
  linkedin:         { icon: '💼', label: 'LinkedIn',  cls: 'src-linkedin'  },
  webhook:          { icon: '🔗', label: 'Webhook',   cls: 'src-webhook'   },
  manual:           { icon: '✍',  label: 'Manual',    cls: 'src-manual'    },
};
function renderSourceBadge(source) {
  const meta = SOURCE_META[source] || SOURCE_META.manual;
  return el('span', { class: `source-chip ${meta.cls}`, title: source || 'manual' },
    el('span', { class: 'source-chip-icon' }, meta.icon),
    meta.label,
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

    // AI Email composer
    body.appendChild(el('div', { class: 'drawer-section' },
      el('h4', {}, 'AI email'),
      el('button', {
        class: 'btn btn-primary btn-sm',
        onclick: () => openEmailComposer(lead, () => {
          // after save, refresh activities
          api('/api/leads/' + leadId + '/activities').then((list) => {
            activities = list;
            renderDrawer();
          }).catch(() => {});
        }),
      }, '✉ Draft email for this lead'),
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
//   LEAD EMAIL COMPOSER
// =======================================================================
function openEmailComposer(lead, onSaved) {
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => {
    if (e.target === backdrop) closeEmailComposer();
  } });
  const modal = el('div', { class: 'modal', style: 'max-width: 780px' });

  let current = { email: null, quality: null, goal: 'intro', extra: '' };
  let saving = false;

  const render = () => {
    modal.innerHTML = '';
    modal.appendChild(el('div', { class: 'modal-header' },
      el('div', {},
        el('div', { class: 'modal-title' }, `Email ${lead.name || lead.email || 'lead'}`),
        el('div', { class: 'section-sub', style: 'margin-top:2px' },
          `To: ${lead.email || '(no email on file)'}`),
      ),
      el('button', { class: 'icon-btn', onclick: closeEmailComposer, 'aria-label': 'Close' }, '✕'),
    ));

    const body = el('div', { style: 'padding:20px; overflow-y:auto' });

    // Goal + extra
    const goalSelect = (() => {
      const s = el('select', { name: 'goal' });
      [
        ['intro',      'Introduce our services'],
        ['followup',   'Follow up on a prior thread'],
        ['meeting',    'Book a short call / meeting'],
        ['reactivate', 'Re-engage a cold lead'],
        ['proposal',   'Share proposal / pricing'],
        ['custom',     'Custom (use extra instructions)'],
      ].forEach(([v, t]) => {
        const o = el('option', { value: v }, t);
        if (v === current.goal) o.selected = true;
        s.appendChild(o);
      });
      s.onchange = () => { current.goal = s.value; };
      return s;
    })();
    const extraTxt = el('textarea', {
      name: 'extra', rows: 2,
      placeholder: 'Optional: extra instructions or specific angle (used heavily when goal = Custom).',
    }, current.extra || '');
    extraTxt.oninput = () => { current.extra = extraTxt.value; };

    body.appendChild(el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', {}, 'Goal', goalSelect)),
      el('div', { class: 'field' }, el('label', {}, 'Extra instructions (optional)', extraTxt)),
    ));

    const generateBtn = el('button', { class: 'btn btn-primary' },
      current.email ? 'Regenerate' : '✨ Draft with AI',
    );
    generateBtn.onclick = async () => {
      generateBtn.disabled = true;
      generateBtn.innerHTML = '<span class="loading"></span> Drafting + reviewing…';
      try {
        const result = await api('/api/leads/' + lead.id + '/emails/draft', {
          method: 'POST',
          body: { goal: current.goal, extra: current.extra },
        });
        current.email = result.email;
        current.quality = {
          score:        result.quality.score,
          breakdown:    result.quality.breakdown,
          issues:       result.quality.issues,
          suggestions:  result.quality.suggestions,
          verdict:      result.quality.verdict,
          needsReview:  result.quality.needsReview,
          perModel:     result.quality.perModel,
          modelsUsed:   result.quality.modelsUsed,
          modelsFailed: result.quality.modelsFailed,
          degraded:     result.quality.degraded,
        };
        render();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        generateBtn.disabled = false;
        generateBtn.innerHTML = '✨ Draft with AI';
      }
    };
    body.appendChild(el('div', { style: 'margin-bottom:16px' }, generateBtn));

    // Draft editor (appears after first generation)
    if (current.email) {
      const subjInput = el('input', {
        type: 'text', name: 'subject', value: current.email.subject,
      });
      subjInput.oninput = () => { current.email.subject = subjInput.value; };
      const bodyTxt = el('textarea', {
        name: 'body', rows: 10, style: 'font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px',
      }, current.email.body);
      bodyTxt.oninput = () => { current.email.body = bodyTxt.value; };

      body.appendChild(el('div', { class: 'field' },
        el('label', {}, 'Subject', subjInput),
      ));
      body.appendChild(el('div', { class: 'field' },
        el('label', {}, 'Body', bodyTxt),
      ));

      const qp = renderQualityPanel(current.quality);
      if (qp) body.appendChild(qp);

      body.appendChild(el('div', { class: 'form-actions' },
        el('button', { class: 'btn btn-ghost', onclick: async () => {
          try {
            await navigator.clipboard.writeText(
              `Subject: ${current.email.subject}\n\n${current.email.body}`
            );
            toast('Copied to clipboard', 'success');
          } catch { toast('Copy failed', 'error'); }
        } }, '📋 Copy'),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            if (saving) return;
            saving = true;
            try {
              await api('/api/leads/' + lead.id + '/emails/log', {
                method: 'POST',
                body: {
                  subject: current.email.subject,
                  body:    current.email.body,
                  goal:    current.goal,
                  quality: current.quality,
                },
              });
              toast('Saved to timeline', 'success');
              if (onSaved) onSaved();
              closeEmailComposer();
            } catch (err) {
              toast(err.message, 'error');
            } finally { saving = false; }
          },
        }, 'Save to timeline'),
      ));
    }

    modal.appendChild(body);
  };

  render();
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  document.body.style.overflow = 'hidden';
  const onKey = (e) => { if (e.key === 'Escape') closeEmailComposer(); };
  document.addEventListener('keydown', onKey);
  backdrop._onKey = onKey;
}
function closeEmailComposer() {
  const backdrops = $$('.modal-backdrop');
  const last = backdrops[backdrops.length - 1];
  if (!last) return;
  if (last._onKey) document.removeEventListener('keydown', last._onKey);
  last.remove();
  if (!$('.modal-backdrop')) document.body.style.overflow = '';
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

  // Prompt field with an inline analyzer panel below it
  const promptTextarea = el('textarea', {
    name: 'prompt', required: true, rows: 3,
    placeholder: hasBizProfile
      ? 'e.g. Weekly tip, product announcement, customer story, seasonal campaign, event reminder…  (We\'ll tailor it to your business automatically.)'
      : 'e.g. Announce our Q2 product launch with a confident, premium tone.',
  });
  const analyzeBtn = el('button', {
    type: 'button', class: 'btn btn-sm btn-ghost',
    style: 'position:absolute; right:8px; bottom:8px;',
  }, '🔍 Analyze prompt');
  const rewriteBtn = el('button', {
    type: 'button', class: 'btn btn-sm btn-ghost hidden',
    style: 'margin-left:6px',
  }, '✨ Rewrite');
  const analyzerPanel = el('div', { class: 'analyzer-panel hidden' });

  form.appendChild(el('div', { class: 'field' },
    el('label', {}, 'What should this post be about?'),
    el('div', { style: 'position:relative' },
      promptTextarea,
      analyzeBtn,
    ),
    analyzerPanel,
  ));

  // --- Analyze & Rewrite handlers ---
  let lastAnalysis = null;
  // Multi-checkbox version: gather all checked platform inputs, default to instagram.
  const platformSelect = () => {
    const checked = Array.from(form.querySelectorAll('input[name=platforms]:checked'))
      .map((el) => el.value);
    return checked[0] || 'instagram';
  };
  const allSelectedPlatforms = () => {
    const checked = Array.from(form.querySelectorAll('input[name=platforms]:checked'))
      .map((el) => el.value);
    return checked.length ? checked : ['instagram'];
  };

  analyzeBtn.onclick = async () => {
    const prompt = promptTextarea.value.trim();
    if (!prompt) { toast('Write a prompt first', 'error'); return; }
    analyzeBtn.disabled = true;
    analyzeBtn.innerHTML = '<span class="loading"></span> Analyzing…';
    try {
      const result = await api('/api/posts/analyze-prompt', {
        method: 'POST',
        body: { prompt, platforms: [platformSelect()] },
      });
      lastAnalysis = result;
      renderAnalyzerPanel(analyzerPanel, result, rewriteBtn);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      analyzeBtn.disabled = false;
      analyzeBtn.innerHTML = '🔍 Analyze prompt';
    }
  };
  rewriteBtn.onclick = async () => {
    const prompt = promptTextarea.value.trim();
    if (!prompt) return;
    rewriteBtn.disabled = true;
    rewriteBtn.innerHTML = '<span class="loading"></span> Rewriting…';
    try {
      const result = await api('/api/posts/rewrite-prompt', {
        method: 'POST',
        body: {
          prompt,
          platforms: [platformSelect()],
          suggestions: lastAnalysis && lastAnalysis.suggestions ? lastAnalysis.suggestions : [],
        },
      });
      promptTextarea.value = result.prompt;
      toast('Prompt rewritten — click Analyze again to re-score', 'success');
      rewriteBtn.classList.add('hidden');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      rewriteBtn.disabled = false;
      rewriteBtn.innerHTML = '✨ Rewrite';
    }
  };
  form.appendChild(el('div', { class: 'row' },
    el('div', { class: 'field' },
      el('label', {}, 'Platforms',
        // Multi-select chip group. Same caption + image gets cross-posted to
        // every selected platform on Generate. Default: Instagram only.
        (() => {
          const wrap = el('div', { class: 'chip-group' });
          [
            ['instagram', '📷 Instagram'],
            ['linkedin',  '💼 LinkedIn'],
            ['facebook',  '👥 Facebook'],
          ].forEach(([v, t], i) => {
            const id = `plat-${v}`;
            const cb = el('input', {
              type: 'checkbox', name: 'platforms', value: v, id,
              ...(i === 0 ? { checked: 'checked' } : {}),
            });
            const lab = el('label', { for: id, class: 'chip-label' }, t);
            wrap.appendChild(cb);
            wrap.appendChild(lab);
          });
          return wrap;
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

  // Quality is always on — we never hand the user the option to publish a
  // sub-par post. Server forces qualityGate=true and variants=1 (with
  // automatic refine when score < 75).

  form.appendChild(el('div', { class: 'form-actions' },
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Generate'),
  ));

  // Inline status that walks the user through what's happening during gen.
  // We can't get real-time progress from the orchestrator, so we play a
  // scripted timeline that matches the actual server pipeline: write →
  // multi-model review → optional refine → image gen → done.
  const statusLine = el('div', { class: 'gen-status hidden' });
  form.appendChild(statusLine);

  // Tiny "what does this do" explainer shown above the form.
  form.insertBefore(
    el('div', { class: 'gen-explainer' },
      el('strong', {}, 'How this works: '),
      'Claude writes a draft tailored to your brand profile, then GPT-4 + Gemini score it on 5 axes. ',
      'If the score is low, the draft is auto-refined before image generation. You only ever see the polished result.',
    ),
    form.firstChild,
  );

  form.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const selectedPlatforms = fd.getAll('platforms');
    const platforms = selectedPlatforms.length ? selectedPlatforms : ['instagram'];
    const format = fd.get('format');
    const onBrand = hasBizProfile ? fd.get('onBrand') === 'on' : true;
    const qualityGate = true;
    const variants = 1;
    const endpoint = format === 'video' ? '/api/posts/generate-video' : '/api/posts/generate';
    const promptText = fd.get('prompt');

    // Reset the form immediately so the user can keep working / generate
    // another / navigate elsewhere. The fetch runs detached.
    form.reset();
    statusLine.classList.add('hidden');
    toast('Generating post in the background — you can keep working.', 'info', 3500);

    const jobId = startJob(`Generating post (${platforms.join(', ')})…`);

    // Detached fetch — survives view changes. Result handler is allowed to
    // fire even if the user is on another page; we toast + refresh Posts
    // list lazily via a route nudge.
    api(endpoint, {
      method: 'POST',
      body: { prompt: promptText, platforms, onBrand, qualityGate, variants },
    }).then((result) => {
      const msg = result.quality
        ? `Post ready — quality ${result.quality.score}/100${result.quality.refined ? ' (auto-refined)' : ''}`
        : 'Post ready';
      updateJob(jobId, { status: 'done', label: msg });
      toast(msg + ' · click Posts to view.', 'success', 6000);
      // If the user is currently on Posts, refresh it so the new post shows.
      if ((location.hash || '').includes('posts')) navigate('posts', { replace: true });
    }).catch((err) => {
      updateJob(jobId, { status: 'error', label: 'Generate failed: ' + err.message });
      toast('Generate failed: ' + err.message, 'error', 6000);
    });
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
//   PROMPT ANALYZER PANEL (inline below prompt textarea)
// =======================================================================
function renderAnalyzerPanel(root, analysis, rewriteBtn) {
  root.classList.remove('hidden');
  root.innerHTML = '';
  const tier = qualityTier(analysis.score || 0);

  const head = el('div', { class: 'analyzer-head' },
    el('div', { class: `analyzer-score tier-${tier}` },
      el('span', { class: 'analyzer-score-num' }, String(analysis.score || 0)),
      el('span', { class: 'analyzer-score-lbl' }, '/100'),
    ),
    el('div', { class: 'analyzer-verdict' }, analysis.verdict || 'Prompt analyzed.'),
  );
  // Show rewrite button only when there's meaningful room to improve
  if ((analysis.score || 0) < 85 && (analysis.suggestions || []).length) {
    if (!rewriteBtn.parentElement) head.appendChild(rewriteBtn);
    else rewriteBtn.classList.remove('hidden');
    head.appendChild(rewriteBtn);
  }
  root.appendChild(head);

  if (analysis.suggestions && analysis.suggestions.length) {
    const ul = el('ul', { class: 'analyzer-suggestions' });
    analysis.suggestions.slice(0, 4).forEach(s => {
      const text = typeof s === 'string' ? s : s.text;
      ul.appendChild(el('li', {}, text));
    });
    root.appendChild(ul);
  }
}

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
      el('div', { class: 'quality-chip-row' },
        quality.refined        ? el('span', { class: 'quality-chip' }, '✨ Auto-refined') : null,
        quality.needsReview    ? el('span', { class: 'quality-chip quality-chip-warn' }, '⚠ Needs review') : null,
        quality.degraded       ? el('span', { class: 'quality-chip quality-chip-warn' }, '⚠ Degraded') : null,
      ),
    ),
  ));

  // Per-model breakdown — shows how each AI reviewer scored the artifact
  if (quality.perModel && Object.keys(quality.perModel).length) {
    const modelDisplay = { claude: 'Claude', gemini: 'Gemini', openai: 'GPT-4' };
    wrap.appendChild(el('div', { class: 'reviewer-chips' },
      ...Object.entries(quality.perModel).map(([model, rev]) =>
        el('div', {
          class: `reviewer-chip tier-${qualityTier(rev.overall)}`,
          title: rev.verdict || '',
        },
          el('span', { class: 'reviewer-chip-name' }, modelDisplay[model] || model),
          el('span', { class: 'reviewer-chip-score' }, String(rev.overall)),
        ),
      ),
    ));
  }

  wrap.appendChild(el('div', { class: 'axes' }, ...bars));

  const renderAnnotated = (item) => {
    // Item may be a plain string (legacy) or { model, text } (multi-reviewer)
    if (typeof item === 'string') return el('li', {}, item);
    const modelLbl = { claude: 'Claude', gemini: 'Gemini', openai: 'GPT' }[item.model] || item.model;
    return el('li', {},
      el('span', { class: 'quality-src-tag' }, modelLbl),
      ' ',
      item.text,
    );
  };
  if (quality.issues && quality.issues.length) {
    wrap.appendChild(el('div', { class: 'quality-list' },
      el('div', { class: 'quality-list-title' }, 'Issues'),
      el('ul', {}, ...quality.issues.map(renderAnnotated)),
    ));
  }
  if (quality.suggestions && quality.suggestions.length) {
    wrap.appendChild(el('div', { class: 'quality-list' },
      el('div', { class: 'quality-list-title' }, 'Suggestions'),
      el('ul', {}, ...quality.suggestions.map(renderAnnotated)),
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
      // Regenerate with suggestions (only shows when we have suggestions to apply)
      (post.quality && post.quality.suggestions && post.quality.suggestions.length)
        ? el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              btn.innerHTML = '<span class="loading"></span> Regenerating…';
              try {
                const updated = await api('/api/posts/' + post.id + '/regenerate-copy', { method: 'POST' });
                post = updated;
                toast('Regenerated — new score ' + (updated.quality ? updated.quality.score : '—'), 'success');
                render();
              } catch (err) {
                toast(err.message, 'error');
                btn.disabled = false;
                btn.textContent = '🔄 Regenerate with suggestions';
              }
            },
            title: 'Rewrite caption + hashtags using reviewer suggestions. Image is kept.',
          }, '🔄 Regenerate with suggestions')
        : null,
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
//   VIEW: CALENDAR (content plans)
// =======================================================================
VIEWS.calendar = async function calendarView(root, myGen) {
  // Topbar action: create new plan
  $('#topbar-actions').appendChild(el('button', {
    class: 'btn btn-primary',
    onclick: () => openPlanWizard(),
  }, '+ New monthly plan'));

  root.innerHTML = '<div class="loading"></div>';
  let plans = [], brand = {}, brandDates = [];
  try {
    [plans, brand, brandDates] = await Promise.all([
      api('/api/plans'),
      api('/api/brand').catch(() => ({})),
      api('/api/brand/dates').catch(() => []),
    ]);
  } catch (e) { toast(e.message, 'error'); }
  if (stale(myGen)) return;

  root.innerHTML = '';

  // ---- Upcoming dates panel (always shown) ----
  // Pull this month's + next month's public holidays for the brand's
  // country and merge with brand_special_dates so the user sees the
  // calendar context even before generating a plan.
  const upcomingCard = el('div', { class: 'card', style: 'margin-bottom:16px' });
  upcomingCard.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Upcoming dates'),
    el('div', { class: 'section-sub' },
      'Public holidays + your important dates over the next ~60 days. The planner uses these as anchor points.'),
  ));
  const upcomingBody = el('div');
  upcomingCard.appendChild(upcomingBody);

  (async () => {
    upcomingBody.innerHTML = '<div class="loading"></div>';
    const country = (brand && brand.country) || 'GB';
    const today = new Date(); today.setHours(0,0,0,0);
    const horizon = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
    let holidays = [];
    try {
      const r = await api(`/api/brand/holidays?country=${encodeURIComponent(country)}&year=${today.getFullYear()}`);
      holidays = (r.holidays || []).map(h => ({ date: h.date, name: h.name, source: 'public' }));
      // Also peek into next year if the horizon crosses Dec 31.
      if (horizon.getFullYear() !== today.getFullYear()) {
        const r2 = await api(`/api/brand/holidays?country=${encodeURIComponent(country)}&year=${horizon.getFullYear()}`);
        holidays = holidays.concat((r2.holidays || []).map(h => ({ date: h.date, name: h.name, source: 'public' })));
      }
    } catch {}
    if (stale(myGen)) return;

    // Brand special dates → expand to actual dates in the window. Annual ones
    // fire on this year's M/D; one-offs use the original year if known
    // (we don't store year for brand_special_dates so treat as annual).
    const expanded = [];
    for (const d of brandDates || []) {
      const tryYears = [today.getFullYear(), today.getFullYear() + 1];
      for (const y of tryYears) {
        const dt = new Date(y, d.month - 1, d.day);
        if (dt >= today && dt <= horizon) {
          expanded.push({
            date: dt.toISOString().slice(0, 10),
            name: d.name,
            source: 'brand',
          });
        }
      }
    }

    const all = holidays.concat(expanded)
      .filter(h => {
        const dt = new Date(h.date);
        return dt >= today && dt <= horizon;
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    upcomingBody.innerHTML = '';
    if (!all.length) {
      upcomingBody.innerHTML = '<div style="color:var(--text-dim); font-size:13px; padding:10px">No upcoming holidays or important dates in the next 60 days.</div>';
      return;
    }
    const grid = el('div', { class: 'holidays-grid' });
    for (const h of all) {
      const dt = new Date(h.date);
      grid.appendChild(el('div', { class: 'holiday-row' },
        el('div', { class: 'holiday-date' },
          el('div', { class: 'holiday-day' }, String(dt.getDate())),
          el('div', { class: 'holiday-month' }, dt.toLocaleString(undefined, { month: 'short' })),
        ),
        el('div', { class: 'holiday-info' },
          el('div', { class: 'holiday-name' }, h.name),
          el('div', { class: 'holiday-meta' }, h.source === 'brand' ? 'your business' : 'public holiday'),
        ),
      ));
    }
    upcomingBody.appendChild(grid);
  })();

  root.appendChild(upcomingCard);

  if (!plans.length) {
    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'empty-state' },
        el('h3', {}, 'No content plans yet'),
        el('p', {}, 'The AI planner will use the dates above (plus your business profile) to draft a month of posts.'),
        el('button', { class: 'btn btn-primary', onclick: () => openPlanWizard() }, '+ Create your first plan'),
      ),
    ));
    return;
  }

  // Group plans by month
  const monthLabel = (m) => {
    const [y, mo] = m.split('-').map(Number);
    return new Date(y, mo - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
  };

  const grid = el('div', { style: 'display:flex; flex-direction:column; gap:14px' });
  for (const p of plans) {
    grid.appendChild(el('div', {
      class: 'card clickable',
      style: 'cursor:pointer; display:flex; align-items:center; gap:18px; padding:18px',
      onclick: () => openPlanDetail(p.id),
    },
      el('div', {
        style: 'width:60px; height:60px; border-radius:12px; background:var(--accent-soft); color:var(--accent-hover); display:flex; align-items:center; justify-content:center; font-size:22px; flex-shrink:0',
      }, '🗓'),
      el('div', { style: 'flex:1' },
        el('div', { style: 'font-size:15px; font-weight:600' }, monthLabel(p.month)),
        el('div', { class: 'section-sub', style: 'margin-top:2px' },
          `${p.target_count} posts · ${p.mode} · `,
          el('span', { class: `badge badge-${p.status === 'active' ? 'new' : p.status === 'completed' ? 'won' : 'contacted'}` }, p.status),
          p.auto_publish ? el('span', { class: 'quality-chip', style: 'margin-left:6px' }, '⚡ auto-publish') : null,
        ),
      ),
      el('div', { style: 'color:var(--text-dim); font-size:13px' }, formatDate(p.created_at, { dateOnly: true })),
    ));
  }
  root.appendChild(grid);
};

// ---- Plan creation wizard ------------------------------------------------
function openPlanWizard() {
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => {
    if (e.target === backdrop) closePlanWizard();
  } });
  const modal = el('div', { class: 'modal', style: 'max-width: 900px' });
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  document.body.style.overflow = 'hidden';
  const onKey = (e) => { if (e.key === 'Escape') closePlanWizard(); };
  document.addEventListener('keydown', onKey);
  backdrop._onKey = onKey;

  let preview = null;   // { plan, quality, specialDays } after Generate
  let form = { month: defaultNextMonth(), targetCount: 12, mode: 'hybrid', instagramPct: 60, linkedinPct: 40, extra: '' };
  let autoPublish = false;

  function defaultNextMonth() {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  const render = () => {
    modal.innerHTML = '';
    modal.appendChild(el('div', { class: 'modal-header' },
      el('div', { class: 'modal-title' }, preview ? 'Review your plan' : 'Create monthly plan'),
      el('button', { class: 'icon-btn', onclick: closePlanWizard, 'aria-label': 'Close' }, '✕'),
    ));

    const body = el('div', { style: 'padding:20px; overflow-y:auto; flex:1; min-height:0' });

    if (!preview) {
      // ---- FORM ----
      const monthInput = el('input', { type: 'month', name: 'month', value: form.month });
      monthInput.oninput = () => { form.month = monthInput.value; };
      const countInput = el('input', { type: 'number', name: 'targetCount', min: '1', max: '60', value: String(form.targetCount) });
      countInput.oninput = () => { form.targetCount = Number(countInput.value) || 10; };
      const modeSelect = (() => {
        const s = el('select', { name: 'mode' });
        [
          ['calendar', 'Calendar-driven (prioritize special days)'],
          ['quota', 'Quota (just N posts, AI picks themes)'],
          ['hybrid', 'Hybrid (both)'],
        ].forEach(([v, t]) => {
          const o = el('option', { value: v }, t);
          if (v === form.mode) o.selected = true;
          s.appendChild(o);
        });
        s.onchange = () => { form.mode = s.value; };
        return s;
      })();

      body.appendChild(el('div', { class: 'row' },
        el('div', { class: 'field' }, el('label', {}, 'Month', monthInput)),
        el('div', { class: 'field' }, el('label', {}, 'Number of posts', countInput)),
      ));
      body.appendChild(el('div', { class: 'field' }, el('label', {}, 'Planning mode', modeSelect)));

      // Platform mix
      const igInput = el('input', { type: 'number', min: '0', max: '100', value: String(form.instagramPct), style: 'width: 80px' });
      const liInput = el('input', { type: 'number', min: '0', max: '100', value: String(form.linkedinPct), style: 'width: 80px' });
      igInput.oninput = () => { form.instagramPct = Number(igInput.value) || 0; liInput.value = String(100 - form.instagramPct); form.linkedinPct = 100 - form.instagramPct; };
      liInput.oninput = () => { form.linkedinPct = Number(liInput.value) || 0; igInput.value = String(100 - form.linkedinPct); form.instagramPct = 100 - form.linkedinPct; };
      body.appendChild(el('div', { class: 'field' },
        el('label', {}, 'Platform mix (%)'),
        el('div', { style: 'display:flex; gap:12px; align-items:center' },
          el('span', {}, '📷 Instagram'), igInput,
          el('span', {}, '💼 LinkedIn'), liInput,
        ),
      ));

      // Extra constraints (free-form)
      const extraTxt = el('textarea', { rows: 2, placeholder: 'Optional: "avoid salesy tone", "emphasize case studies", "post on Tuesday/Thursday preferably"...' }, form.extra);
      extraTxt.oninput = () => { form.extra = extraTxt.value; };
      body.appendChild(el('div', { class: 'field' }, el('label', {}, 'Extra constraints (optional)', extraTxt)));

      body.appendChild(el('div', { class: 'form-actions' },
        el('button', { class: 'btn btn-ghost', onclick: closePlanWizard }, 'Cancel'),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          const btn = body.querySelector('.btn-primary');
          btn.disabled = true;
          btn.innerHTML = '<span class="loading"></span> AI is drafting + reviewing…';
          try {
            const result = await api('/api/plans/preview', {
              method: 'POST',
              body: {
                month: form.month,
                targetCount: form.targetCount,
                mode: form.mode,
                platformMix: {
                  instagram: form.instagramPct / 100,
                  linkedin:  form.linkedinPct / 100,
                },
                constraints: { extra: form.extra },
              },
            });
            preview = result;
            render();
          } catch (err) {
            toast(err.message, 'error');
          } finally { btn.disabled = false; btn.innerHTML = '✨ Generate plan'; }
        } }, '✨ Generate plan'),
      ));
    } else {
      // ---- PREVIEW ----
      if (preview.quality) {
        const qp = renderQualityPanel(preview.quality);
        if (qp) body.appendChild(qp);
      }

      if (preview.specialDays && preview.specialDays.days.length) {
        body.appendChild(el('div', { class: 'drawer-section' },
          el('h4', {}, `Special days this month (${preview.specialDays.days.length})`),
          el('div', { style: 'font-size:12px; color:var(--text-dim); line-height:1.7' },
            ...preview.specialDays.days.slice(0, 10).map(d =>
              el('div', {}, `· ${d.date} — ${d.name} (tier ${d.tier})`)
            ),
          ),
        ));
      }

      body.appendChild(el('div', { class: 'drawer-section' },
        el('h4', {}, `Plan items (${preview.plan.length})`),
        el('div', { class: 'table-wrap', style: 'margin-top:8px' },
          el('table', {},
            el('thead', {}, el('tr', {},
              el('th', {}, 'Date'),
              el('th', {}, 'Theme'),
              el('th', {}, 'Brief'),
              el('th', {}, 'Platform'),
            )),
            el('tbody', {},
              ...preview.plan.map(it => el('tr', {},
                el('td', {}, formatDate(it.scheduled_for, { dateOnly: true })),
                el('td', {}, it.theme),
                el('td', { style: 'max-width:380px; font-size:12px' }, it.topic_brief),
                el('td', {}, it.platforms.join(', ')),
              )),
            ),
          ),
        ),
      ));

      // Auto-publish toggle
      body.appendChild(el('div', { class: 'field' },
        el('label', { class: 'switch-row' },
          el('input', { type: 'checkbox', onchange: (e) => { autoPublish = e.target.checked; } }),
          el('span', { class: 'switch' }),
          el('span', { class: 'switch-label' },
            el('strong', {}, 'Auto-publish generated drafts'),
            el('span', { class: 'switch-hint' }, 'When off (recommended), you review each draft before it goes live. Turn on once you trust the output.'),
          ),
        ),
      ));

      body.appendChild(el('div', { class: 'form-actions' },
        el('button', { class: 'btn btn-ghost', onclick: () => { preview = null; render(); } }, '← Back / regenerate'),
        el('button', { class: 'btn btn-ghost', onclick: closePlanWizard }, 'Cancel'),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          try {
            await api('/api/plans', {
              method: 'POST',
              body: {
                month: form.month,
                targetCount: form.targetCount,
                mode: form.mode,
                platformMix: { instagram: form.instagramPct / 100, linkedin: form.linkedinPct / 100 },
                constraints: { extra: form.extra },
                items: preview.plan,
                autoPublish: autoPublish ? 1 : 0,
              },
            });
            toast('Plan saved', 'success');
            closePlanWizard();
            navigate('calendar', { replace: true });
          } catch (err) { toast(err.message, 'error'); }
        } }, '💾 Save plan'),
      ));
    }

    modal.appendChild(body);
  };
  render();
}

function closePlanWizard() {
  const backdrops = $$('.modal-backdrop');
  const last = backdrops[backdrops.length - 1];
  if (!last) return;
  if (last._onKey) document.removeEventListener('keydown', last._onKey);
  last.remove();
  if (!$('.modal-backdrop')) document.body.style.overflow = '';
}

// ---- Plan detail drawer --------------------------------------------------
async function openPlanDetail(planId) {
  const drawer = $('#drawer');
  const backdrop = $('#drawer-backdrop');
  drawer.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  backdrop.onclick = closeDrawer;
  drawer.innerHTML = '<div class="drawer-body"><div class="loading"></div></div>';

  let plan;
  try { plan = await api('/api/plans/' + planId); }
  catch (e) { toast(e.message, 'error'); closeDrawer(); return; }

  drawer.innerHTML = '';
  drawer.appendChild(el('div', { class: 'drawer-header' },
    el('div', {},
      el('div', { class: 'drawer-title' }, plan.month + ' — ' + plan.target_count + ' posts'),
      el('div', { style: 'margin-top:4px; display:flex; gap:6px; flex-wrap:wrap' },
        el('span', { class: 'badge badge-new' }, plan.status),
        el('span', { class: 'badge' }, plan.mode),
        plan.auto_publish ? el('span', { class: 'quality-chip' }, '⚡ auto-publish') : null,
      ),
    ),
    el('button', { class: 'icon-btn', onclick: closeDrawer }, '✕'),
  ));

  const body = el('div', { class: 'drawer-body' });

  // Auto-publish toggle
  body.appendChild(el('div', { class: 'drawer-section' },
    el('label', { class: 'switch-row' },
      el('input', {
        type: 'checkbox',
        ...(plan.auto_publish ? { checked: 'checked' } : {}),
        onchange: async (e) => {
          try {
            await api('/api/plans/' + plan.id, {
              method: 'PUT',
              body: { auto_publish: e.target.checked ? 1 : 0 },
            });
            toast(e.target.checked ? 'Auto-publish ON' : 'Auto-publish OFF', 'success');
          } catch (err) {
            toast(err.message, 'error');
            e.target.checked = !e.target.checked; // revert
          }
        },
      }),
      el('span', { class: 'switch' }),
      el('span', { class: 'switch-label' },
        el('strong', {}, 'Auto-publish approved drafts'),
        el('span', { class: 'switch-hint' }, 'Drafts generated from this plan will publish without manual approval. Use once you trust the output.'),
      ),
    ),
  ));

  // Automation info + bulk generate
  const pendingCount = plan.items.filter(it => it.status === 'planned' || it.status === 'failed').length;
  body.appendChild(el('div', { class: 'drawer-section notice', style: 'background: rgba(99,102,241,0.08); border-color: rgba(99,102,241,0.25); color: var(--text)' },
    el('div', { style: 'font-size:13px; line-height:1.5; margin-bottom:8px' },
      el('strong', {}, '⏱ How automation works: '),
      'Each item is generated automatically ~48h before its scheduled date. Items further out simply wait. You can generate earlier manually at any time.',
    ),
    pendingCount > 0 ? el('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: async (e) => {
        if (!confirm(`Generate all ${pendingCount} pending items now? This can take several minutes.`)) return;
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<span class="loading"></span> Queued…';
        try {
          const r = await api(`/api/plans/${plan.id}/generate-all-pending`, { method: 'POST' });
          toast(`Queued ${r.scheduled} items — drafts will appear in the list as they complete`, 'success', 5000);
          // Re-open drawer after a short delay so the statuses refresh
          setTimeout(() => openPlanDetail(plan.id), 1500);
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
          btn.innerHTML = `⚡ Generate all ${pendingCount} pending now`;
        }
      },
    }, `⚡ Generate all ${pendingCount} pending now`) : null,
  ));

  // View toggle: list vs grid
  let viewMode = 'list';
  const itemsWrap = el('div', { class: 'drawer-section' });
  const renderItems = () => {
    itemsWrap.innerHTML = '';
    const header = el('div', { style: 'display:flex; justify-content:space-between; align-items:center; margin-bottom:10px' },
      el('h4', { style: 'margin:0' }, `Plan items (${plan.items.length})`),
      el('div', { class: 'view-toggle' },
        el('button', {
          class: 'btn btn-sm ' + (viewMode === 'list' ? 'btn-primary' : 'btn-ghost'),
          onclick: () => { viewMode = 'list'; renderItems(); },
        }, '☰ List'),
        el('button', {
          class: 'btn btn-sm ' + (viewMode === 'grid' ? 'btn-primary' : 'btn-ghost'),
          onclick: () => { viewMode = 'grid'; renderItems(); },
        }, '🗓 Grid'),
      ),
    );
    itemsWrap.appendChild(header);

    if (viewMode === 'list') {
      const list = el('div', { style: 'display:flex; flex-direction:column; gap:8px' },
        ...plan.items.map(it => renderPlanItemCard(plan, it, () => openPlanDetail(plan.id))),
      );
      itemsWrap.appendChild(list);
    } else {
      itemsWrap.appendChild(renderMonthGrid(plan));
    }
  };
  body.appendChild(itemsWrap);
  renderItems();

  // Delete plan
  body.appendChild(el('div', { class: 'drawer-section' },
    el('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
      if (!confirm('Delete this plan and all its items? This cannot be undone.')) return;
      try {
        await api('/api/plans/' + plan.id, { method: 'DELETE' });
        toast('Plan deleted', 'success');
        closeDrawer();
        navigate('calendar', { replace: true });
      } catch (err) { toast(err.message, 'error'); }
    } }, 'Delete plan'),
  ));

  drawer.appendChild(body);
}

function renderPlanItemCard(plan, it, refresh) {
  const actions = el('div', { style: 'display:flex; gap:6px; flex-wrap:wrap; margin-top:8px' });

  // What actions are valid depends on status
  if (it.status === 'planned' || it.status === 'failed') {
    actions.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: async (e) => { await runAction(e.currentTarget, `/api/plans/${plan.id}/items/${it.id}/generate-now`, '⚙ Generating…', refresh); },
    }, '⚙ Generate now'));
  }
  if (it.status === 'draft' && it.post_id) {
    actions.appendChild(el('button', {
      class: 'btn btn-primary btn-sm',
      onclick: async (e) => { await runAction(e.currentTarget, `/api/plans/${plan.id}/items/${it.id}/approve`, 'Approving…', refresh); },
    }, '✓ Approve'));
    actions.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: () => { if (it.post_id) openPostPreviewById(it.post_id); },
    }, '👁 Preview draft'));
  }
  if ((it.status === 'approved' || it.status === 'draft') && it.post_id) {
    actions.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: async (e) => {
        if (!confirm('Publish this post right now, skipping the scheduled time?')) return;
        await runAction(e.currentTarget, `/api/plans/${plan.id}/items/${it.id}/publish-now`, '🚀 Publishing…', refresh);
      },
    }, '🚀 Publish now'));
  }
  if (it.status !== 'published' && it.status !== 'skipped') {
    actions.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm',
      style: 'color: var(--text-dim)',
      onclick: async (e) => {
        if (!confirm('Skip this item? It won\'t be generated or published.')) return;
        await runAction(e.currentTarget, `/api/plans/${plan.id}/items/${it.id}/skip`, 'Skipping…', refresh);
      },
    }, 'Skip'));
  }

  return el('div', {
    style: `padding:10px 12px; background:var(--bg-soft); border:1px solid var(--border-soft); border-radius:var(--radius); ${it.status === 'skipped' ? 'opacity:0.55' : ''}`,
  },
    el('div', { style: 'display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; gap:8px' },
      el('span', { style: 'font-weight:600; font-size:13px' },
        formatDate(it.scheduled_for, { dateOnly: true }) + ' — ' + it.theme),
      el('span', { class: `badge badge-${statusBadgeClass(it.status)}` }, it.status),
    ),
    el('div', { style: 'font-size:12px; color:var(--text); margin-bottom:4px' }, it.topic_brief),
    it.reasoning ? el('div', { style: 'font-size:11px; color:var(--text-dim); font-style:italic' }, '→ ' + it.reasoning) : null,
    el('div', { style: 'font-size:11px; color:var(--text-mute); margin-top:4px' }, it.platforms.join(', ')),
    it.error ? el('div', { style: 'font-size:11px; color:var(--danger); margin-top:4px' }, '⚠ ' + it.error) : null,
    actions,
  );
}

async function runAction(btn, url, busyLabel, refresh) {
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = `<span class="loading"></span> ${busyLabel}`;
  try {
    await api(url, { method: 'POST' });
    toast('Done', 'success');
    if (refresh) await refresh();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

async function openPostPreviewById(postId) {
  try {
    const post = await api('/api/posts/' + postId);
    openPostPreview(post);
  } catch (err) { toast(err.message, 'error'); }
}

// ---- Month grid renderer -------------------------------------------------
// Renders the plan's month as a 7-col calendar grid. Each cell shows the
// day number; items scheduled that day appear as clickable chips.
function renderMonthGrid(plan) {
  const [y, m] = plan.month.split('-').map(Number);   // e.g. 2026, 5
  const firstDay = new Date(Date.UTC(y, m - 1, 1));
  const lastDay  = new Date(Date.UTC(y, m, 0));      // day 0 of next month = last of this
  const daysInMonth = lastDay.getUTCDate();
  // Calendar grids show Mon-first in most of the world; adjust if needed
  // 0=Sun 1=Mon ... -> we want Mon-first: (dow + 6) % 7
  const leadingBlanks = (firstDay.getUTCDay() + 6) % 7;

  // Group items by day number
  const byDay = new Map();
  for (const it of plan.items) {
    const d = new Date(it.scheduled_for);
    if (d.getUTCFullYear() !== y || d.getUTCMonth() !== m - 1) continue;
    const key = d.getUTCDate();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(it);
  }

  const wrap = el('div', { class: 'month-grid-wrap' });

  // Weekday header
  const weekdays = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const headRow = el('div', { class: 'month-grid-head' },
    ...weekdays.map(w => el('div', { class: 'month-grid-wday' }, w)));
  wrap.appendChild(headRow);

  const grid = el('div', { class: 'month-grid' });
  for (let i = 0; i < leadingBlanks; i++) {
    grid.appendChild(el('div', { class: 'month-grid-cell blank' }));
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const cell = el('div', { class: 'month-grid-cell' });
    cell.appendChild(el('div', { class: 'month-grid-date' }, String(day)));
    const items = byDay.get(day) || [];
    for (const it of items) {
      cell.appendChild(el('div', {
        class: `month-grid-item item-${statusBadgeClass(it.status)}`,
        title: it.topic_brief,
        onclick: (e) => {
          e.stopPropagation();
          // Scroll to and highlight the item in the list view
          if (it.post_id) { openPostPreviewById(it.post_id); }
          else toast(it.topic_brief + ' — ' + it.status, 'info');
        },
      },
        el('span', { class: 'month-grid-dot' }),
        el('span', { class: 'month-grid-title' }, it.theme || ''),
      ));
    }
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);
  return wrap;
}

function statusBadgeClass(status) {
  return {
    planned:    'new',
    generating: 'contacted',
    draft:      'qualified',
    approved:   'contacted',
    publishing: 'contacted',
    published:  'won',
    failed:     'lost',
    skipped:    'lost',
  }[status] || 'new';
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
      el('label', {}, 'Logo overlay position',
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

  // Contact strip toggle — same pattern as the logo, but optional.
  // overlay_contact_enabled defaults to 1 (on) for brands that haven't
  // explicitly opted out.
  const contactEnabled = brand.overlay_contact_enabled === 0 ? false : true;
  form.appendChild(el('div', { class: 'field' },
    el('label', { class: 'switch-row' },
      el('input', {
        type: 'checkbox',
        name: 'overlay_contact_enabled',
        ...(contactEnabled ? { checked: 'checked' } : {}),
      }),
      el('span', { class: 'switch' }),
      el('span', { class: 'switch-label' },
        el('strong', {}, 'Contact strip on every image / video'),
        el('span', { class: 'switch-hint' },
          'Auto-stamps your phone / WhatsApp / website / handles along the bottom of generated media. Turn off if your visuals already include contact info.'),
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

  // Country + founding date — both feed the calendar planner so the user
  // doesn't need to enter public holidays or anniversary by hand.
  bizForm.appendChild(bizRow(
    selectField('country', 'Country', [
      ['GB', 'United Kingdom'],
      ['TR', 'Türkiye'],
      ['US', 'United States'],
      ['DE', 'Germany'],
      ['FR', 'France'],
      ['IT', 'Italy'],
      ['ES', 'Spain'],
      ['NL', 'Netherlands'],
      ['IE', 'Ireland'],
      ['CA', 'Canada'],
      ['AU', 'Australia'],
      ['NZ', 'New Zealand'],
      ['AE', 'United Arab Emirates'],
      ['SA', 'Saudi Arabia'],
      ['IN', 'India'],
    ], brand.country),
    el('div', { class: 'field' },
      el('label', {}, 'Founding date',
        el('input', {
          type: 'date',
          name: 'founding_date',
          value: brand.founding_date || '',
        }),
        el('div', { class: 'field-hint' },
          'We will auto-add your company anniversary to the content plan every year.'),
      ),
    ),
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

  // ---- COUNTRY HOLIDAYS PREVIEW ----
  // Read-only list pulled from /api/brand/holidays for the brand's country.
  // Shows the user what the planner will automatically include — they don't
  // need to add bank holidays by hand.
  const holidaysCard = el('div', { class: 'card', style: 'margin-top:20px' });
  holidaysCard.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Public holidays'),
    el('div', { class: 'section-sub' },
      'Automatically pulled from your country. The content planner uses these as anchor dates — no manual entry needed.'),
  ));
  const holidaysBody = el('div');
  holidaysCard.appendChild(holidaysBody);
  root.appendChild(holidaysCard);

  async function refreshHolidays() {
    const country = bizForm.querySelector('[name=country]')?.value || brand.country;
    if (!country) {
      holidaysBody.innerHTML = '<div style="color:var(--text-dim); font-size:13px; padding:10px">Pick a country in the profile above to see your public holidays.</div>';
      return;
    }
    holidaysBody.innerHTML = '<div class="loading"></div>';
    try {
      const r = await api(`/api/brand/holidays?country=${encodeURIComponent(country)}`);
      if (stale(myGen)) return;
      holidaysBody.innerHTML = '';
      if (!r.holidays?.length) {
        holidaysBody.innerHTML = `<div style="color:var(--text-dim); font-size:13px; padding:10px">No holidays found for ${country}.</div>`;
        return;
      }
      const grid = el('div', { class: 'holidays-grid' });
      r.holidays.forEach(h => {
        const d = new Date(h.date);
        grid.appendChild(el('div', { class: 'holiday-row' },
          el('div', { class: 'holiday-date' },
            el('div', { class: 'holiday-day' }, String(d.getDate())),
            el('div', { class: 'holiday-month' }, d.toLocaleString(undefined, { month: 'short' })),
          ),
          el('div', { class: 'holiday-info' },
            el('div', { class: 'holiday-name' }, h.name),
            el('div', { class: 'holiday-meta' }, h.type),
          ),
        ));
      });
      holidaysBody.appendChild(grid);
    } catch (err) {
      holidaysBody.innerHTML = `<div class="auth-error show">${err.message}</div>`;
    }
  }
  refreshHolidays();
  // Refresh when the user changes country in the profile form (live preview).
  bizForm.querySelector('[name=country]')?.addEventListener('change', refreshHolidays);

  // ---- IMPORTANT DATES CARD ----
  const datesCard = el('div', { class: 'card', style: 'margin-top:20px' });
  datesCard.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Important dates'),
    el('div', { class: 'section-sub' }, 'Company anniversaries, launches, events — AI uses these when planning your monthly content.'),
  ));

  const datesList = el('div', { style: 'display:flex; flex-direction:column; gap:8px; margin-bottom:12px' });
  datesCard.appendChild(datesList);

  async function refreshDates() {
    datesList.innerHTML = '';
    try {
      const dates = await api('/api/brand/dates');
      if (!dates.length) {
        datesList.appendChild(el('div', { style: 'color:var(--text-dim); font-size:13px; padding:10px' },
          'No important dates yet. Add your company\'s anniversary, product launch days, recurring events…'));
        return;
      }
      const monthName = (m) => new Date(2000, m - 1, 1).toLocaleString(undefined, { month: 'long' });
      dates.forEach(d => {
        datesList.appendChild(el('div', {
          style: 'display:flex; align-items:center; gap:10px; padding:10px 12px; background:var(--bg-soft); border:1px solid var(--border-soft); border-radius:var(--radius)',
        },
          el('div', { style: 'font-size:11px; text-align:center; min-width:48px; color:var(--accent-hover)' },
            el('div', { style: 'font-weight:700; font-size:18px' }, String(d.day)),
            el('div', { style: 'text-transform:uppercase; letter-spacing:0.05em' }, monthName(d.month).slice(0,3)),
          ),
          el('div', { style: 'flex:1' },
            el('div', { style: 'font-weight:600; font-size:14px' }, d.name),
            d.note ? el('div', { style: 'font-size:12px; color:var(--text-dim)' }, d.note) : null,
            el('div', { style: 'font-size:11px; color:var(--text-mute); margin-top:2px' },
              (d.annual ? 'Every year' : 'One-off') + ' · Tier ' + d.tier),
          ),
          el('button', {
            class: 'icon-btn', title: 'Remove',
            onclick: async () => {
              if (!confirm('Remove this date?')) return;
              try { await api('/api/brand/dates/' + d.id, { method: 'DELETE' }); refreshDates(); } catch (e) { toast(e.message, 'error'); }
            },
          }, '✕'),
        ));
      });
    } catch (err) { toast(err.message, 'error'); }
  }
  refreshDates();

  // Add-date form
  const addForm = el('form', { class: 'row' });
  const nameIn  = el('input', { type: 'text', name: 'name', placeholder: 'e.g. Company anniversary', required: true });
  const monthIn = (() => {
    const s = el('select', { name: 'month', required: true });
    ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].forEach((lbl, i) => {
      s.appendChild(el('option', { value: String(i + 1) }, lbl));
    });
    return s;
  })();
  const dayIn = el('input', { type: 'number', name: 'day', min: '1', max: '31', placeholder: 'Day', required: true, style: 'width:80px' });
  const tierIn = (() => {
    const s = el('select', { name: 'tier' });
    [['1','Must-consider'],['2','Strong'],['3','Nice-to-have']].forEach(([v,t])=>s.appendChild(el('option',{value:v},t)));
    return s;
  })();
  const addBtn = el('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, '+ Add');
  addForm.appendChild(el('div', { class: 'field' }, el('label', {}, 'Name', nameIn)));
  addForm.appendChild(el('div', { style: 'display:flex; gap:8px; align-items:end' },
    el('div', { class: 'field', style: 'flex:1; margin-bottom:0' }, el('label', {}, 'Month', monthIn)),
    el('div', { class: 'field', style: 'margin-bottom:0' }, el('label', {}, 'Day', dayIn)),
    el('div', { class: 'field', style: 'flex:1; margin-bottom:0' }, el('label', {}, 'Tier', tierIn)),
    addBtn,
  ));
  addForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/brand/dates', {
        method: 'POST',
        body: {
          name:  nameIn.value.trim(),
          month: Number(monthIn.value),
          day:   Number(dayIn.value),
          tier:  Number(tierIn.value),
          annual: true,
        },
      });
      nameIn.value = ''; dayIn.value = '';
      refreshDates();
      toast('Date added', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
  datesCard.appendChild(addForm);
  root.appendChild(datesCard);
};

// =======================================================================
//   VIEW: SETTINGS
// =======================================================================
VIEWS.settings = async function settingsView(root, myGen) {
  const u = State.user;
  root.innerHTML = '';

  // ---- Billing card (top of Settings — most-asked question) ----
  renderBillingCard(root, myGen);

  // ---- Account card ----
  const card = el('div', { class: 'card', style: 'margin-top:20px' });
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

  // ---- Intake webhook card ----
  const intakeCard = el('div', { class: 'card', style: 'margin-top:20px' });
  intakeCard.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Intake webhook'),
    el('div', { class: 'section-sub' },
      'POST leads from Typeform, Zapier, website forms, or any tool. Every submission becomes a new lead in your CRM.'),
  ));
  const intakeBody = el('div');
  intakeCard.appendChild(intakeBody);
  root.appendChild(intakeCard);

  async function loadIntake() {
    intakeBody.innerHTML = '<div class="loading"></div>';
    let info;
    try { info = await api('/api/leads/intake/token'); }
    catch (e) { intakeBody.innerHTML = `<div class="auth-error show">${e.message}</div>`; return; }
    if (stale(myGen)) return;

    const curlEx = `curl -X POST ${info.url} \\\n  -H "Content-Type: application/json" \\\n  -d '{"name":"Jane Doe","email":"jane@example.com","message":"Interested in a demo"}'`;

    intakeBody.innerHTML = '';
    intakeBody.appendChild(el('div', { class: 'intake-url-row' },
      el('label', { style: 'font-size:12px; color:var(--text-dim); font-weight:500' }, 'Your intake URL'),
      el('div', { class: 'intake-url-field' },
        el('code', { class: 'intake-url' }, info.url),
        el('button', {
          class: 'btn btn-sm', title: 'Copy',
          onclick: () => {
            navigator.clipboard.writeText(info.url).then(() => toast('Copied', 'success'));
          },
        }, 'Copy'),
      ),
    ));

    intakeBody.appendChild(el('details', { class: 'intake-details', style: 'margin-top:14px' },
      el('summary', {}, 'cURL example'),
      el('pre', { class: 'intake-curl' }, curlEx),
    ));

    intakeBody.appendChild(el('details', { class: 'intake-details', style: 'margin-top:8px' },
      el('summary', {}, 'Accepted field names'),
      el('div', { style: 'font-size:13px; color:var(--text-dim); padding:8px 4px; line-height:1.7' },
        el('div', {}, '• name, full_name, fullName, contact'),
        el('div', {}, '• email, emailAddress'),
        el('div', {}, '• phone, tel, mobile, phone_number'),
        el('div', {}, '• message, comment, body, note'),
        el('div', {}, '• source, channel (defaults to "webhook")'),
        el('div', { style: 'margin-top:6px; color:var(--text-mute); font-size:12px' },
          'Any other fields are preserved on the lead\'s activity log.'),
      ),
    ));

    intakeBody.appendChild(el('div', { class: 'form-actions', style: 'margin-top:16px' },
      el('button', {
        class: 'btn btn-danger btn-sm',
        onclick: async () => {
          if (!confirm('Rotate your intake token? The old URL will stop working immediately.')) return;
          try {
            await api('/api/leads/intake/token/rotate', { method: 'POST' });
            toast('Token rotated', 'success');
            loadIntake();
          } catch (e) { toast(e.message, 'error'); }
        },
      }, 'Rotate token'),
    ));
  }
  loadIntake();

  // ---- Connections card ----
  const connCard = el('div', { class: 'card', style: 'margin-top:20px' });
  connCard.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Connections'),
    el('div', { class: 'section-sub' }, 'Connect your social accounts so Hitra can publish on your behalf.'),
  ));
  const connBody = el('div');
  connCard.appendChild(connBody);
  root.appendChild(connCard);

  // Handle OAuth callback result (hash carries query-string-looking params after '#settings/connections?...')
  const hashQuery = location.hash.includes('?') ? location.hash.split('?')[1] : '';
  if (hashQuery) {
    const params = new URLSearchParams(hashQuery);
    if (params.get('status') === 'ok') {
      toast(`Connected ${params.get('platform') || ''}${params.get('count') ? ' (' + params.get('count') + ' accounts)' : ''}`, 'success');
    } else if (params.get('status') === 'error') {
      toast('Connection failed: ' + (params.get('reason') || 'unknown error'), 'error', 7000);
    }
    // Clean the hash so we don't re-toast on refresh
    history.replaceState(null, '', '#settings');
  }

  async function loadConnections() {
    connBody.innerHTML = '<div class="loading"></div>';
    let creds = [];
    try { creds = await api('/api/connect'); } catch (e) { toast(e.message, 'error'); }
    if (stale(myGen)) return;
    connBody.innerHTML = '';

    // Group by platform for tidy display
    const byPlatform = { facebook: [], instagram: [], linkedin: [] };
    for (const c of creds) if (byPlatform[c.platform]) byPlatform[c.platform].push(c);

    const platforms = [
      { key: 'instagram', label: 'Instagram', icon: '📷', provider: 'meta',
        desc: 'Post images and captions to your IG Business account. Requires an IG account linked to a Facebook page.' },
      { key: 'facebook',  label: 'Facebook Page', icon: '👥', provider: 'meta',
        desc: 'Publish to Facebook pages you admin.' },
      { key: 'linkedin',  label: 'LinkedIn', icon: '💼', provider: 'linkedin',
        desc: 'Post to your personal LinkedIn feed on your behalf.' },
    ];

    for (const p of platforms) {
      const accts = byPlatform[p.key] || [];
      const tile = el('div', { class: 'conn-tile' });

      tile.appendChild(el('div', { class: 'conn-head' },
        el('span', { class: 'conn-icon' }, p.icon),
        el('div', { style: 'flex:1' },
          el('div', { class: 'conn-title' }, p.label),
          el('div', { class: 'conn-desc' }, p.desc),
        ),
        el('button', {
          class: 'btn btn-primary btn-sm',
          onclick: async () => {
            try {
              const r = await api(`/api/connect/${p.provider}/start`);
              window.location.href = r.url;
            } catch (err) { toast(err.message, 'error'); }
          },
        }, accts.length ? '+ Add another' : 'Connect'),
      ));

      if (accts.length) {
        const list = el('div', { class: 'conn-accounts' });
        for (const a of accts) {
          list.appendChild(renderConnectedAccount(a, loadConnections));
        }
        tile.appendChild(list);
      }
      connBody.appendChild(tile);
    }
  }

  loadConnections();
};

function renderConnectedAccount(a, refresh) {
  const daysLeft = a.expires_at
    ? Math.floor((new Date(a.expires_at).getTime() - Date.now()) / 86400000)
    : null;
  const statusClass = a.status === 'active'
    ? (daysLeft !== null && daysLeft < 7 ? 'warn' : 'good')
    : (a.status === 'expired' || a.status === 'needs_reauth' ? 'bad' : 'warn');

  return el('div', { class: 'conn-account' },
    a.account_avatar_url
      ? el('img', { src: a.account_avatar_url, alt: '', class: 'conn-avatar' })
      : el('div', { class: 'conn-avatar conn-avatar-fallback' },
          (a.account_name || '?')[0].toUpperCase()),
    el('div', { style: 'flex:1; min-width:0' },
      el('div', { style: 'font-weight:500; font-size:13px' }, a.account_name || a.account_handle || '(unnamed)'),
      el('div', { style: 'font-size:11px; color:var(--text-dim)' },
        a.account_handle ? '@' + String(a.account_handle).replace(/^@/, '') : (a.account_id || ''),
      ),
    ),
    el('div', { class: `conn-status conn-status-${statusClass}` },
      a.status === 'active'
        ? (daysLeft !== null ? `${daysLeft}d left` : 'Active')
        : (a.status === 'needs_reauth' ? '⚠ Reconnect' : a.status),
    ),
    el('button', {
      class: 'icon-btn', title: 'Disconnect',
      onclick: async () => {
        if (!confirm(`Disconnect "${a.account_name || a.platform}"?`)) return;
        try { await api('/api/connect/' + a.id, { method: 'DELETE' }); toast('Disconnected', 'success'); refresh(); }
        catch (e) { toast(e.message, 'error'); }
      },
    }, '✕'),
  );
}

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
// =======================================================================
//   BILLING — pricing view, upgrade modal, usage bars
// =======================================================================

// Cache the plans catalog for the session — small, public, and queried by
// every billing UI. Falls back to an empty catalog if the API isn't up.
let _plansCache = null;
async function loadPlans() {
  if (_plansCache) return _plansCache;
  try {
    _plansCache = await api('/api/public/billing/plans');
  } catch {
    _plansCache = {};
  }
  return _plansCache;
}

function gbp(amount) {
  if (amount == null) return 'Custom';
  if (amount === 0)   return 'Free';
  return '£' + amount;
}

function formatQuota(n) {
  if (n === -1) return 'Unlimited';
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return String(n);
}

// ---- Upgrade modal (shown on 402, also from "Upgrade" buttons) ----------
function openUpgradeModal({ code, metric, limit, used, currentPlan, requiredPlan, planStatus, resetsAt } = {}) {
  // Avoid stacking — if the modal is already up, leave it alone.
  if (document.getElementById('upgrade-modal')) return;

  const backdrop = el('div', { class: 'modal-backdrop', id: 'upgrade-modal' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  let title = 'Upgrade to keep going';
  let lede  = '';
  if (code === 'quota_exceeded') {
    const metricLabel = ({ posts: 'posts', ai_calls: 'AI calls', leads: 'leads' }[metric]) || metric;
    title = `You've hit this month's ${metricLabel} limit`;
    lede  = `You've used ${used} of ${limit} ${metricLabel} on the ${currentPlan || 'free'} plan. Upgrade to keep generating, or wait until ${resetsAt ? new Date(resetsAt).toLocaleDateString() : 'next month'} for the counter to reset.`;
  } else if (code === 'plan_required') {
    title = `${requiredPlan ? requiredPlan[0].toUpperCase() + requiredPlan.slice(1) : 'A higher'} plan required`;
    lede  = `This feature is included on ${requiredPlan} and above. You're on ${currentPlan || 'free'}.`;
  } else if (code === 'plan_inactive') {
    title = 'Your subscription needs attention';
    lede  = `Your billing status is "${planStatus}". Update your card to restore access.`;
  } else {
    lede = 'Upgrade to a paid plan to continue.';
  }

  const card = el('div', { class: 'modal-card upgrade-modal' });
  card.appendChild(el('button', { class: 'modal-close', onclick: close, title: 'Close' }, '✕'));
  card.appendChild(el('h2', {}, title));
  card.appendChild(el('p', { class: 'upgrade-lede' }, lede));

  const planRow = el('div', { class: 'upgrade-plans' });
  card.appendChild(planRow);
  card.appendChild(el('div', { class: 'upgrade-actions' },
    el('button', {
      class: 'btn btn-ghost',
      onclick: close,
    }, 'Maybe later'),
    el('a', {
      class: 'btn btn-primary',
      href: '#pricing',
      onclick: () => { close(); navigate('pricing'); },
    }, 'See all plans'),
  ));

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  // Async: fill the inline plan summary so the user can one-click upgrade.
  loadPlans().then(plans => {
    planRow.innerHTML = '';
    const sequence = ['starter', 'pro', 'agency'];
    const cur = currentPlan || 'free';
    for (const id of sequence) {
      const p = plans[id];
      if (!p) continue;
      // Only show plans strictly ABOVE the current one — no point in
      // suggesting a sideways move.
      if (plans[cur] && p.rank <= plans[cur].rank) continue;
      planRow.appendChild(renderPricingCardCompact(p));
    }
    if (!planRow.children.length) {
      planRow.appendChild(el('div', { class: 'pricing-empty' },
        'You\'re already on our top published plan. Contact sales for Enterprise.'));
    }
  });
}

function renderPricingCardCompact(plan) {
  return el('div', { class: 'pricing-card pricing-card-compact' },
    el('div', { class: 'pricing-card-name' }, plan.name),
    el('div', { class: 'pricing-card-price' },
      el('span', { class: 'pricing-card-price-amount' }, gbp(plan.priceMonthlyGbp)),
      plan.priceMonthlyGbp != null && plan.priceMonthlyGbp > 0
        ? el('span', { class: 'pricing-card-price-period' }, '/mo')
        : null,
    ),
    el('ul', { class: 'pricing-card-list' },
      el('li', {}, formatQuota(plan.quotas.posts)    + ' posts/mo'),
      el('li', {}, formatQuota(plan.quotas.ai_calls) + ' AI calls/mo'),
      el('li', {}, formatQuota(plan.quotas.leads)    + ' leads/mo'),
    ),
    el('button', {
      class: 'btn btn-primary btn-block',
      onclick: () => startCheckout(plan.id, 'monthly'),
    }, `Upgrade to ${plan.name}`),
  );
}

async function startCheckout(plan, interval) {
  if (!State.user) { navigate('pricing'); return; }
  try {
    const { url } = await api('/api/billing/checkout', { method: 'POST', body: { plan, interval } });
    window.location.href = url;
  } catch (e) {
    if (e.status === 503) {
      toast('Billing is not yet live — we\'ll email you when it is.', 'info', 5000);
    } else {
      toast(e.message, 'error');
    }
  }
}

async function openCustomerPortal() {
  try {
    const { url } = await api('/api/billing/portal', { method: 'POST' });
    window.location.href = url;
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---- VIEW: pricing -------------------------------------------------------
VIEWS.pricing = async function pricingView(root, myGen) {
  $('#page-title').textContent = 'Pricing';
  root.innerHTML = '<div class="loading"></div>';

  const [plans, billing] = await Promise.all([
    loadPlans(),
    State.user ? api('/api/billing/me').catch(() => null) : Promise.resolve(null),
  ]);
  if (stale(myGen)) return;

  root.innerHTML = '';

  const intro = el('div', { class: 'pricing-intro' },
    el('h1', {}, 'Pick the plan that fits your business'),
    el('p', {}, 'Switch tiers any time. All plans include multi-model content review, calendar automation, and the lead CRM.'),
  );

  // Monthly / Yearly toggle. Yearly is 10× monthly (≈ 2 months free).
  let interval = 'monthly';
  const monthlyBtn = el('button', { class: 'pricing-toggle-btn active' }, 'Monthly');
  const yearlyBtn  = el('button', { class: 'pricing-toggle-btn' }, 'Yearly · save ~17%');
  const toggle = el('div', { class: 'pricing-toggle' }, monthlyBtn, yearlyBtn);
  intro.appendChild(toggle);

  root.appendChild(intro);

  const grid = el('div', { class: 'pricing-grid' });
  root.appendChild(grid);

  function renderGrid() {
    grid.innerHTML = '';
    for (const id of ['starter', 'pro', 'agency', 'enterprise']) {
      const p = plans[id];
      if (!p) continue;
      grid.appendChild(renderPricingCardFull(p, interval, billing));
    }
  }
  monthlyBtn.addEventListener('click', () => {
    interval = 'monthly';
    monthlyBtn.classList.add('active'); yearlyBtn.classList.remove('active');
    renderGrid();
  });
  yearlyBtn.addEventListener('click', () => {
    interval = 'yearly';
    yearlyBtn.classList.add('active'); monthlyBtn.classList.remove('active');
    renderGrid();
  });
  renderGrid();
};

function renderPricingCardFull(plan, interval, billing) {
  const isYearly = interval === 'yearly';
  const price = isYearly ? plan.priceYearlyGbp : plan.priceMonthlyGbp;
  const periodLabel = isYearly ? '/yr' : '/mo';
  const isCurrent = billing && billing.plan === plan.id;
  const isEnterprise = plan.id === 'enterprise';

  const card = el('div', {
    class: 'pricing-card' + (plan.id === 'pro' ? ' pricing-card-featured' : '') + (isCurrent ? ' pricing-card-current' : ''),
  });

  if (plan.id === 'pro') card.appendChild(el('div', { class: 'pricing-badge' }, 'Most popular'));
  if (isCurrent)         card.appendChild(el('div', { class: 'pricing-badge pricing-badge-current' }, 'Your plan'));

  card.appendChild(el('div', { class: 'pricing-card-name' }, plan.name));

  const priceBlock = el('div', { class: 'pricing-card-price' });
  if (isEnterprise) {
    priceBlock.appendChild(el('span', { class: 'pricing-card-price-amount' }, 'Custom'));
  } else if (price === 0 || price == null) {
    priceBlock.appendChild(el('span', { class: 'pricing-card-price-amount' }, 'Free'));
  } else {
    priceBlock.appendChild(el('span', { class: 'pricing-card-price-amount' }, '£' + price));
    priceBlock.appendChild(el('span', { class: 'pricing-card-price-period' }, periodLabel));
  }
  card.appendChild(priceBlock);

  card.appendChild(el('ul', { class: 'pricing-card-list' },
    el('li', {}, formatQuota(plan.quotas.posts)    + ' posts / month'),
    el('li', {}, formatQuota(plan.quotas.ai_calls) + ' AI calls / month'),
    el('li', {}, formatQuota(plan.quotas.leads)    + ' leads / month'),
    el('li', {}, formatQuota(plan.features.socials) + ' connected socials'),
    plan.features.video > 0 || plan.features.video === -1
      ? el('li', {}, formatQuota(plan.features.video) + ' AI videos / month')
      : null,
    plan.features.seats > 1 || plan.features.seats === -1
      ? el('li', {}, formatQuota(plan.features.seats) + ' team seats')
      : null,
    plan.features.white_label ? el('li', {}, 'White-label / custom domain') : null,
    plan.features.sso         ? el('li', {}, 'SSO + SAML')                  : null,
    plan.features.sla         ? el('li', {}, 'SLA + dedicated VM')          : null,
  ));

  let cta;
  if (isEnterprise) {
    cta = el('a', {
      class: 'btn btn-ghost btn-block',
      href: 'mailto:sales@hitrapost.co.uk?subject=Enterprise%20pricing',
    }, 'Contact sales');
  } else if (isCurrent) {
    cta = el('button', {
      class: 'btn btn-ghost btn-block',
      onclick: openCustomerPortal,
    }, 'Manage subscription');
  } else {
    cta = el('button', {
      class: 'btn btn-primary btn-block',
      onclick: () => startCheckout(plan.id, interval),
    }, billing ? `Upgrade to ${plan.name}` : `Start with ${plan.name}`);
  }
  card.appendChild(cta);

  return card;
}

// ---- Render the Billing card inside the Settings view -------------------
async function renderBillingCard(parent, myGen) {
  const card = el('div', { class: 'card', style: 'margin-top:20px' });
  card.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Billing'),
    el('div', { class: 'section-sub' }, 'Plan, usage, and invoices.'),
  ));
  const body = el('div');
  card.appendChild(body);
  parent.appendChild(card);

  body.innerHTML = '<div class="loading"></div>';
  let billing;
  try { billing = await api('/api/billing/me'); }
  catch (e) { body.innerHTML = `<div class="auth-error show">${e.message}</div>`; return; }
  if (stale(myGen)) return;

  body.innerHTML = '';

  // Plan summary
  const planLabel = billing.planName + (billing.planStatus === 'trialing' ? ' (trial)' : '');
  body.appendChild(el('div', { class: 'billing-plan-row' },
    el('div', { class: 'billing-plan-name' }, planLabel),
    el('div', { class: 'billing-plan-status', dataset: { status: billing.planStatus } },
      billing.planStatus.replace('_', ' ')),
  ));

  if (billing.inTrial && billing.trialEndsAt) {
    const days = Math.ceil((new Date(billing.trialEndsAt) - Date.now()) / (24 * 3600 * 1000));
    body.appendChild(el('div', { class: 'billing-trial-banner' },
      `Trial ends in ${days} day${days === 1 ? '' : 's'} — your card will be charged for ${billing.planName} on ${new Date(billing.trialEndsAt).toLocaleDateString()}.`));
  }

  // Usage bars
  const usageWrap = el('div', { class: 'usage-bars' });
  for (const metric of ['posts', 'ai_calls', 'leads']) {
    const used  = billing.usage[metric] || 0;
    const limit = billing.quotas[metric];
    usageWrap.appendChild(renderUsageBar(metric, used, limit));
  }
  body.appendChild(usageWrap);

  // Action row
  const actions = el('div', { class: 'form-actions', style: 'margin-top:16px' });
  if (billing.stripeCustomerId) {
    actions.appendChild(el('button', { class: 'btn', onclick: openCustomerPortal }, 'Manage card & invoices'));
  }
  actions.appendChild(el('a', {
    class: 'btn btn-primary',
    href: '#pricing',
    onclick: (e) => { e.preventDefault(); navigate('pricing'); },
  }, billing.plan === 'free' || billing.plan === 'starter' ? 'See plans' : 'Change plan'));
  body.appendChild(actions);

  if (!billing.stripeConfigured) {
    body.appendChild(el('div', { class: 'billing-warning', style: 'margin-top:12px' },
      'Billing is not yet live in this environment. Plan upgrades will return 503 until Stripe is configured.'));
  }
}

function renderUsageBar(metric, used, limit) {
  const label = ({ posts: 'Posts', ai_calls: 'AI calls', leads: 'Leads' })[metric] || metric;
  const unlimited = limit === -1;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const danger = pct >= 90;
  const warn   = pct >= 70 && pct < 90;
  const cls    = 'usage-bar-fill' + (danger ? ' danger' : warn ? ' warn' : '');

  return el('div', { class: 'usage-bar' },
    el('div', { class: 'usage-bar-row' },
      el('span', { class: 'usage-bar-label' }, label),
      el('span', { class: 'usage-bar-val' },
        unlimited ? `${used} used` : `${used} / ${formatQuota(limit)}`),
    ),
    unlimited ? null : el('div', { class: 'usage-bar-track' },
      el('div', { class: cls, style: `width:${pct}%` })),
  );
}

(async function main() {
  const ok = await loadSession();
  if (ok) await bootApp();
  else renderAuthScreen();
})();
