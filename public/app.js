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
      const out = await api('/api/auth/login', {
        method: 'POST',
        body: {
          email: String(fd.get('email') || '').trim(),
          // Trim pasted whitespace (common when copying creds). Real
          // passwords with leading/trailing spaces are vanishingly rare.
          password: String(fd.get('password') || '').trim(),
        },
      });
      // Two-phase login when 2FA is enabled. The first /login response is
      // { step: '2fa' }, NOT a user record — open the challenge form and
      // let it call /login/2fa with the code.
      if (out && out.step === '2fa') {
        showTwoFactorChallenge();
        return;
      }
      State.user = out;
      await bootApp();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
    }
  };

  // "Forgot password?" — toggles a tiny form below the login form.
  wireForgotPasswordLink();

  // Handle ?reset_token=... arriving from the password-reset email.
  if (location.search.includes('reset_token=')) {
    const t = new URLSearchParams(location.search).get('reset_token');
    if (t) showPasswordResetForm(t);
  }
  if (location.search.includes('email_changed=1')) {
    toast('Email updated. Please sign in again with your new email.', 'success', 6000);
    history.replaceState(null, '', location.pathname + location.hash);
  }

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
  if (location.search.includes('billing=') || location.search.includes('verified=')) {
    const q = new URLSearchParams(location.search);
    const billingStatus = q.get('billing');
    if (billingStatus === 'success') {
      toast('Subscription active. Welcome aboard!', 'success', 6000);
      // Bust the cached billing/me — server has already synced from the
      // webhook by the time the redirect lands, but the cached value the
      // dashboard fetched at boot will be stale.
      _plansCache = null;
    } else if (billingStatus === 'canceled') {
      toast('Checkout canceled. No charge.', 'info');
    }
    if (q.get('verified') === '1') {
      toast('Email verified. AI generation unlocked.', 'success', 5000);
      State.user.emailVerified = true;
    }
    // Strip the query string while preserving the hash route.
    history.replaceState(null, '', location.pathname + location.hash);
  }

  // Verify-email banner — persistent reminder until the user clicks the link
  // in their inbox. We hide it when verified.
  renderVerifyBanner();

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

  // 7-day activity chart — leads + posts created per day. Helps the
  // operator spot trend changes (e.g. "campaign on Tuesday spiked leads").
  // Inline SVG, no chart library: keeps the bundle small and the look
  // consistent with the rest of the dark UI.
  if (leads.length || posts.length) {
    root.appendChild(renderActivityChart(leads, posts));
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

// 7-day activity chart for the dashboard. Buckets `leads` and `posts` into
// the last 7 calendar days (UTC) and renders two stacked-area-ish line
// series in inline SVG. Keeps the whole thing under 100 lines so we don't
// pull in a chart library.
function renderActivityChart(leads, posts) {
  const DAYS = 7;
  const ms = 24 * 60 * 60 * 1000;
  // Snap "today" to UTC midnight so two events on the same wall-clock day
  // bucket together regardless of viewer timezone. The dashboard already
  // computes "new this week" with the same boundary.
  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);
  const startUTC = todayUTC.getTime() - (DAYS - 1) * ms;

  function bucket(items, dateKey) {
    const out = new Array(DAYS).fill(0);
    for (const it of items) {
      const raw = it[dateKey];
      if (!raw) continue;
      // Server stores 'YYYY-MM-DD HH:MM:SS' UTC. Normalise into a Date.
      const t = new Date(String(raw).replace(' ', 'T') + 'Z').getTime();
      if (Number.isNaN(t)) continue;
      const diffDays = Math.floor((t - startUTC) / ms);
      if (diffDays < 0 || diffDays >= DAYS) continue;
      out[diffDays]++;
    }
    return out;
  }
  const leadsByDay = bucket(leads, 'created_at');
  const postsByDay = bucket(posts, 'created_at');
  const peak = Math.max(1, ...leadsByDay, ...postsByDay);

  // SVG layout: 600x140 viewBox. Padding leaves room for axis labels.
  const W = 600, H = 140, PAD_X = 32, PAD_Y = 12;
  const innerW = W - 2 * PAD_X;
  const innerH = H - 2 * PAD_Y;
  const stepX = innerW / (DAYS - 1);

  function pointsFor(arr) {
    return arr.map((v, i) => {
      const x = PAD_X + i * stepX;
      const y = PAD_Y + innerH - (v / peak) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }

  const dayLabel = (i) => {
    const d = new Date(startUTC + i * ms);
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  };

  const card = el('div', { class: 'card chart-card' });
  card.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Last 7 days'),
    el('div', { class: 'chart-legend' },
      el('span', { class: 'chart-legend-dot chart-legend-leads' }),
      el('span', {}, `Leads (${leadsByDay.reduce((a, b) => a + b, 0)})`),
      el('span', { class: 'chart-legend-dot chart-legend-posts', style: 'margin-left:14px' }),
      el('span', {}, `Posts (${postsByDay.reduce((a, b) => a + b, 0)})`),
    ),
  ));

  // Build the SVG via string interpolation — DOM API for SVG is verbose
  // and we don't need to bind handlers per node here.
  const gridLines = [0.25, 0.5, 0.75].map((r) => {
    const y = PAD_Y + innerH * r;
    return `<line x1="${PAD_X}" y1="${y}" x2="${W - PAD_X}" y2="${y}" stroke="rgba(255,255,255,0.05)" stroke-dasharray="3,4" />`;
  }).join('');
  const xAxis = leadsByDay.map((_, i) => {
    const x = PAD_X + i * stepX;
    return `<text x="${x}" y="${H - 2}" text-anchor="middle" font-size="10" fill="#6b7280">${dayLabel(i)}</text>`;
  }).join('');
  const peakLabel = `<text x="${PAD_X - 4}" y="${PAD_Y + 4}" text-anchor="end" font-size="10" fill="#6b7280">${peak}</text>`;
  const zeroLabel = `<text x="${PAD_X - 4}" y="${PAD_Y + innerH}" text-anchor="end" font-size="10" fill="#6b7280">0</text>`;

  card.insertAdjacentHTML('beforeend', `
    <svg class="activity-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Last 7 days activity">
      ${gridLines}
      <polyline fill="rgba(124,92,255,0.10)" stroke="none"
        points="${PAD_X},${PAD_Y + innerH} ${pointsFor(leadsByDay)} ${W - PAD_X},${PAD_Y + innerH}" />
      <polyline fill="none" stroke="#7c5cff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"
        points="${pointsFor(leadsByDay)}" />
      <polyline fill="none" stroke="#22c55e" stroke-width="2" stroke-dasharray="4,3" stroke-linejoin="round" stroke-linecap="round"
        points="${pointsFor(postsByDay)}" />
      ${peakLabel}
      ${zeroLabel}
      ${xAxis}
    </svg>
  `);
  return card;
}

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
  // Map of status → column DOM nodes so drop handlers can move cards and
  // update counts without a full re-render of the board (which would lose
  // scroll position and feel laggy on slower machines).
  const cols = {};

  for (const status of LEAD_STATUSES) {
    const filtered = leads.filter(l => l.status === status);
    const countEl = el('div', { class: 'kanban-col-count' }, String(filtered.length));
    const body    = el('div', { class: 'kanban-col-body' },
      ...filtered.map(renderLeadCard),
    );
    const col = el('div', { class: 'kanban-col' },
      el('div', { class: 'kanban-col-header' },
        el('div', { class: 'kanban-col-title' }, renderBadge(status)),
        countEl,
      ),
      body,
    );
    col.dataset.status = status;
    cols[status] = { col, body, countEl };

    // Drop handlers — column-scoped. We accept the drop on the whole column
    // (not just the body) so the user can release anywhere over the column,
    // including the header and any empty space below the cards.
    col.addEventListener('dragover', (e) => {
      // Required to allow the drop. We also gate on a custom data type so
      // unrelated drags (e.g. file uploads) don't trigger highlighting.
      if (!e.dataTransfer.types.includes('application/x-hitra-lead')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('kanban-dragover');
    });
    col.addEventListener('dragleave', (e) => {
      // Only clear the highlight when the cursor actually leaves the column.
      // dragleave fires on every child boundary; relatedTarget tells us where
      // the cursor went next.
      if (e.relatedTarget && col.contains(e.relatedTarget)) return;
      col.classList.remove('kanban-dragover');
    });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('kanban-dragover');
      const leadId    = e.dataTransfer.getData('application/x-hitra-lead');
      const oldStatus = e.dataTransfer.getData('text/x-hitra-lead-status');
      if (!leadId || !oldStatus || oldStatus === status) return;

      const card = document.querySelector(`.lead-card[data-lead-id="${leadId}"]`);
      if (!card) return;

      // Optimistic move: pop the card into the new column right away so the
      // user sees the change before the API round-trips. We restore on
      // failure. updateCounts() recomputes both counts so they stay
      // consistent even if multiple drags interleave.
      const oldBody = card.parentElement;
      cols[status].body.appendChild(card);
      card.dataset.currentStatus = status;
      updateColumnCounts(cols);

      try {
        await api(`/api/leads/${leadId}`, { method: 'PUT', body: { status } });
        toast(`Moved to ${status}`, 'success');
      } catch (err) {
        toast(err.message || 'Move failed — restored', 'error');
        // Restore previous position. We append rather than splice into the
        // exact original index because the DnD lift already removed it from
        // the source list and tracking the index added complexity for
        // little user value.
        if (oldBody) oldBody.appendChild(card);
        card.dataset.currentStatus = oldStatus;
        updateColumnCounts(cols);
      }
    });

    board.appendChild(col);
  }
  root.appendChild(board);
};

