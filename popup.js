const COLOR_HEX = {
  blue: "#5a9aed", turquoise: "#1dd1c3", green: "#5cb85c", yellow: "#e0c341",
  orange: "#e08a3d", red: "#e05a5a", pink: "#e06ab0", purple: "#9966cc", toolbar: "#9a9a9e"
};

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  open: `<svg ${SVG_ATTRS}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  close: `<svg ${SVG_ATTRS}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  chevron: `<svg ${SVG_ATTRS}><polyline points="9 18 15 12 9 6"/></svg>`,
  edit: `<svg ${SVG_ATTRS}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`
};

const COLORS = Object.keys(COLOR_HEX).filter((c) => c !== "toolbar");

const STYLE = "background:#5b5bd6;color:#fff;padding:2px 6px;border-radius:4px;font-weight:bold;";
const log = (...args) => console.log("%c[Idently][popup]", STYLE, ...args);

// Only http(s) pages can host a session. Anything else — about:*, file:,
// view-source:, and in particular the extension's own pages (the options
// tab, the rule builder window) — has to be rejected explicitly: a URL like
// "moz-extension://<uuid>/options.html" parses just fine and yields a
// non-empty host (the uuid), so a bare `new URL(...).host` check passes it
// through and we end up opening moz-extension://<uuid>/ — the extension's
// raw file listing — in a brand new tab.
function webPageParts(tabUrl) {
  try {
    const u = new URL(tabUrl || "");
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.host) return null;
    return { domain: u.host, origin: u.origin };
  } catch {
    return null;
  }
}

let identities = {};
let currentResults = [];
let selectedIndex = -1;
let expandedGroups = new Set();
let sessionHealth = {};
let activeTab = null;
let editingSessionId = null;
let editColor = null;

init();

