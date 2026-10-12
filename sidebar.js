(function () {
  const STYLE = "background:#2563eb;color:#fff;padding:2px 6px;border-radius:4px;font-weight:bold;";
  const ERR_STYLE = "background:#dc2626;color:#fff;padding:2px 6px;border-radius:4px;font-weight:bold;";
  const log = (...args) => console.log("%c[Idently][sidebar]", STYLE, ...args);
  const logError = (...args) => console.error("%c[Idently][sidebar] ERROR", ERR_STYLE, ...args);

  const COLOR_HEX = {
    blue: "#5a9aed", turquoise: "#1dd1c3", green: "#5cb85c", yellow: "#e0c341",
    orange: "#e08a3d", red: "#e05a5a", pink: "#e06ab0", purple: "#9966cc", toolbar: "#9a9a9e"
  };
  const COLORS = Object.keys(COLOR_HEX).filter((c) => c !== "toolbar");

  const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const ICONS = {
    open: `<svg ${SVG_ATTRS}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
    close: `<svg ${SVG_ATTRS}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    edit: `<svg ${SVG_ATTRS}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    plus: `<svg ${SVG_ATTRS}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    search: `<svg ${SVG_ATTRS}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    chevronRight: `<svg ${SVG_ATTRS}><polyline points="9 18 15 12 9 6"/></svg>`
  };

  function mkIconBtn(icon, title, onClick, danger) {
    const btn = document.createElement("button");
    btn.className = "icon-btn" + (danger ? " danger" : "");
    btn.title = title;
    btn.innerHTML = ICONS[icon];
    btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  let ctx = null;
  let identities = {};
  let expanded = false;
  let formMode = null; // "confirm" | "edit"
  let formColor = null;
  let editingId = null;
  let searchQuery = "";
  let searchSelectedIndex = -1;
  let searchResultsCache = [];
  let autoNameAttempted = false;
  let siteRules = [];
  let sidebarEnabled = true;
  let sessionHealth = {};
  let searchSelectable = [];
  let searchFocused = false;

  let host, root, handleEl, panelEl;

  // Lets the popup build a site rule from this tab without the user having
  // to hand-write a selector: it can ask this content script to scan the
  // page for likely identity fields, and to test a candidate selector live.
  // Registered up front (not inside init()) so it responds even before
  // ctx/siteRules have loaded.
  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.action === "idently-probe-fields") {
      try { return Promise.resolve({ ok: true, candidates: probeIdentityFields() }); }
      catch (e) { logError("probeIdentityFields failed:", e); return Promise.resolve({ ok: false, error: e.message }); }
    }
    if (msg?.action === "idently-test-selector") {
      const { selectorType, selector, readFrom, pattern } = msg;
      try {
        const node = resolveSelector(selectorType, selector);
        const value = readNodeValue(node, readFrom);
        let patternOk = true;
        if (pattern) {
          try { patternOk = new RegExp(pattern).test(value); } catch { patternOk = true; }
        }
        return Promise.resolve({ ok: true, found: !!node, value, patternOk });
      } catch (e) {
        return Promise.resolve({ ok: false, error: e.message });
      }
    }
    return undefined;
  });

  init();

  async function init() {
    ctx = await browser.runtime.sendMessage({ action: "getTabContext" });
    log("tab context:", ctx);
    if (!ctx || !ctx.domain) { log("no domain on this page, not injecting sidebar"); return; }

    const [localStored, syncStored] = await Promise.all([
      browser.storage.local.get(["identities", "handleTop"]),
      browser.storage.sync.get(["siteRules", "showSidebar"])
    ]);
    identities = localStored.identities || {};
    siteRules = Array.isArray(syncStored.siteRules) ? syncStored.siteRules : [];
    sidebarEnabled = syncStored.showSidebar !== false; // default true

    buildShell();
    if (typeof localStored.handleTop === "number") {
      handleEl.style.top = (localStored.handleTop * 100) + "%";
    }
    applySidebarVisibility();

    const current = identities[ctx.cookieStoreId];
    if (sidebarEnabled && current && !current.confirmed) {
      // Freshly opened via "+ New session tab" — jump straight to naming it.
      expanded = true;
      render();
      focusNameInput();
    } else {
      render();
    }
    maybeStartAutoNaming();

    // storage.onChanged fires for both areas; our keys are unique across
    // local (identities, handleTop) and sync (siteRules, showSidebar).
    browser.storage.onChanged.addListener((changes) => {
      if (changes.identities) {
        identities = changes.identities.newValue || {};
        render();
        maybeStartAutoNaming();
      }
      if (changes.handleTop && typeof changes.handleTop.newValue === "number") {
        handleEl.style.top = (changes.handleTop.newValue * 100) + "%";
      }
      if (changes.siteRules) {
        siteRules = Array.isArray(changes.siteRules.newValue) ? changes.siteRules.newValue : [];
        stopAutoNaming();
        maybeStartAutoNaming();
      }
      if (changes.showSidebar) {
        sidebarEnabled = changes.showSidebar.newValue !== false;
        if (!sidebarEnabled) expanded = false;
        applySidebarVisibility();
        render();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && expanded) {
        e.preventDefault();
        e.stopPropagation();
        expanded = false;
        formMode = null;
        render();
        return;
      }
      // "/" jumps to search — but only when the sidebar is already open.
      if (e.key !== "/") return;
      if (!expanded) return;
      if (document.activeElement === host) return; // already typing inside our own UI
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
      e.preventDefault();
      focusSearchInput();
    }, true);
  }

  function applySidebarVisibility() {
    host.style.display = sidebarEnabled ? "" : "none";
  }

  function focusSearchInput() {
    setTimeout(() => {
      root.querySelector(".search-wrap input")?.focus();
    }, 0);
  }

  function focusNameInput() {
    setTimeout(() => {
      root.querySelector(".form input")?.focus();
    }, 0);
  }

  let autoNameCleanup = null;

  function resolveSelector(selectorType, selector) {
    return selectorType === "css"
      ? document.querySelector(selector)
      : document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  }

  function readNodeValue(node, readFrom) {
    if (!node) return "";
    const value = readFrom === "text"
      ? (node.textContent || "")
      : ("value" in node ? node.value : node.textContent || "");
    return value.trim();
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function cssEscape(s) {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, "\\$1");
  }

  // A short, reasonably stable CSS path: prefer an id anywhere up the tree,
  // otherwise climb a few ancestors tagging on :nth-of-type where a tag
  // repeats among its siblings. Good enough as a starting point for a site
  // rule — the user can always edit it (or switch to XPath) before saving.
  function cssPath(el) {
    if (el.id) return `#${cssEscape(el.id)}`;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 6) {
      if (node.id) { parts.unshift(`#${cssEscape(node.id)}`); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
      depth++;
    }
    return parts.join(" > ");
  }

  function describeInput(el) {
    const type = el.type ? ` (type=${el.type})` : "";
    const hint = el.placeholder || el.name || el.id || "";
    return `Input field${type}${hint ? ` — "${hint}"` : ""}`;
  }

  // Heuristic scan for "which field shows who's logged in" — used by the
  // popup's "Detect automatically" button when creating a site rule. Scores
  // visible inputs by how strongly their attributes suggest an email/
  // username field (never a password field), then falls back to short leaf
  // text nodes that look like an email address (e.g. "Signed in as x@y.com").
  function probeIdentityFields() {
    const results = [];
    const seen = new Set();
    const idHint = /email|user(name)?|login|account/i;

    const addCandidate = (el, selectorType, selector, readFrom, label) => {
      if (!selector || seen.has(selector)) return;
      seen.add(selector);
      results.push({ selectorType, selector, readFrom, label, preview: readNodeValue(el, readFrom).slice(0, 60) });
    };

    const inputs = [...document.querySelectorAll("input")].filter(isVisible);
    const scored = inputs.map((el) => {
      const type = (el.type || "").toLowerCase();
      let score = 0;
      if (type === "password") score -= 10;
      if (type === "email") score += 3;
      if (idHint.test(el.id || "")) score += 2;
      if (idHint.test(el.name || "")) score += 2;
      if (idHint.test(el.autocomplete || "")) score += 2;
      if (idHint.test(el.placeholder || "")) score += 1;
      return { el, score };
    }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

    for (const { el } of scored.slice(0, 4)) {
      addCandidate(el, "css", cssPath(el), "value", describeInput(el));
    }

    if (results.length < 5) {
      const emailRe = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/;
      const textEls = [...document.querySelectorAll("body *")]
        .filter((el) => {
          if (el.children.length > 0) return false; // leaf nodes only
          const t = (el.textContent || "").trim();
          return t.length > 0 && t.length < 100 && emailRe.test(t) && isVisible(el);
        })
        .slice(0, 10);
      for (const el of textEls) {
        if (results.length >= 6) break;
        addCandidate(el, "css", cssPath(el), "text", "Text containing an email address");
      }
    }

    return results.slice(0, 6);
  }

  function findSiteRule() {
    let pathname = "";
    try { pathname = new URL(ctx.url).pathname; } catch {}
    const rule = siteRules.find((r) =>
      r.domain === ctx.domain && (!r.pathPrefix || pathname.startsWith(r.pathPrefix))
    ) || null;
    log(`checking ${siteRules.length} site rule(s) for domain="${ctx.domain}" pathname="${pathname}" ->`, rule ? `matched "${rule.label || rule.domain}"` : "no match");
    return rule;
  }

  function maybeStartAutoNaming() {
    const current = identities[ctx.cookieStoreId];
    if (!current) {
      log("auto-naming: this tab has no identity (not opened via '+ New session tab') — skipping");
      stopAutoNaming();
      return;
    }
    if (current.confirmed) {
      log("auto-naming: identity already confirmed as", JSON.stringify(current.name), "— skipping");
      stopAutoNaming();
      return;
    }
    if (autoNameAttempted) {
      log("auto-naming: already attempted once this page load — skipping");
      return;
    }

    const rule = findSiteRule();
    if (!rule) return;

    if (!autoNameCleanup) {
      log(`auto-naming: watching via rule "${rule.label || rule.domain}"`);
      autoNameCleanup = startRuleWatcher(rule);
    }
  }

  function stopAutoNaming() {
    if (autoNameCleanup) {
      try { autoNameCleanup(); } catch {}
      autoNameCleanup = null;
    }
  }

  // Generic watcher built from a stored rule (see the Settings page). The
  // target value may only exist transiently (a login field wiped on submit)
  // or appear late (client-side rendering, browser autofill that fires no
  // event), so three nets run together: capture-phase user events, a
  // MutationObserver, and a slow poll — whichever sees a value first wins.
  function startRuleWatcher(rule) {
    const tag = rule.label || rule.domain;
    let lastLogged;

    const read = () => {
      let node = null;
      try {
        node = resolveSelector(rule.selectorType, rule.selector);
      } catch (e) {
        if (lastLogged !== "bad-selector") logError(`[${tag}] selector failed:`, e.message);
        lastLogged = "bad-selector";
        return null;
      }
      const value = readNodeValue(node, rule.readFrom);
      const state = !node ? "no node" : JSON.stringify(value);
      if (state !== lastLogged) log(`[${tag}] target:`, state);
      lastLogged = state;
      return value || null;
    };

    const matchesPattern = (value) => {
      if (!value) return false;
      if (!rule.pattern) return true;
      try { return new RegExp(rule.pattern).test(value); }
      catch { return true; } // a broken user regex shouldn't disable the rule
    };

    // Half-typed values must never win (e.g. "r" typed just to surface the
    // autofill dropdown). Passive signals (typing, mutations, polling) only
    // commit after the value has sat unchanged for 1.5s; an explicit
    // submit/click commits immediately, since the page may navigate away
    // before any timer fires.
    let pendingValue = null;
    let stableTimer = null;

    const commitNow = () => {
      const value = read();
      if (matchesPattern(value)) commitAutoName(value);
    };

    const scheduleStable = () => {
      const value = read();
      if (value === pendingValue) return; // countdown for this value already running
      pendingValue = value;
      clearTimeout(stableTimer);
      if (!matchesPattern(value)) return;
      stableTimer = setTimeout(() => {
        const now = read();
        if (now === value && matchesPattern(now)) commitAutoName(now);
      }, 1500);
    };

    const immediateEvents = ["submit", "click"];
    const passiveEvents = ["input", "change"];
    immediateEvents.forEach((t) => document.addEventListener(t, commitNow, true));
    passiveEvents.forEach((t) => document.addEventListener(t, scheduleStable, true));
    const observer = new MutationObserver(scheduleStable);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    const pollInterval = setInterval(scheduleStable, 500);
    const pollTimeout = setTimeout(() => clearInterval(pollInterval), 5 * 60 * 1000);
    scheduleStable();

    return () => {
      immediateEvents.forEach((t) => document.removeEventListener(t, commitNow, true));
      passiveEvents.forEach((t) => document.removeEventListener(t, scheduleStable, true));
      observer.disconnect();
      clearInterval(pollInterval);
      clearTimeout(pollTimeout);
      clearTimeout(stableTimer);
    };
  }

  async function commitAutoName(value) {
    log("auto-naming: value received from rule:", JSON.stringify(value));
    if (autoNameAttempted || !value) return;
    autoNameAttempted = true;
    stopAutoNaming();
    const current = identities[ctx.cookieStoreId];
    log("auto-naming: confirming identity with name", JSON.stringify(value));
    try {
      const result = await browser.runtime.sendMessage({
        action: "confirmIdentity", cookieStoreId: ctx.cookieStoreId,
        name: value, notes: current?.notes || "", color: current?.color
      });
      log("auto-naming: background responded:", result);
    } catch (e) {
      // Without this catch, a rejection here used to vanish as an unhandled
      // promise rejection — storage could end up "confirmed" while the
      // native container never actually got renamed, with no visible error.
      logError("confirmIdentity message failed:", e);
    }
  }

  function buildShell() {
    host = document.createElement("div");
    host.id = "__identity_tabs_host__";
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.top = "0";
    host.style.left = "0";
    host.style.zIndex = "2147483647";
    (document.documentElement || document.body).appendChild(host);

    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <button class="handle" part="handle"></button>
        <div class="panel"></div>
      </div>
    `;
    handleEl = root.querySelector(".handle");
    panelEl = root.querySelector(".panel");

    let didDrag = false;
    handleEl.addEventListener("click", () => {
      if (didDrag) { didDrag = false; return; } // the click that ends a drag shouldn't toggle
      expanded = !expanded;
      render();
      if (expanded) {
        focusSearchInput();
        triggerCleanup();
        refreshSessionHealth();
      }
    });

    // Option(Alt)+drag moves the pill vertically; the position is saved as a
    // fraction of the viewport height so it lands in the same spot on every
    // site/page and window size.
    handleEl.addEventListener("mousedown", (e) => {
      if (!e.altKey) return;
      e.preventDefault();
      let lastY = e.clientY;
      let moved = false;
      const onMove = (ev) => {
        moved = true;
        lastY = Math.min(Math.max(ev.clientY, 40), window.innerHeight - 40);
        handleEl.style.top = lastY + "px";
        ev.preventDefault();
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        if (!moved) return;
        didDrag = true;
        const frac = Math.min(Math.max(lastY / window.innerHeight, 0.05), 0.95);
        handleEl.style.top = (frac * 100) + "%";
        browser.storage.local.set({ handleTop: frac }).catch(() => {});
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });
  }

  function triggerCleanup() {
    browser.runtime.sendMessage({ action: "cleanupUnnamed", excludeCookieStoreId: ctx.cookieStoreId })
      .then((result) => { if (result?.removed) log(`cleanup: removed ${result.removed} abandoned session(s)`); })
      .catch((e) => logError("cleanupUnnamed failed:", e));
  }

  function refreshSessionHealth() {
    browser.runtime.sendMessage({ action: "sessionHealth" })
      .then((health) => {
        sessionHealth = health || {};
        render();
      })
      .catch(() => {});
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

  function siblingsForDomain() {
    return Object.entries(identities)
      .filter(([, v]) => v.domain === ctx.domain && v.confirmed)
      .sort(byRecency);
  }

  // The active, keyboard-navigable row list: a global name/notes search once
  // the box has text, otherwise ALL of this domain's sessions (the current
  // one included, shown highlighted in place) — so Down/Enter works the
  // instant the sidebar opens, before anything is typed. Both sorted most
  // recently used first.
  function activeRows() {
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      const rows = Object.entries(identities).filter(([, v]) =>
        v.confirmed && (v.name.toLowerCase().includes(q) || (v.notes || "").toLowerCase().includes(q))
      ).sort(byRecency);
      return { mode: "global", rows };
    }
    return { mode: "siblings", rows: siblingsForDomain() };
  }

  function render() {
    const current = identities[ctx.cookieStoreId];
    renderHandle(current);

    panelEl.classList.toggle("panel--expanded", expanded);
    handleEl.classList.toggle("handle--faded", expanded);

    if (current && !current.confirmed) {
      formMode = formMode || "confirm";
    }

    panelEl.innerHTML = "";
    panelEl.appendChild(buildHeader());
    panelEl.appendChild(buildSearch());

    const { mode, rows } = activeRows();
    // The current tab's row is inert (can't be opened), so keyboard
    // navigation skips it — otherwise the solid "selected" highlight lands
    // on top of the "current" tint and becomes unreadable.
    searchSelectable = rows.map(([id], i) => (id === ctx.cookieStoreId ? -1 : i)).filter((i) => i !== -1);
    if (!searchSelectable.includes(searchSelectedIndex)) {
      searchSelectedIndex = searchSelectable.length ? searchSelectable[0] : -1;
    }
    searchResultsCache = rows;

    if (mode === "global") {
      panelEl.appendChild(buildRowList(rows, `Results (${rows.length})`, "No matches.", true));
      return;
    }

    const statusSection = buildCurrentSection(current);
    if (statusSection) panelEl.appendChild(statusSection);
    if (formMode) panelEl.appendChild(buildForm(current));
    panelEl.appendChild(buildRowList(rows, "Sessions here", "None yet.", false));
    panelEl.appendChild(buildNewButton());
  }

  function renderHandle(current) {
    handleEl.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "handle-dot";
    dot.style.background = current ? (COLOR_HEX[current.color] || COLOR_HEX.toolbar) : "#9a9a9e";
    handleEl.appendChild(dot);
    const count = siblingsForDomain().length;
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "handle-count";
      badge.textContent = count;
      handleEl.appendChild(badge);
    }
  }

  function buildHeader() {
    const header = document.createElement("div");
    header.className = "header";
    const title = document.createElement("div");
    title.className = "domain";
    title.textContent = ctx.domain;
    const close = mkIconBtn("close", "Close sidebar", () => { expanded = false; formMode = null; render(); });
    header.append(title, close);
    return header;
  }

  function buildSearch() {
    const wrap = document.createElement("div");
    wrap.className = "search-wrap";
    const icon = document.createElement("span");
    icon.className = "search-icon";
    icon.innerHTML = ICONS.search;
    wrap.appendChild(icon);
    const input = document.createElement("input");
    input.placeholder = "Search sessions… (/)";
    input.value = searchQuery;
    // The keyboard-selection highlight only shows while the search box is
    // focused — otherwise a row looks "active" the moment the panel opens.
    input.addEventListener("focus", () => { searchFocused = true; highlightSearchSelection(); });
    input.addEventListener("blur", () => { searchFocused = false; highlightSearchSelection(); });
    input.addEventListener("input", (e) => {
      searchQuery = e.target.value;
      searchSelectedIndex = -1;
      render();
      focusSearchInput();
    });
    input.addEventListener("keydown", (e) => {
      if (!searchSelectable.length) return;
      const pos = searchSelectable.indexOf(searchSelectedIndex);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        searchSelectedIndex = searchSelectable[Math.min(pos + 1, searchSelectable.length - 1)];
        highlightSearchSelection();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        searchSelectedIndex = searchSelectable[Math.max(pos - 1, 0)];
        highlightSearchSelection();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const entry = searchResultsCache[searchSelectedIndex];
        if (entry && entry[0] !== ctx.cookieStoreId) {
          browser.runtime.sendMessage({ action: "openIdentityTab", cookieStoreId: entry[0], url: entry[1].url });
        }
      }
    });
    wrap.appendChild(input);
    return wrap;
  }

  function highlightSearchSelection() {
    const rows = root.querySelectorAll(".sibling-row");
    rows.forEach((r, i) => r.classList.toggle("selected", searchFocused && i === searchSelectedIndex));
    if (searchFocused) rows[searchSelectedIndex]?.scrollIntoView({ block: "nearest" });
  }

  // Renders the active, keyboard-navigable row list — either this domain's
  // other sessions or a global name/notes search, per `activeRows()`.
  // `showDomain` prints the domain under the name (useful once results span
  // multiple sites); otherwise notes are shown instead.
  function buildRowList(rows, title, emptyText, showDomain) {
    const wrap = document.createElement("div");
    wrap.className = "siblings";
    const titleEl = document.createElement("div");
    titleEl.className = "section-title";
    titleEl.textContent = title;
    wrap.appendChild(titleEl);

    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted small";
      empty.textContent = emptyText;
      wrap.appendChild(empty);
      return wrap;
    }

    rows.forEach(([id, data], i) => {
      const isCurrent = id === ctx.cookieStoreId;
      const row = document.createElement("div");
      row.className = "sibling-row"
        + (searchFocused && i === searchSelectedIndex ? " selected" : "")
        + (isCurrent ? " current" : "");
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = COLOR_HEX[data.color] || COLOR_HEX.toolbar;
      const info = document.createElement("div");
      info.className = "sibling-info";
      const name = document.createElement("div");
      name.className = "sibling-name";
      name.textContent = data.name;
      info.appendChild(name);
      if (isCurrent) {
        const currentLabel = document.createElement("div");
        currentLabel.className = "current-label";
        currentLabel.textContent = "current tab";
        info.appendChild(currentLabel);
      }
      const loggedOut = sessionHealth[id] === false;
      if (loggedOut) row.classList.add("stale");
      const parts = [];
      if (showDomain) parts.push(data.domain);
      if (data.notes) parts.push(data.notes);
      const ago = timeAgo(data.lastUsedAt || data.createdAt);
      if (ago) parts.push(ago);
      if (loggedOut) parts.push("logged out");
      if (parts.length) {
        const notes = document.createElement("div");
        notes.className = "sibling-notes";
        notes.textContent = parts.join(" · ");
        info.appendChild(notes);
      }

      const actions = document.createElement("div");
      actions.className = "row-actions";
      if (isCurrent) {
        // No ✕ here: it deletes the whole container, which reads as "close
        // tab" when it's on the row you're sitting in. Edit only.
        actions.append(
          mkIconBtn("edit", "Edit session", () => {
            formMode = "edit"; editingId = ctx.cookieStoreId; formColor = data.color; render();
          })
        );
      } else {
        actions.append(
          mkIconBtn("open", "Open in new tab", () => {
            browser.runtime.sendMessage({ action: "openIdentityTab", cookieStoreId: id, url: data.url });
          }),
          mkIconBtn("close", "Remove session", () => {
            browser.runtime.sendMessage({ action: "removeIdentity", cookieStoreId: id });
          }, true)
        );
      }

      row.append(dot, info, actions);
      if (!isCurrent) {
        row.addEventListener("click", () => {
          browser.runtime.sendMessage({ action: "openIdentityTab", cookieStoreId: id, url: data.url });
        });
      }
      wrap.appendChild(row);
    });
    return wrap;
  }

  function buildCurrentSection(current) {
    const section = document.createElement("div");
    section.className = "current-section";

    if (!current) {
      const label = document.createElement("div");
      label.className = "muted";
      label.textContent = "This tab isn't part of a session. Use “+ New session tab” to start one.";
      section.appendChild(label);
      return section;
    }

    if (!current.confirmed) {
      const label = document.createElement("div");
      label.className = "muted";
      label.textContent = "New session — name it below.";
      section.appendChild(label);
      return section;
    }

    // Confirmed sessions aren't shown in a separate top section — the
    // current one appears highlighted in place within the sessions list.
    return null;
  }

  function buildForm(current) {
    const wrap = document.createElement("div");
    wrap.className = "form";

    const nameInput = document.createElement("input");
    nameInput.placeholder = "Name — e.g. Work, Client A, Personal";
    nameInput.maxLength = 40;
    nameInput.value = current?.name || "";

    const notesInput = document.createElement("textarea");
    notesInput.placeholder = "Notes (optional)";
    notesInput.rows = 2;
    notesInput.maxLength = 280;
    notesInput.value = current?.notes || "";

    if (!formColor) formColor = current?.color || COLORS[Math.floor(Math.random() * COLORS.length)];

    const swatches = document.createElement("div");
    swatches.className = "swatches";
    for (const color of COLORS) {
      const sw = document.createElement("div");
      sw.className = "swatch" + (color === formColor ? " selected" : "");
      sw.style.background = COLOR_HEX[color];
      sw.addEventListener("click", () => { formColor = color; renderSwatchSelection(swatches, color); });
      swatches.appendChild(sw);
    }

    const actions = document.createElement("div");
    actions.className = "form-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn secondary small";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => { formMode = (current && !current.confirmed) ? "confirm" : null; render(); });
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn primary small";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim() || "Unnamed";
      const notes = notesInput.value.trim();
      if (formMode === "confirm") {
        await browser.runtime.sendMessage({
          action: "confirmIdentity", cookieStoreId: ctx.cookieStoreId, name, notes, color: formColor
        });
        formMode = null;
      } else if (formMode === "edit") {
        await browser.runtime.sendMessage({
          action: "updateIdentity", cookieStoreId: editingId, name, notes, color: formColor
        });
        formMode = null;
      }
    });

    if (current && !current.confirmed) {
      cancelBtn.remove();
    }

    actions.append(cancelBtn, saveBtn);
    wrap.append(nameInput, notesInput, swatches, actions);
    return wrap;
  }

  function renderSwatchSelection(wrap, color) {
    [...wrap.children].forEach((sw, i) => sw.classList.toggle("selected", COLORS[i] === color));
  }

  function buildNewButton() {
    const btn = document.createElement("button");
    btn.className = "btn new-btn";
    btn.innerHTML = `<span class="btn-icon">${ICONS.plus}</span> New session tab`;
    btn.addEventListener("click", () => {
      browser.runtime.sendMessage({ action: "createNewIdentity", domain: ctx.domain, origin: ctx.origin });
    });
    return btn;
  }

  const CSS = `
    :host { all: initial; }
    .wrap { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

    .handle {
      position: fixed; top: 50%; left: 0; transform: translateY(-50%);
      width: 20px; height: 60px; border: none; border-radius: 0 10px 10px 0;
      background: #242428; cursor: pointer; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 5px; padding: 0;
      box-shadow: 1px 0 8px rgba(0,0,0,0.3);
      transition: opacity 0.2s ease, transform 0.2s ease, background 0.15s ease;
    }
    .handle:hover { background: #333338; }
    .handle.handle--faded { opacity: 0; pointer-events: none; transform: translateY(-50%) translateX(-8px); }
    .handle-dot { width: 8px; height: 8px; border-radius: 50%; }
    .handle-count {
      font-size: 9px; font-weight: 600; color: #fff; background: rgba(255,255,255,0.18);
      border-radius: 6px; padding: 1px 5px;
    }

    .panel {
      position: fixed; top: 0; left: 0; height: 100vh; width: 304px;
      background: #1c1c1f; color: #f2f2f3;
      box-shadow: 4px 0 24px rgba(0,0,0,0.4);
      padding: 16px; box-sizing: border-box; overflow-y: auto; font-size: 13px;
      transform: translateX(-100%);
      transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
      pointer-events: none;
    }
    .panel.panel--expanded { transform: translateX(0); pointer-events: auto; }

    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .domain { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .icon-btn {
      border: none; background: transparent; color: #9a9a9e; cursor: pointer;
      padding: 5px; border-radius: 6px; display: inline-flex;
      align-items: center; justify-content: center;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .icon-btn svg { width: 13px; height: 13px; }
    .icon-btn:hover { background: #333338; color: #fff; }
    .icon-btn.danger:hover { color: #e05a5a; }

    .search-wrap { position: relative; margin-bottom: 14px; }
    .search-icon {
      position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
      display: inline-flex; color: #9a9a9e; pointer-events: none;
    }
    .search-icon svg { width: 13px; height: 13px; }
    .search-wrap input {
      width: 100%; box-sizing: border-box; background: #2a2a2d; color: #f2f2f3;
      border: 1px solid #38383b; border-radius: 8px; padding: 8px 10px 8px 29px;
      font-size: 12px; font-family: inherit;
      transition: border-color 0.15s ease;
    }
    .search-wrap input:focus { outline: none; border-color: #7b7bf0; }
    .search-wrap input::placeholder { color: #9a9a9e; }

    .current-section { margin-bottom: 16px; padding-bottom: 14px; border-bottom: 1px solid #38383b; }
    .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .notes { color: #9a9a9e; font-size: 11px; margin-top: 7px; line-height: 1.4; }
    .muted { color: #9a9a9e; margin-bottom: 8px; line-height: 1.45; }
    .muted.small { font-size: 11px; }

    .btn {
      border: none; border-radius: 8px; cursor: pointer; font-family: inherit;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .btn-icon { display: inline-flex; }
    .btn-icon svg { width: 13px; height: 13px; }
    .btn.primary { background: #7b7bf0; color: #0c0c0d; font-weight: 600; }
    .btn.primary:hover { background: #8f8ff4; }
    .btn.secondary { background: transparent; color: #9a9a9e; }
    .btn.secondary:hover { color: #fff; }
    .btn.small { font-size: 12px; padding: 6px 12px; }
    .btn.new-btn {
      width: 100%; background: #2a2a2d; color: #f2f2f3; border: 1px dashed #4a4a4f;
      padding: 10px; margin-top: 14px; font-size: 12px; font-weight: 500;
    }
    .btn.new-btn:hover { background: #333338; border-color: #7b7bf0; }
    .btn.new-btn .btn-icon { color: #7b7bf0; }

    .form { background: #2a2a2d; border-radius: 10px; padding: 12px; margin-bottom: 16px; }
    .form input, .form textarea {
      width: 100%; box-sizing: border-box; background: #1c1c1f; color: #f2f2f3;
      border: 1px solid #38383b; border-radius: 7px; padding: 8px 10px; font-size: 12px;
      margin-bottom: 8px; font-family: inherit; resize: none;
      transition: border-color 0.15s ease;
    }
    .form input:focus, .form textarea:focus { outline: none; border-color: #7b7bf0; }
    .swatches { display: flex; gap: 7px; margin-bottom: 12px; flex-wrap: wrap; }
    .swatch {
      width: 19px; height: 19px; border-radius: 50%; cursor: pointer;
      border: 2px solid transparent; transition: transform 0.12s ease, border-color 0.12s ease;
    }
    .swatch:hover { transform: scale(1.15); }
    .swatch.selected { border-color: #fff; }
    .form-actions { display: flex; justify-content: flex-end; gap: 6px; }

    .section-title {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
      font-weight: 600; color: #9a9a9e; margin-bottom: 8px;
    }
    .siblings { margin-top: 2px; }

    .sibling-row {
      display: flex; align-items: center; gap: 9px; padding: 7px 8px;
      border-radius: 8px; cursor: pointer;
      transition: background 0.12s ease;
    }
    .sibling-row:hover { background: #2a2a2d; }
    .sibling-row.current {
      background: rgba(123, 123, 240, 0.12);
      box-shadow: inset 2px 0 0 #7b7bf0;
      cursor: default;
    }
    .sibling-row.current:hover { background: rgba(123, 123, 240, 0.16); }
    .sibling-row.current .sibling-name { color: #ffffff; font-weight: 600; }
    .sibling-row.current.stale .sibling-name { color: #ffffff; }
    .sibling-row.current .sibling-notes { color: #b9b9c6; }
    .current-label {
      font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
      color: #7b7bf0; margin-top: 2px;
    }
    .sibling-row.stale .dot { opacity: 0.35; }
    .sibling-row.stale .sibling-name { color: #9a9a9e; }
    .sibling-row.selected { background: #7b7bf0; }
    .sibling-row.selected .sibling-name, .sibling-row.selected .sibling-notes { color: #0c0c0d; }
    .sibling-row.selected .icon-btn { color: #0c0c0d; opacity: 0.85; }
    .sibling-info { flex: 1; min-width: 0; }
    .sibling-name { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sibling-notes { font-size: 10px; color: #9a9a9e; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .row-actions {
      display: flex; gap: 1px; flex-shrink: 0;
      opacity: 0; transition: opacity 0.12s ease;
    }
    .sibling-row:hover .row-actions, .sibling-row.selected .row-actions { opacity: 1; }
  `;
})();