// Recompute the per-column lead counts shown in the kanban headers based
// on the live DOM. Called after every successful or reverted DnD move so
// the badges match what the user sees on the board.
function updateColumnCounts(cols) {
  for (const status of Object.keys(cols)) {
    const n = cols[status].body.querySelectorAll('.lead-card').length;
    cols[status].countEl.textContent = String(n);
  }
}

function renderLeadCard(lead) {
  const card = el('div', {
    class: 'lead-card',
    draggable: 'true',
    'data-lead-id': lead.id,
    'data-current-status': lead.status,
    onclick: () => openLeadDrawer(lead.id),
  },
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

  // Drag handlers. We use a custom MIME type for the lead id so other drags
  // on the page (logo upload, future drag-and-drop file imports) don't
  // accidentally trigger a kanban move. The current status rides along so
  // drop targets can short-circuit no-op drops to the same column without
  // re-querying the DOM.
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-hitra-lead', lead.id);
    e.dataTransfer.setData('text/x-hitra-lead-status', card.dataset.currentStatus || lead.status);
    e.dataTransfer.effectAllowed = 'move';
    // Defer the dragging class so the browser captures the unblurred
    // drag image first.
    setTimeout(() => card.classList.add('lead-card-dragging'), 0);
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('lead-card-dragging');
    document.querySelectorAll('.kanban-col.kanban-dragover')
      .forEach((c) => c.classList.remove('kanban-dragover'));
  });

  return card;
}