async function init() {
  await loadIdentities();
  renderGroups();

  browser.runtime.sendMessage({ action: "sessionHealth" })
    .then((health) => {
      sessionHealth = health || {};
      rerenderActiveView();
    })
    .catch(() => {});

  // The autofocus attribute alone is unreliable in extension popups.
  setTimeout(() => document.getElementById("searchInput").focus(), 0);

  document.getElementById("searchInput").addEventListener("input", onSearch);
  document.getElementById("searchInput").addEventListener("keydown", onSearchKeydown);

  document.getElementById("sessionEditCloseBtn").addEventListener("click", closeSessionEdit);
  document.getElementById("seCancelBtn").addEventListener("click", closeSessionEdit);
  document.getElementById("seSaveBtn").addEventListener("click", saveSessionEdit);

  // Housekeeping: clear out abandoned "+ New session tab" clicks that were
  // never named, except whichever tab is currently active (never yank a
  // tab out from under the user while they're looking at it).
  [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  setupNewSessionButton(activeTab);
  setupMoreMenu();
  browser.runtime.sendMessage({ action: "cleanupUnnamed", excludeCookieStoreId: activeTab?.cookieStoreId })
    .then(async (result) => {
      if (result?.removed) {
        await loadIdentities();
        renderGroups();
      }
    })
    .catch(() => {});
}

function setupNewSessionButton(activeTab) {
  const btn = document.getElementById("newSessionBtn");
  const parts = webPageParts(activeTab?.url);
  const domain = parts?.domain || "", origin = parts?.origin || "";

  if (!domain) {
    // A disabled button with no explanation reads as a broken one, so say
    // what's missing. Sessions are always created for the active tab's site,
    // and the active tab here isn't a site (new tab, Settings, about:*, ...).
    const reason = "Open a site in this tab first, then start a session.";
    btn.disabled = true;
    btn.title = reason;
    const hint = document.getElementById("newSessionHint");
    hint.textContent = reason;
    hint.classList.remove("hidden");
    return;
  }

  btn.addEventListener("click", async () => {
    await browser.runtime.sendMessage({ action: "createNewIdentity", domain, origin });
    window.close();
  });
}

async function loadIdentities() {
  const stored = await browser.storage.local.get("identities");
  identities = stored.identities || {};
}

function byRecency(a, b) {
  return (b[1].lastUsedAt || b[1].createdAt || 0) - (a[1].lastUsedAt || a[1].createdAt || 0);
}

function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function rerenderActiveView() {
  if (document.getElementById("searchInput").value.trim()) {
    onSearch();
    return;
  }
  // onSearch() un-hides groupsView itself when the query is empty, but
  // renderGroups() alone only repopulates the list — it never touches the
  // hidden class. Callers that just closed another view (e.g. the session
  // edit panel, which hides groupsView while it's open) need it explicitly
  // shown again, or the list silently stays invisible until the popup is
  // reopened from scratch.
  document.getElementById("groupsView").classList.remove("hidden");
  document.getElementById("searchView").classList.add("hidden");
  renderGroups();
}

function confirmedByDomain() {
  const byDomain = new Map();
  for (const [id, data] of Object.entries(identities)) {
    if (!data.confirmed) continue;
    if (!byDomain.has(data.domain)) byDomain.set(data.domain, []);
    byDomain.get(data.domain).push([id, data]);
  }
  for (const rows of byDomain.values()) rows.sort(byRecency);
  return byDomain;
}

// How many recents to show, and the point at which showing them is worth the
// space: below this the groups list is short enough to scan whole, and a
// recents list would just repeat it back.
const RECENT_COUNT = 5;
const RECENT_MIN_SESSIONS = 6;

function renderRecent() {
  const section = document.getElementById("recentSection");
  const listEl = document.getElementById("recentList");
  listEl.innerHTML = "";

  const confirmed = Object.entries(identities).filter(([, data]) => data.confirmed);
  if (confirmed.length < RECENT_MIN_SESSIONS) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");

  for (const [id, data] of confirmed.sort(byRecency).slice(0, RECENT_COUNT)) {
    // Domains are mixed in here, so each row says which site it belongs to.
    listEl.appendChild(buildIdentityRow(id, data, true));
  }
}

function renderGroups() {
  renderRecent();
  const listEl = document.getElementById("groupsList");
  const emptyEl = document.getElementById("groupsEmpty");
  listEl.innerHTML = "";

  const byDomain = confirmedByDomain();
  if (byDomain.size === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  // Domains ordered by their most recently used session.
  const domainsByRecency = [...byDomain.entries()].sort((a, b) => byRecency(a[1][0], b[1][0]));
  for (const [domain, rows] of domainsByRecency) {
    listEl.appendChild(buildGroup(domain, rows));
  }
}

// Height can't transition to or from `auto`, so both directions go via the
// measured pixel height: expanding animates 0 -> Npx then releases to auto
// (so the group still grows if a session is added while it's open), and
// collapsing pins Npx for a frame before animating down to 0.
function animateGroupHeight(wrap, expanding) {
  const target = wrap.scrollHeight;
  clearTimeout(wrap._heightTimer);
  if (expanding) {
    wrap.style.height = target + "px";
    wrap._heightTimer = setTimeout(() => {
      if (wrap.parentElement?.classList.contains("expanded")) wrap.style.height = "auto";
    }, 240);
  } else {
    wrap.style.height = target + "px";
    requestAnimationFrame(() => requestAnimationFrame(() => { wrap.style.height = "0px"; }));
  }
}

function buildGroup(domain, rows) {
  const group = document.createElement("div");
  group.className = "group" + (expandedGroups.has(domain) ? " expanded" : "");

  const header = document.createElement("div");
  header.className = "group-header";
  const chevron = document.createElement("span");
  chevron.className = "group-chevron";
  chevron.innerHTML = ICONS.chevron;
  const name = document.createElement("div");
  name.className = "group-name";
  name.textContent = domain;
  const dots = document.createElement("span");
  dots.className = "group-dots";
  for (const [, data] of rows.slice(0, 4)) {
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = COLOR_HEX[data.color] || COLOR_HEX.toolbar;
    dots.appendChild(dot);
  }
  const count = document.createElement("div");
  count.className = "group-count";
  count.textContent = rows.length;
  header.append(chevron, name, dots, count);
  header.addEventListener("click", () => {
    const expanding = !expandedGroups.has(domain);
    if (expanding) expandedGroups.add(domain);
    else expandedGroups.delete(domain);
    group.classList.toggle("expanded", expanding);
    animateGroupHeight(childrenWrap, expanding);
  });

  const childrenWrap = document.createElement("div");
  childrenWrap.className = "group-children-wrap";
  const childrenInner = document.createElement("div");
  childrenInner.className = "group-children-inner";
  const list = document.createElement("div");
  list.className = "rows";

  for (const [id, data] of rows) {
    list.appendChild(buildIdentityRow(id, data, false));
  }

  childrenInner.appendChild(list);
  childrenWrap.appendChild(childrenInner);
  // A group that was already open when this list was rebuilt opens at its
  // natural height with no animation — only a click should animate.
  childrenWrap.style.height = expandedGroups.has(domain) ? "auto" : "0px";
  group.append(header, childrenWrap);
  return group;
}

function buildIdentityRow(id, data, showDomain, selected) {
  const row = document.createElement("div");
  row.className = "identity-row" + (selected ? " selected" : "");

  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = COLOR_HEX[data.color] || COLOR_HEX.toolbar;

  const info = document.createElement("div");
  info.className = "identity-info";
  const name = document.createElement("div");
  name.className = "identity-name";
  name.textContent = data.name;
  info.appendChild(name);

  const loggedOut = sessionHealth[id] === false;
  if (loggedOut) row.classList.add("stale");

  // Domain/time/status stay on one compact line. Notes used to be crammed in
  // alongside them and were truncated into nothing; they get their own line.
  const meta = [];
  if (showDomain) meta.push(data.domain);
  const ago = timeAgo(data.lastUsedAt || data.createdAt);
  if (ago) meta.push(ago);
  if (loggedOut) meta.push("logged out");
  if (meta.length) {
    const sub = document.createElement("div");
    sub.className = "identity-meta";
    sub.textContent = meta.join(" · ");
    info.appendChild(sub);
  }

  if (data.notes) {
    const notes = document.createElement("div");
    notes.className = "identity-notes";
    notes.textContent = data.notes;
    notes.title = data.notes; // the clamp can still hide a long note
    info.appendChild(notes);
  }

  const actions = document.createElement("div");
  actions.className = "identity-actions";
  actions.append(
    mkIconBtn("open", "Open in new tab", () => openTab(id, data)),
    mkIconBtn("edit", "Edit session", () => openSessionEdit(id, data)),
    mkIconBtn("close", "Remove session", () => removeIdentity(id), true)
  );

  row.append(dot, info, actions);
  row.addEventListener("click", () => openTab(id, data));
  return row;
}

function mkIconBtn(icon, title, onClick, danger) {
  const btn = document.createElement("button");
  btn.className = "icon-btn" + (danger ? " danger" : "");
  btn.title = title;
  btn.innerHTML = ICONS[icon];
  btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

// Matches across name, domain and notes together, so "resend" finds the
// sessions on resend.com even though the name is only an email address.
// Every term has to hit something, which makes a multi-word query narrow
// rather than widen: "resend hello" matches the resend.com session named
// hello@…, not every session on either side.
function matchesSearch(data, terms) {
  const haystack = [data.name, data.domain, data.notes]
    .filter(Boolean).join(" ").toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

function onSearch() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const groupsView = document.getElementById("groupsView");
  const searchView = document.getElementById("searchView");

  if (!query) {
    searchView.classList.add("hidden");
    groupsView.classList.remove("hidden");
    currentResults = [];
    selectedIndex = -1;
    return;
  }

  groupsView.classList.add("hidden");
  searchView.classList.remove("hidden");

  const terms = query.split(/\s+/).filter(Boolean);
  const matches = Object.entries(identities)
    .filter(([, v]) => v.confirmed && matchesSearch(v, terms))
    .sort(byRecency);
  currentResults = matches;
  selectedIndex = matches.length > 0 ? 0 : -1;
  renderResultRows(matches, `Results for "${query}"`);
}

function onSearchKeydown(e) {
  if (!currentResults.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex = Math.min(selectedIndex + 1, currentResults.length - 1);
    highlightSelected();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex = Math.max(selectedIndex - 1, 0);
    highlightSelected();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const entry = currentResults[selectedIndex];
    if (entry) openTab(entry[0], entry[1]);
  }
}

function highlightSelected() {
  const rows = document.querySelectorAll("#searchResults .identity-row");
  rows.forEach((r, i) => r.classList.toggle("selected", i === selectedIndex));
  rows[selectedIndex]?.scrollIntoView({ block: "nearest" });
}

function renderResultRows(entries, titleText) {
  document.getElementById("searchResultsTitle").textContent = titleText;
  const listEl = document.getElementById("searchResults");
  const emptyEl = document.getElementById("searchEmptyState");
  listEl.innerHTML = "";

  if (entries.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  entries.forEach(([id, data], i) => {
    listEl.appendChild(buildIdentityRow(id, data, true, i === selectedIndex));
  });
}

async function openTab(cookieStoreId, data) {
  await browser.runtime.sendMessage({ action: "openIdentityTab", cookieStoreId, url: data.url });
  window.close();
}

async function removeIdentity(id) {
  await browser.runtime.sendMessage({ action: "removeIdentity", cookieStoreId: id });
  await loadIdentities();
  if (document.getElementById("searchInput").value.trim()) onSearch();
  else renderGroups();
}

// --- Overflow menu -------------------------------------------------------
// "Create rule for this site" opens the rule builder in its own small
// window rather than inline here: this toolbar popup auto-closes the
// moment it loses focus (standard WebExtension behavior), which made it
// impossible to flip back to the actual page — e.g. to log in or trigger
// a field — while testing a selector. A separate window stays open across
// that, so both can be used side by side.

function setupMoreMenu() {
  const menuBtn = document.getElementById("moreMenuBtn");
  const menu = document.getElementById("moreMenu");
  const createItem = document.getElementById("createRuleMenuItem");
  const settingsItem = document.getElementById("settingsMenuItem");

  const domain = webPageParts(activeTab?.url)?.domain || "";
  if (!domain) {
    createItem.disabled = true;
    createItem.title = "Can't create a rule for this page";
  }

  const closeMenu = () => menu.classList.add("hidden");

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  createItem.addEventListener("click", async () => {
    closeMenu();
    if (!activeTab?.id || !domain) return;
    const url = browser.runtime.getURL(
      `rulebuilder.html?tabId=${activeTab.id}&domain=${encodeURIComponent(domain)}`
    );
    try {
      await browser.windows.create({ url, type: "popup", width: 420, height: 680 });
    } catch (e) {
      log("couldn't open rule builder window:", e);
    }
  });

  settingsItem.addEventListener("click", () => {
    closeMenu();
    browser.runtime.openOptionsPage();
  });
}

// --- Session edit panel --------------------------------------------------
// Lets name/notes/color/domain be edited for ANY session, not just the one
// matching the active tab. Domain is the key addition: two containers that
// are really the same site (e.g. "account.proton.me" and "proton.me") show
// up as separate groups purely because of what domain got recorded when
// each one was created — editing the domain here merges them into one.

function openSessionEdit(id, data) {
  editingSessionId = id;
  editColor = data.color;
  document.getElementById("groupsView").classList.add("hidden");
  document.getElementById("searchView").classList.add("hidden");
  document.getElementById("seName").value = data.name || "";
  document.getElementById("seNotes").value = data.notes || "";
  document.getElementById("seDomain").value = data.domain || "";
  document.getElementById("seFormError").classList.add("hidden");
  document.getElementById("seSaveStatus").textContent = "";
  renderSwatches();
  document.getElementById("sessionEditView").classList.remove("hidden");
}

function closeSessionEdit() {
  editingSessionId = null;
  document.getElementById("sessionEditView").classList.add("hidden");
  rerenderActiveView();
}

function renderSwatches() {
  const wrap = document.getElementById("seSwatches");
  wrap.innerHTML = "";
  for (const color of COLORS) {
    const sw = document.createElement("div");
    sw.className = "swatch" + (color === editColor ? " selected" : "");
    sw.style.background = COLOR_HEX[color];
    sw.addEventListener("click", () => {
      editColor = color;
      wrap.querySelectorAll(".swatch").forEach((s, i) => s.classList.toggle("selected", COLORS[i] === color));
    });
    wrap.appendChild(sw);
  }
}

async function saveSessionEdit() {
  document.getElementById("seFormError").classList.add("hidden");

  const name = document.getElementById("seName").value.trim() || "Unnamed";
  const notes = document.getElementById("seNotes").value.trim();
  const domain = document.getElementById("seDomain").value.trim();
  if (!domain) return showSessionEditError("Domain is required.");

  await browser.runtime.sendMessage({
    action: "updateIdentity", cookieStoreId: editingSessionId, name, notes, color: editColor, domain
  });
  await loadIdentities();

  document.getElementById("seSaveStatus").textContent = "Saved ✓";
  setTimeout(closeSessionEdit, 700);
}

function showSessionEditError(text) {
  const el = document.getElementById("seFormError");
  el.textContent = text;
  el.classList.remove("hidden");
}
