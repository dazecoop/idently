const COLOR_HEX = {
  blue: "#5a9aed", turquoise: "#1dd1c3", green: "#5cb85c", yellow: "#e0c341",
  orange: "#e08a3d", red: "#e05a5a", pink: "#e06ab0", purple: "#9966cc", toolbar: "#9a9a9e"
};

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  open: `<svg ${SVG_ATTRS}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  close: `<svg ${SVG_ATTRS}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  chevron: `<svg ${SVG_ATTRS}><polyline points="9 18 15 12 9 6"/></svg>`
};

let identities = {};
let currentResults = [];
let selectedIndex = -1;
let expandedGroups = new Set();
let sessionHealth = {};

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
  document.getElementById("settingsBtn").addEventListener("click", () => browser.runtime.openOptionsPage());

  // Housekeeping: clear out abandoned "+ New session tab" clicks that were
  // never named, except whichever tab is currently active (never yank a
  // tab out from under the user while they're looking at it).
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  setupNewSessionButton(activeTab);
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
  let domain = "", origin = "";
  try {
    const u = new URL(activeTab?.url || "");
    domain = u.host;
    origin = u.origin;
  } catch {}

  if (!domain) {
    btn.disabled = true;
    btn.title = "Can't start a session on this page";
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
  if (document.getElementById("searchInput").value.trim()) onSearch();
  else renderGroups();
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

function renderGroups() {
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
    if (expandedGroups.has(domain)) expandedGroups.delete(domain);
    else expandedGroups.add(domain);
    group.classList.toggle("expanded");
  });

  const childrenWrap = document.createElement("div");
  childrenWrap.className = "group-children-wrap";
  const childrenInner = document.createElement("div");
  childrenInner.className = "group-children-inner";
  const list = document.createElement("div");
  list.className = "list";

  for (const [id, data] of rows) {
    list.appendChild(buildIdentityRow(id, data, false));
  }

  childrenInner.appendChild(list);
  childrenWrap.appendChild(childrenInner);
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
  const parts = [];
  if (showDomain) parts.push(data.domain);
  if (data.notes) parts.push(data.notes);
  const ago = timeAgo(data.lastUsedAt || data.createdAt);
  if (ago) parts.push(ago);
  if (loggedOut) parts.push("logged out");
  if (parts.length) {
    const sub = document.createElement("div");
    sub.className = showDomain ? "identity-domain" : "identity-notes";
    sub.textContent = parts.join(" · ");
    info.appendChild(sub);
  }

  const actions = document.createElement("div");
  actions.className = "identity-actions";
  actions.append(
    mkIconBtn("open", "Open in new tab", () => openTab(id, data)),
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

  const matches = Object.entries(identities).filter(([, v]) =>
    v.confirmed && (v.name.toLowerCase().includes(query) || (v.notes || "").toLowerCase().includes(query))
  ).sort(byRecency);
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