// Source badge: icon + short label + colored chip so the origin channel
// is scannable at a glance in the kanban.
const SOURCE_META = {
  instagram_dm:     { icon: '📷', label: 'Instagram',     cls: 'src-instagram' },
  facebook_message: { icon: '👥', label: 'Facebook',      cls: 'src-facebook'  },
  linkedin:         { icon: '💼', label: 'LinkedIn',      cls: 'src-linkedin'  },
  webhook:          { icon: '🔗', label: 'Webhook',       cls: 'src-webhook'   },
  manual:           { icon: '✍',  label: 'Manual',        cls: 'src-manual'    },
  // P3 expansion — third-party intake channels share the webhook pipeline
  // but get their own chips so the user knows where each lead came from.
  tidio_livechat:   { icon: '💬', label: 'Tidio chat',    cls: 'src-tidio'     },
  tawk:             { icon: '💭', label: 'Tawk.to',       cls: 'src-tawk'      },
  crisp:            { icon: '◐',  label: 'Crisp',         cls: 'src-crisp'     },
  smartsupp:        { icon: '◓',  label: 'Smartsupp',     cls: 'src-smartsupp' },
  livechat:         { icon: '○',  label: 'LiveChat',      cls: 'src-livechat'  },
  wordpress_form:   { icon: 'W',  label: 'WordPress',     cls: 'src-wordpress' },
  email:            { icon: '✉',  label: 'Email',         cls: 'src-email'     },
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
            ['instagram',      '📷 Instagram'],
            ['linkedin',       '💼 LinkedIn'],
            ['facebook',       '👥 Facebook'],
            // P4 Phase 1: chip surfaces now so the operator can plan posts
            // for these channels. Phase 2 will wire actual publishing.
            ['tiktok',         '🎵 TikTok'],
            ['youtube_shorts', '▶ YouTube Shorts'],
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
    iconField('facebook_handle',  'Facebook',  'hitratech',  '👥'),
    iconField('tiktok_handle',    'TikTok',    '@hitratech', '🎵'),
  ));
  form.appendChild(row(
    iconField('youtube_handle',   'YouTube',   '@hitratech', '▶'),
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

  // ---- Security card (password, 2FA, email, deletion) ----
  renderSecurityCard(root, myGen);

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

  // ---- Lead capture cards (three surfaces, one shared token) ----
  //
  // The same per-org intake_token powers three different inbound channels.
  // We surface each as its own card so the user can scan to the integration
  // they want and copy the right URL/address without seeing the raw token.
  // A single rotate button lives on the generic intake card (the "primary"
  // surface) and warns that all three URLs will stop working at once.

  // Reusable reveal+copy row, used by all three cards below.
  function intakeRevealRow(labelText, value, copyToast) {
    return el('div', { class: 'intake-url-row' },
      el('label', { style: 'font-size:12px; color:var(--text-dim); font-weight:500' }, labelText),
      el('div', { class: 'intake-url-field' },
        el('code', { class: 'intake-url' }, value),
        el('button', {
          class: 'btn btn-sm', title: 'Copy',
          onclick: () => {
            navigator.clipboard.writeText(value).then(() => toast(copyToast || 'Copied', 'success'));
          },
        }, 'Copy'),
      ),
    );
  }

  // Card 1: Generic intake webhook (Typeform / Zapier / forms).
  const intakeCard = el('div', { class: 'card', style: 'margin-top:20px' });
  intakeCard.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Generic intake webhook'),
    el('div', { class: 'section-sub' },
      'POST leads from Typeform, Zapier, website forms, or any tool that can hit a URL. Every submission becomes a new lead.'),
  ));
  const intakeBody = el('div');
  intakeCard.appendChild(intakeBody);
  root.appendChild(intakeCard);

  // Card 2: Tawk.to live chat.
  const tawkCard = el('div', { class: 'card', style: 'margin-top:20px' });
  tawkCard.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Tawk.to live chat'),
    el('div', { class: 'section-sub' },
      'Free live-chat with webhook on the free tier. Paste the URL below in Tawk dashboard → Administration → Webhooks.'),
  ));
  const tawkBody = el('div');
  tawkCard.appendChild(tawkBody);
  root.appendChild(tawkCard);

  // Card 3: Email-to-Lead.
  const emailCard = el('div', { class: 'card', style: 'margin-top:20px' });
  emailCard.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Email-to-Lead'),
    el('div', { class: 'section-sub' },
      'Forward any inbound email — direct customer mails, Tidio/Crisp/Tawk notifications, WP form alerts — to this address and it lands as a lead.'),
  ));
  const emailBody = el('div');
  emailCard.appendChild(emailBody);
  root.appendChild(emailCard);

  async function loadIntake() {
    intakeBody.innerHTML = '<div class="loading"></div>';
    tawkBody.innerHTML = '<div class="loading"></div>';
    emailBody.innerHTML = '<div class="loading"></div>';
    let info;
    try { info = await api('/api/leads/intake/token'); }
    catch (e) {
      const msg = `<div class="auth-error show">${e.message}</div>`;
      intakeBody.innerHTML = msg; tawkBody.innerHTML = ''; emailBody.innerHTML = '';
      return;
    }
    if (stale(myGen)) return;

    // ---- Card 1: Generic intake webhook ----
    const curlEx = `curl -X POST ${info.url} \\\n  -H "Content-Type: application/json" \\\n  -d '{"name":"Jane Doe","email":"jane@example.com","message":"Interested in a demo"}'`;

    intakeBody.innerHTML = '';
    intakeBody.appendChild(intakeRevealRow('Your intake URL', info.url, 'Intake URL copied'));

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
          if (!confirm('Rotate your intake token?\n\nThis will invalidate ALL three URLs at once: generic intake, Tawk webhook, and your email-to-lead address. You will need to re-paste the new URLs into Tawk, Zapier, etc.')) return;
          try {
            await api('/api/leads/intake/token/rotate', { method: 'POST' });
            toast('Token rotated', 'success');
            loadIntake();
          } catch (e) { toast(e.message, 'error'); }
        },
      }, 'Rotate token'),
    ));

    // ---- Card 2: Tawk.to webhook URL ----
    tawkBody.innerHTML = '';
    tawkBody.appendChild(intakeRevealRow('Tawk webhook URL', info.tawkUrl, 'Tawk URL copied'));

    tawkBody.appendChild(el('details', { class: 'intake-details', style: 'margin-top:14px' },
      el('summary', {}, 'Connect Tawk in 5 minutes'),
      el('div', { style: 'font-size:13px; color:var(--text-dim); padding:8px 4px; line-height:1.8' },
        el('div', {}, '1. Tawk.to dashboard → ⚙ Administration'),
        el('div', {}, '2. Channels → Chat Widget → install on your site'),
        el('div', {}, '3. Administration → Webhooks → + Add Webhook'),
        el('div', {}, '4. Paste the URL above as Endpoint URL'),
        el('div', {}, '5. Tick events: Chat Start, Chat Transcript, New Ticket'),
        el('div', {}, '6. Save → copy Tawk\'s Secret Key → set TAWK_WEBHOOK_SECRET on your server'),
        el('div', { style: 'margin-top:6px; color:var(--text-mute); font-size:12px' },
          'Anonymous chats (no name/email/phone) are silently dropped so the kanban stays clean.'),
      ),
    ));

    // ---- Card 3: Email-to-Lead address ----
    emailBody.innerHTML = '';
    if (!info.emailAddress) {
      // Operator hasn't set EMAIL_INBOUND_DOMAIN — surface the gap rather
      // than render a half-broken address.
      emailBody.appendChild(el('div', {
        style: 'padding:14px; background:var(--surface-2); border:1px dashed var(--border-soft); border-radius:8px; color:var(--text-dim); font-size:13px; line-height:1.6',
      },
        el('strong', { style: 'color:var(--text)' }, 'Email-to-Lead is not configured on this server.'),
        el('div', { style: 'margin-top:6px' },
          'Set EMAIL_INBOUND_DOMAIN in the server .env (e.g. leads.hitrapost.co.uk), point an MX record at your inbound provider (SendGrid Inbound Parse / Mailgun Routes), and restart.'),
      ));
    } else {
      emailBody.appendChild(intakeRevealRow('Your forwarding address', info.emailAddress, 'Address copied'));

      emailBody.appendChild(el('details', { class: 'intake-details', style: 'margin-top:14px', open: false },
        el('summary', {}, 'How to use it'),
        el('div', { style: 'font-size:13px; color:var(--text-dim); padding:8px 4px; line-height:1.8' },
          el('div', { style: 'margin-bottom:6px' },
            el('strong', { style: 'color:var(--text)' }, 'Direct customer mail: '),
            'in Gmail/Outlook, set a forwarding rule on your business inbox (e.g. info@yourdomain.com) → forward all to the address above.'),
          el('div', { style: 'margin-bottom:6px' },
            el('strong', { style: 'color:var(--text)' }, 'Tidio (free tier): '),
            'Tidio sends a "new conversation" email — forward that notification email to the address above. Lands as Tidio chat lead.'),
          el('div', { style: 'margin-bottom:6px' },
            el('strong', { style: 'color:var(--text)' }, 'WordPress forms: '),
            'CF7 / WPForms / Elementor / Gravity / Ninja all email the site owner. Forward those to the address above for an auto-tagged WordPress chip.'),
          el('div', { style: 'margin-top:8px; color:var(--text-mute); font-size:12px' },
            'Sender domain decides the chip: Tidio / Tawk / Crisp / Smartsupp / LiveChat / WordPress. Generic mail gets the Email chip.'),
        ),
      ));
    }
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

  // Brand logo SVG paths (24x24 viewBox) — sourced from simple-icons.org
  // (MIT licensed, brand-permitted use for indicating platform support).
  // Wrapping each in our own <span class="conn-icon platform-X"> lets us
  // brand-tint the background + logo color from CSS without touching
  // the SVG markup. Tiny enough to keep inline rather than ship 5
  // separate icon assets.
  const PLATFORM_ICON_PATHS = {
    instagram: 'M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.897 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.897-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z',
    facebook:  'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z',
    linkedin:  'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.063 2.063 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
    tiktok:    'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
    youtube:   'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  };
  function renderPlatformIcon(key) {
    const path = PLATFORM_ICON_PATHS[key];
    if (!path) return el('span', { class: 'conn-icon' }, '○');
    const wrap = el('span', { class: `conn-icon platform-${key}` });
    // innerHTML rather than the el() builder because SVG namespacing
    // through document.createElement gets messy and these paths are
    // hard-coded constants (not user input).
    wrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
    return wrap;
  }

  async function loadConnections() {
    connBody.innerHTML = '<div class="loading"></div>';
    let creds = [];
    try { creds = await api('/api/connect'); } catch (e) { toast(e.message, 'error'); }
    if (stale(myGen)) return;
    connBody.innerHTML = '';

    // Group by platform for tidy display
    const byPlatform = { facebook: [], instagram: [], linkedin: [], tiktok: [], youtube: [] };
    for (const c of creds) if (byPlatform[c.platform]) byPlatform[c.platform].push(c);

    const platforms = [
      { key: 'instagram', label: 'Instagram', icon: '📷', provider: 'meta',
        desc: 'Post images and captions to your IG Business account. Requires an IG account linked to a Facebook page.' },
      { key: 'facebook',  label: 'Facebook Page', icon: '👥', provider: 'meta',
        desc: 'Publish to Facebook pages you admin.' },
      { key: 'linkedin',  label: 'LinkedIn', icon: '💼', provider: 'linkedin',
        desc: 'Post to your personal LinkedIn feed on your behalf.' },
      // P4 Phase 2: TikTok OAuth (Login Kit) is wired. Sandbox app under
      // Hitratech Solutions Ltd; videos publish in Inbox mode (drafts) until
      // production audit clears `video.publish` for Direct Post.
      { key: 'tiktok',    label: 'TikTok',   icon: '🎵', provider: 'tiktok',
        desc: 'Generate AI vertical short videos and push them as drafts to your TikTok account. Production Direct Post arrives after TikTok audit.' },
      // P4 Phase 2: YouTube OAuth wired (Google Cloud Hitrapost project,
      // Testing mode). Shorts upload via YouTube Data API v3 (videos.insert
      // resumable). Default quota = 10K units/day = ~6 uploads/day; quota
      // increase request lands once we have real customer volume.
      { key: 'youtube',   label: 'YouTube Shorts', icon: '▶', provider: 'youtube',
        desc: 'Upload AI-generated vertical Shorts directly to your YouTube channel. Default quota covers ~6 uploads/day until we request an increase.' },
    ];

    for (const p of platforms) {
      const accts = byPlatform[p.key] || [];
      const tile = el('div', { class: 'conn-tile' });

      const headRight = p.comingSoon
        ? el('span', { class: 'conn-soon-badge', title: 'Wired in P4 Phase 2 — needs developer credentials' }, 'Coming soon')
        : el('button', {
            class: 'btn btn-primary btn-sm',
            onclick: async () => {
              try {
                const r = await api(`/api/connect/${p.provider}/start`);
                window.location.href = r.url;
              } catch (err) { toast(err.message, 'error'); }
            },
          }, accts.length ? '+ Add another' : 'Connect');

      tile.appendChild(el('div', { class: 'conn-head' },
        renderPlatformIcon(p.key),
        el('div', { style: 'flex:1' },
          el('div', { class: 'conn-title' }, p.label),
          el('div', { class: 'conn-desc' }, p.desc),
        ),
        headRight,
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
  // The access token is short-lived for most providers (Google = 1h,
  // TikTok = 24h, LinkedIn = 60d, Meta = 60d). What matters for the UI
  // is when the *connection* dies — that's the refresh-token lifetime.
  // Google refresh tokens don't expire on a fixed clock, so we treat
  // null refresh_expires_at as "indefinite, just show Active". For
  // providers with a finite refresh lifetime (TikTok 365d, LinkedIn 1y)
  // we show the real countdown so the operator knows when reconnect
  // is needed. has_refresh_token is set by social-credentials.presentSafe
  // and tells us whether to ignore the access-token clock entirely.
  const effectiveExpiry = a.refresh_expires_at
    || (a.has_refresh_token ? null : a.expires_at);
  const daysLeft = effectiveExpiry
    ? Math.floor((new Date(effectiveExpiry).getTime() - Date.now()) / 86400000)
    : null;
  const statusClass = a.status === 'active'
    ? (daysLeft !== null && daysLeft < 7 ? 'warn' : 'good')
    : (a.status === 'expired' || a.status === 'needs_reauth' ? 'bad' : 'warn');

  // Meta avatar URLs (graph.facebook.com/.../picture) frequently 401 from
  // a different origin or come back as expired signed URLs from the IG
  // Graph API. Render the initial-letter fallback if the image fails to
  // load so the row never shows a broken-image icon.
  const initial = (a.account_name || a.account_handle || '?').replace(/^@/, '')[0].toUpperCase();
  function makeAvatar() {
    if (!a.account_avatar_url) {
      return el('div', { class: 'conn-avatar conn-avatar-fallback' }, initial);
    }
    const img = el('img', {
      src: a.account_avatar_url,
      alt: '',
      class: 'conn-avatar',
      // referrerpolicy=no-referrer keeps FB/IG from rejecting the request
      // because of cross-origin referrer header checks. Doesn't help if
      // the URL has truly expired but eliminates the most common failure.
      referrerpolicy: 'no-referrer',
    });
    img.onerror = () => {
      const fb = el('div', { class: 'conn-avatar conn-avatar-fallback' }, initial);
      img.replaceWith(fb);
    };
    return img;
  }

  return el('div', { class: 'conn-account' },
    makeAvatar(),
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
//   EMAIL VERIFICATION BANNER
// =======================================================================
// Persistent top-of-app banner shown until the user clicks the verify link.
// AI routes 403 with code='email_unverified' for unverified users; this
// banner is the user's hint that the gate exists. "Resend" calls the new
// /api/auth/verify-email/resend endpoint.
function renderVerifyBanner() {
  const existing = document.getElementById('verify-email-banner');
  if (State.user?.emailVerified) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return; // already shown
  if (!State.user) return;

  const main = document.querySelector('.main');
  if (!main) return;

  const banner = el('div', { id: 'verify-email-banner', class: 'verify-banner' },
    el('span', {},
      'Verify your email to unlock AI generation. We sent a link to ',
      el('strong', {}, State.user.email),
      '.'),
    el('button', {
      class: 'btn btn-sm',
      onclick: async (ev) => {
        ev.target.disabled = true;
        try {
          const out = await api('/api/auth/verify-email/resend', { method: 'POST' });
          if (out.alreadyVerified) {
            toast('Email already verified.', 'success');
            State.user.emailVerified = true;
            renderVerifyBanner();
          } else {
            toast('Verification email sent.', 'success');
          }
        } catch (e) {
          toast(e.message, 'error');
          ev.target.disabled = false;
        }
      },
    }, 'Resend'),
  );
  main.insertBefore(banner, main.firstChild);
}

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

// =======================================================================
//   P2 — Auth UI (2FA challenge + enrollment, password reset, email change,
//                 account deletion)
// =======================================================================

// ---- Login: 2FA challenge form ------------------------------------------
// Replaces the login form on the auth screen with a 6-digit code prompt.
// Backend returns { step: '2fa' } on first login if TOTP is on; the second
// call goes to /login/2fa with the code (or a backup code).
function showTwoFactorChallenge() {
  const wrap = $('.auth-card');
  if (!wrap) return;

  // Hide login + register forms and the tab strip — there's only one path
  // forward at this point.
  $$('.auth-tabs .tab').forEach(t => t.classList.add('hidden'));
  $('#login-form').classList.add('hidden');
  $('#register-form').classList.add('hidden');

  const existing = $('#twofa-form');
  if (existing) { existing.classList.remove('hidden'); existing.querySelector('input').focus(); return; }

  const form = el('form', { id: 'twofa-form', class: 'auth-form' },
    el('div', { class: 'auth-form-lede', style: 'font-size:13px; color:var(--text-dim); line-height:1.5; margin-bottom:6px' },
      'Enter the 6-digit code from your authenticator app, or one of your backup codes.'),
    el('label', {}, 'Code',
      el('input', {
        type: 'text', name: 'code', required: true,
        autocomplete: 'one-time-code', inputmode: 'numeric',
        placeholder: '123456 or backup code',
      }),
    ),
    el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Verify'),
    el('div', { class: 'auth-error', id: 'twofa-error' }),
    el('div', { style: 'text-align:center; margin-top:14px' },
      el('a', {
        href: '#',
        style: 'color:var(--text-dim); font-size:12px',
        onclick: (ev) => { ev.preventDefault(); cancelTwoFactorChallenge(); },
      }, '← Back to login'),
    ),
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#twofa-error');
    err.classList.remove('show');
    const code = String(new FormData(e.target).get('code') || '').trim();
    try {
      const user = await api('/api/auth/login/2fa', { method: 'POST', body: { code } });
      State.user = user;
      await bootApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.add('show');
    }
  };
  wrap.appendChild(form);
  setTimeout(() => form.querySelector('input').focus(), 0);
}

function cancelTwoFactorChallenge() {
  // POST a logout to clear the pending2fa side of the session, then put the
  // login form back. Best-effort — failure here just falls back to the next
  // login attempt clearing the pending state.
  api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  $$('.auth-tabs .tab').forEach(t => t.classList.remove('hidden'));
  $('#login-form').classList.remove('hidden');
  $('#twofa-form')?.remove();
}

// ---- "Forgot password?" link + request form -----------------------------
function wireForgotPasswordLink() {
  // Inject once below the password field.
  if ($('#forgot-link')) return;
  const loginForm = $('#login-form');
  if (!loginForm) return;
  const link = el('a', {
    id: 'forgot-link',
    href: '#',
    class: 'forgot-link',
    onclick: (ev) => { ev.preventDefault(); showForgotPasswordForm(); },
  }, 'Forgot your password?');
  // Insert before the submit button.
  const submit = loginForm.querySelector('button[type="submit"]');
  if (submit) loginForm.insertBefore(link, submit);
}

function showForgotPasswordForm() {
  const wrap = $('.auth-card');
  if (!wrap) return;
  $$('.auth-tabs .tab').forEach(t => t.classList.add('hidden'));
  $('#login-form').classList.add('hidden');
  $('#register-form').classList.add('hidden');
  $('#forgot-form')?.remove();
  const form = el('form', { id: 'forgot-form', class: 'auth-form' },
    el('div', { class: 'auth-form-lede', style: 'font-size:13px; color:var(--text-dim); line-height:1.5; margin-bottom:6px' },
      "Enter your account email. If it matches an account we'll send a reset link."),
    el('label', {}, 'Email',
      el('input', { type: 'email', name: 'email', required: true, placeholder: 'you@company.com', autocomplete: 'email' }),
    ),
    el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Send reset link'),
    el('div', { class: 'auth-error', id: 'forgot-error' }),
    el('div', { style: 'text-align:center; margin-top:14px' },
      el('a', {
        href: '#', style: 'color:var(--text-dim); font-size:12px',
        onclick: (ev) => { ev.preventDefault(); restoreLoginForm(); },
      }, '← Back to login'),
    ),
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#forgot-error');
    err.classList.remove('show');
    const email = String(new FormData(e.target).get('email') || '').trim();
    try {
      await api('/api/auth/password/request-reset', { method: 'POST', body: { email } });
      form.innerHTML = '';
      form.appendChild(el('div', { class: 'auth-form-lede', style: 'color:var(--text); line-height:1.6' },
        "If that email matches an account, we've sent a reset link. Check your inbox (and spam) — the link expires in 60 minutes."));
      form.appendChild(el('div', { style: 'text-align:center; margin-top:14px' },
        el('a', {
          href: '#', style: 'color:var(--text-dim); font-size:12px',
          onclick: (ev) => { ev.preventDefault(); restoreLoginForm(); },
        }, '← Back to login'),
      ));
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.add('show');
    }
  };
  wrap.appendChild(form);
}

function showPasswordResetForm(token) {
  // Show the auth screen even if we'd normally be on the dashboard.
  renderAuthScreen();
  const wrap = $('.auth-card');
  if (!wrap) return;
  $$('.auth-tabs .tab').forEach(t => t.classList.add('hidden'));
  $('#login-form').classList.add('hidden');
  $('#register-form').classList.add('hidden');
  $('#reset-form')?.remove();

  const form = el('form', { id: 'reset-form', class: 'auth-form' },
    el('div', { class: 'auth-form-lede', style: 'font-size:13px; color:var(--text-dim); margin-bottom:6px' },
      'Pick a new password. At least 8 characters.'),
    el('label', {}, 'New password',
      el('input', { type: 'password', name: 'password', required: true, minlength: 8,
        placeholder: 'New password', autocomplete: 'new-password' }),
    ),
    el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Reset password'),
    el('div', { class: 'auth-error', id: 'reset-error' }),
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#reset-error');
    err.classList.remove('show');
    const password = String(new FormData(e.target).get('password') || '');
    try {
      await api('/api/auth/password/reset', { method: 'POST', body: { token, password } });
      toast('Password updated. Please sign in.', 'success');
      history.replaceState(null, '', location.pathname);
      restoreLoginForm();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.add('show');
    }
  };
  wrap.appendChild(form);
}

function restoreLoginForm() {
  $$('.auth-tabs .tab').forEach(t => t.classList.remove('hidden'));
  $('#forgot-form')?.remove();
  $('#reset-form')?.remove();
  $('#twofa-form')?.remove();
  $('#login-form').classList.remove('hidden');
  $('#register-form').classList.add('hidden');
  // Make sure the login tab is selected.
  const loginTab = $$('.auth-tabs .tab').find(t => t.dataset.tab === 'login');
  if (loginTab) {
    $$('.auth-tabs .tab').forEach(b => b.classList.toggle('active', b === loginTab));
  }
}

// ---- Settings → Security card -------------------------------------------
// Mounted from VIEWS.settings (see renderSecurityCard call). Covers:
//   * Change password (authed)
//   * 2FA enrollment (QR modal → activate → backup codes screen)
//   * Disable 2FA (with current code)
//   * Email change (current password + new email; confirms via new inbox)
//   * Account deletion (current password + confirm; soft-delete + 30d)
async function renderSecurityCard(parent, myGen) {
  const card = el('div', { class: 'card', style: 'margin-top:20px' });
  card.appendChild(el('div', { class: 'section-header' },
    el('h2', {}, 'Security'),
    el('div', { class: 'section-sub' }, 'Password, two-factor, email, and account deletion.'),
  ));
  parent.appendChild(card);

  // Refetch /me so we know the live 2FA state (auth.routes returns it).
  let me;
  try { me = await api('/api/auth/me'); } catch { me = State.user; }
  if (stale(myGen)) return;

  // --- Change password ---
  const pwBlock = el('div', { class: 'security-block' },
    el('h3', {}, 'Change password'),
  );
  const pwForm = el('form', { class: 'inline-form' },
    el('label', {}, 'Current password',
      el('input', { type: 'password', name: 'current', required: true, autocomplete: 'current-password' })),
    el('label', {}, 'New password',
      el('input', { type: 'password', name: 'next', required: true, minlength: 8, autocomplete: 'new-password' })),
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Update password'),
  );
  pwForm.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/auth/password/change', { method: 'POST', body: {
        currentPassword: String(fd.get('current') || ''),
        newPassword:     String(fd.get('next') || ''),
      }});
      toast('Password updated.', 'success');
      pwForm.reset();
    } catch (ex) { toast(ex.message, 'error'); }
  };
  pwBlock.appendChild(pwForm);
  card.appendChild(pwBlock);

  // --- 2FA ---
  const twoFaBlock = el('div', { class: 'security-block' },
    el('h3', {}, 'Two-factor authentication'),
    el('p', { class: 'security-sub' },
      me.twoFactorEnabled
        ? 'On — you\'ll be asked for a code on every new login.'
        : 'Off — protect your account with an authenticator app.'),
  );
  if (me.twoFactorEnabled) {
    twoFaBlock.appendChild(el('button', {
      class: 'btn btn-danger btn-sm',
      onclick: () => openDisable2FAModal(),
    }, 'Disable 2FA'));
  } else {
    twoFaBlock.appendChild(el('button', {
      class: 'btn btn-primary btn-sm',
      onclick: () => open2FASetupModal(),
    }, 'Set up 2FA'));
  }
  card.appendChild(twoFaBlock);

  // --- Email change ---
  const emailBlock = el('div', { class: 'security-block' },
    el('h3', {}, 'Change email'),
    el('p', { class: 'security-sub' },
      'We\'ll send a confirmation link to the new address. Until you click it, your current email keeps working.'),
  );
  const emailForm = el('form', { class: 'inline-form' },
    el('label', {}, 'New email',
      el('input', { type: 'email', name: 'newEmail', required: true, autocomplete: 'email' })),
    el('label', {}, 'Current password',
      el('input', { type: 'password', name: 'pw', required: true, autocomplete: 'current-password' })),
    el('button', { type: 'submit', class: 'btn' }, 'Send confirmation'),
  );
  emailForm.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const out = await api('/api/auth/email/change-request', { method: 'POST', body: {
        newEmail:        String(fd.get('newEmail') || ''),
        currentPassword: String(fd.get('pw') || ''),
      }});
      toast(`Confirmation sent to ${out.sentTo}.`, 'success', 6000);
      emailForm.reset();
    } catch (ex) { toast(ex.message, 'error'); }
  };
  emailBlock.appendChild(emailForm);
  card.appendChild(emailBlock);

  // --- Delete account ---
  const dangerBlock = el('div', { class: 'security-block security-block-danger' },
    el('h3', {}, 'Delete account'),
    el('p', { class: 'security-sub' },
      'Soft-deletes your account. You have 30 days to email support to restore it; after that all your data — posts, leads, connected socials — is permanently removed.'),
    el('button', {
      class: 'btn btn-danger btn-sm',
      onclick: () => openDeleteAccountModal(),
    }, 'Delete my account'),
  );
  card.appendChild(dangerBlock);
}

// ---- 2FA enrollment modal -----------------------------------------------
async function open2FASetupModal() {
  if (document.getElementById('twofa-setup-modal')) return;
  const backdrop = el('div', { class: 'modal-backdrop', id: 'twofa-setup-modal' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const card = el('div', { class: 'modal-card' });
  card.appendChild(el('button', { class: 'modal-close', onclick: close, title: 'Close' }, '✕'));
  card.appendChild(el('h2', {}, 'Set up two-factor authentication'));
  card.appendChild(el('p', { class: 'upgrade-lede' },
    'Scan the QR code with Google Authenticator, 1Password, Authy, or any TOTP app. Then enter the 6-digit code it shows to activate.'));
  const body = el('div', {});
  card.appendChild(body);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  body.innerHTML = '<div class="loading"></div>';
  let setup;
  try {
    setup = await api('/api/auth/2fa/setup', { method: 'POST' });
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'auth-error show' }, e.message));
    return;
  }

  body.innerHTML = '';
  body.appendChild(el('div', { class: 'twofa-qr' },
    el('img', { src: setup.qrDataUrl, alt: '2FA QR code' }),
  ));
  body.appendChild(el('details', { class: 'twofa-secret-details' },
    el('summary', {}, "Can't scan? Enter this code manually"),
    el('code', { class: 'twofa-secret' }, setup.secret),
  ));

  const form = el('form', { class: 'inline-form', style: 'margin-top:20px' },
    el('label', {}, 'Code from your app',
      el('input', { type: 'text', name: 'code', required: true,
        autocomplete: 'one-time-code', inputmode: 'numeric', placeholder: '123456' })),
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Activate 2FA'),
  );
  const err = el('div', { class: 'auth-error' });
  body.appendChild(form);
  body.appendChild(err);

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    err.classList.remove('show');
    const code = String(new FormData(ev.target).get('code') || '').trim();
    try {
      const out = await api('/api/auth/2fa/activate', { method: 'POST', body: { code } });
      close();
      showBackupCodesModal(out.backupCodes);
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.add('show');
    }
  };
}

// ---- Backup codes screen (one-shot) -------------------------------------
function showBackupCodesModal(codes) {
  const backdrop = el('div', { class: 'modal-backdrop', id: 'backup-codes-modal' });
  // No outside-click dismiss — the user MUST acknowledge before closing.
  const card = el('div', { class: 'modal-card' });
  card.appendChild(el('h2', {}, 'Save your backup codes'));
  card.appendChild(el('p', { class: 'upgrade-lede' },
    "Each code works once. Use them when you don't have your authenticator. Treat them like a password — store in a password manager. We'll never show them again."));

  const grid = el('div', { class: 'backup-code-grid' },
    ...codes.map(c => el('code', {}, c)),
  );
  card.appendChild(grid);

  const actions = el('div', { class: 'upgrade-actions' });
  actions.appendChild(el('button', {
    class: 'btn',
    onclick: () => {
      navigator.clipboard.writeText(codes.join('\n')).then(() => toast('Copied to clipboard', 'success'));
    },
  }, 'Copy all'));
  actions.appendChild(el('button', {
    class: 'btn',
    onclick: () => {
      const blob = new Blob([codes.join('\n')], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'hitrapost-backup-codes.txt';
      a.click();
      URL.revokeObjectURL(a.href);
    },
  }, 'Download .txt'));

  // The acknowledgement gate. Only enables the dismiss button when ticked.
  const ack = el('label', { class: 'security-ack' },
    el('input', { type: 'checkbox' }),
    el('span', {}, "I've saved these somewhere safe."),
  );
  const dismiss = el('button', { class: 'btn btn-primary', disabled: true,
    onclick: () => {
      backdrop.remove();
      toast('2FA enabled. Next login will ask for a code.', 'success');
      // Re-render security card so the toggle flips.
      if (State.route === 'settings') navigate('settings', { replace: true });
    },
  }, 'I saved them, continue');
  ack.querySelector('input').addEventListener('change', (e) => {
    dismiss.disabled = !e.target.checked;
  });

  actions.appendChild(dismiss);
  card.appendChild(ack);
  card.appendChild(actions);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
}

// ---- Disable 2FA modal --------------------------------------------------
function openDisable2FAModal() {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  const form = el('form', { class: 'inline-form' },
    el('label', {}, 'Current 2FA code (or backup code)',
      el('input', { type: 'text', name: 'code', required: true,
        autocomplete: 'one-time-code', placeholder: '123456' })),
    el('div', { class: 'upgrade-actions' },
      el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Cancel'),
      el('button', { type: 'submit', class: 'btn btn-danger' }, 'Disable 2FA'),
    ),
  );
  const err = el('div', { class: 'auth-error' });
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.classList.remove('show');
    const code = String(new FormData(e.target).get('code') || '').trim();
    try {
      await api('/api/auth/2fa/disable', { method: 'POST', body: { code } });
      close();
      toast('2FA disabled.', 'info');
      if (State.route === 'settings') navigate('settings', { replace: true });
    } catch (ex) {
      err.textContent = ex.message; err.classList.add('show');
    }
  };

  const card = el('div', { class: 'modal-card' });
  card.appendChild(el('button', { class: 'modal-close', onclick: close, title: 'Close' }, '✕'));
  card.appendChild(el('h2', {}, 'Disable two-factor authentication'));
  card.appendChild(el('p', { class: 'upgrade-lede' },
    'You\'ll lose the second factor on your account. Anyone with your password will be able to sign in.'));
  card.appendChild(form);
  card.appendChild(err);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
}

// ---- Account deletion modal ---------------------------------------------
function openDeleteAccountModal() {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  const form = el('form', { class: 'inline-form' },
    el('label', {}, 'Type DELETE to confirm',
      el('input', { type: 'text', name: 'confirm', required: true, autocomplete: 'off', placeholder: 'DELETE' })),
    el('label', {}, 'Current password',
      el('input', { type: 'password', name: 'pw', required: true, autocomplete: 'current-password' })),
    el('div', { class: 'upgrade-actions' },
      el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Cancel'),
      el('button', { type: 'submit', class: 'btn btn-danger' }, 'Delete my account'),
    ),
  );
  const err = el('div', { class: 'auth-error' });
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.classList.remove('show');
    const fd = new FormData(e.target);
    if (String(fd.get('confirm') || '') !== 'DELETE') {
      err.textContent = 'Type DELETE exactly to confirm.';
      err.classList.add('show');
      return;
    }
    try {
      await api('/api/auth/account/delete', { method: 'POST', body: {
        currentPassword: String(fd.get('pw') || ''),
      }});
      close();
      State.user = null;
      toast('Account scheduled for deletion. Email support@hitrapost.co.uk within 30 days to restore.', 'info', 8000);
      renderAuthScreen();
    } catch (ex) {
      err.textContent = ex.message; err.classList.add('show');
    }
  };

  const card = el('div', { class: 'modal-card' });
  card.appendChild(el('button', { class: 'modal-close', onclick: close, title: 'Close' }, '✕'));
  card.appendChild(el('h2', {}, 'Delete your account?'));
  card.appendChild(el('p', { class: 'upgrade-lede' },
    'You\'ll be signed out immediately. We keep your data for 30 days in case you change your mind — after that everything is permanently removed.'));
  card.appendChild(form);
  card.appendChild(err);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
}

(async function main() {
  const ok = await loadSession();
  if (ok) await bootApp();
  else renderAuthScreen();
})();
