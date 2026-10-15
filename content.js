(function () {
  const STYLE = "background:#2563eb;color:#fff;padding:2px 6px;border-radius:4px;font-weight:bold;";
  const ERR_STYLE = "background:#dc2626;color:#fff;padding:2px 6px;border-radius:4px;font-weight:bold;";
  const log = (...args) => console.log("%c[Idently][notch]", STYLE, ...args);
  const logError = (...args) => console.error("%c[Idently][notch] ERROR", ERR_STYLE, ...args);

  const COLOR_HEX = {
    blue: "#5a9aed", turquoise: "#1dd1c3", green: "#5cb85c", yellow: "#e0c341",
    orange: "#e08a3d", red: "#e05a5a", pink: "#e06ab0", purple: "#9966cc", toolbar: "#9a9a9e"
  };

  const COLORS = Object.keys(COLOR_HEX).filter((c) => c !== "toolbar");

  const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const ICONS = {
    close: `<svg ${SVG_ATTRS}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    // Shown on an unnamed session: lit when a site rule is watching this
    // page and will name the session for you, unlit when nothing is.
    edit: `<svg ${SVG_ATTRS}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    rule: `<svg ${SVG_ATTRS}><path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8 19 13"/><path d="M15 9h.01"/><path d="M17.8 6.2 19 5"/><path d="m3 21 9-9"/><path d="M12.2 6.2 11 5"/></svg>`
  };

  function mkIconBtn(icon, title, onClick) {
    const btn = document.createElement("button");
    btn.className = "icon-btn";
    btn.title = title;
    btn.innerHTML = ICONS[icon];
    btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  // Notch geometry: the bar's own colour, reused by the two corner fillets,
  // and the radius of those fillets.
  const NOTCH_BG = "#242428";
  const NOTCH_FILLET = 14;
  // Size of the expanded naming form, and the easing both axes share. The
  // values are fixed because an auto size can't be animated to.
  const NOTCH_FORM_W = 272;
  const NOTCH_FORM_H = 192;
  const NOTCH_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
  // How close to dead centre a drag has to land before it snaps there.
  const NOTCH_SNAP = 26;

  let ctx = null;
  let identities = {};
  let siteRules = [];
  let badgeEnabled = true;
  // Per-page dismissal only — deliberately not persisted. The notch's whole
  // job is to stop you typing into the wrong account's tab, so it has to come
  // back on the next page load rather than staying off forever.
  let badgeDismissed = false;
  // Where the notch sits: the string "center" (the default, and a true
  // centre anchor rather than a coordinate) or a number for a fraction of
  // viewport width. Saved browser-wide in storage.local.
  let notchPos = "center";
  let notchDidDrag = false;
  let copiedTimer = null;
  // The naming form is open. While it is, renderBadge() leaves the notch
  // alone — a storage change or a preview tick must never rebuild the DOM
  // out from under someone mid-type.
  let notchExpanded = false;
  let formColor = null;
  // Latest value the site rule can see in the watched field, or null. Shown
  // in place of "Unnamed" so you can watch the name the session is about to
  // take shape as you type it into the page's own login form.
  let rulePreview = null;
  // One naming attempt per page load, however it happens — rule or by hand.
  let autoNameAttempted = false;

  let host, root, badgeEl;

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
    if (!ctx || !ctx.domain) { log("no domain on this page, nothing to do here"); return; }

    const [localStored, syncStored] = await Promise.all([
      browser.storage.local.get(["identities", "notchPos"]),
      browser.storage.sync.get(["siteRules", "showNameBadge"])
    ]);
    identities = localStored.identities || {};
    siteRules = Array.isArray(syncStored.siteRules) ? syncStored.siteRules : [];
    badgeEnabled = syncStored.showNameBadge !== false; // default true
    notchPos = readNotchPos(localStored.notchPos);

    buildShell();
    render();
    maybeStartAutoNaming();

    // storage.onChanged fires for both areas; our keys are unique across
    // local (identities, notchPos) and sync (siteRules, showNameBadge).
    browser.storage.onChanged.addListener((changes) => {
      if (changes.identities) {
        identities = changes.identities.newValue || {};
        render();
        maybeStartAutoNaming();
      }
      if (changes.notchPos) {
        notchPos = readNotchPos(changes.notchPos.newValue);
        applyNotchPosition();
      }
      if (changes.siteRules) {
        siteRules = Array.isArray(changes.siteRules.newValue) ? changes.siteRules.newValue : [];
        stopAutoNaming();
        maybeStartAutoNaming();
      }
      if (changes.showNameBadge) {
        badgeEnabled = changes.showNameBadge.newValue !== false;
        // Toggling the setting back on is an explicit "show me this", so it
        // clears a dismissal from earlier on this page.
        if (badgeEnabled) badgeDismissed = false;
        host.style.display = badgeEnabled ? "" : "none";
        render();
      }
    });
  }

  // Anything that isn't a usable fraction falls back to centred, which is
  // both the default and the safe answer for a stored value we can't read.
  function readNotchPos(stored) {
    return typeof stored === "number" && isFinite(stored) ? stored : "center";
  }

  function render() {
    renderBadge(identities[ctx.cookieStoreId]);
  }

  function buildShell() {
    host = document.createElement("div");
    host.id = "__identity_tabs_host__";
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.top = "0";
    host.style.left = "0";
    host.style.zIndex = "2147483647";
    host.style.display = badgeEnabled ? "" : "none";
    (document.documentElement || document.body).appendChild(host);

    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <div class="badge"></div>
      </div>
    `;
    badgeEl = root.querySelector(".badge");

    // Option(Alt)+drag slides the notch along the top edge. Bound on
    // mousedown anywhere on the notch, the name button included — which is
    // why the click handler checks notchDidDrag before copying.
    badgeEl.addEventListener("mousedown", (e) => {
      // Cleared on every press, not just on the click that consumes it: a
      // drag ending outside the notch fires no click, and a stale flag would
      // silently eat the next genuine one.
      notchDidDrag = false;
      if (!e.altKey) return;
      e.preventDefault();
      const width = badgeEl.offsetWidth;
      const grabOffset = e.clientX - badgeEl.getBoundingClientRect().left;
      let moved = false;
      let snapped = false;
      let lastLeft = badgeEl.getBoundingClientRect().left;

      const onMove = (ev) => {
        moved = true;
        const max = Math.max(NOTCH_FILLET, window.innerWidth - width - NOTCH_FILLET);
        const centred = (window.innerWidth - width) / 2;
        let left = Math.min(Math.max(ev.clientX - grabOffset, NOTCH_FILLET), max);
        // Snapping is what makes "centre" reachable at all: the notch's
        // width changes with the session name, so a position saved as a
        // fraction of the viewport only looks centred for the name it was
        // dragged with. Landing in the snap zone stores a centre ANCHOR
        // instead, which re-centres itself whatever the name.
        snapped = Math.abs(left - centred) <= NOTCH_SNAP;
        if (snapped) left = centred;
        lastLeft = left;
        badgeEl.classList.toggle("badge--snapped", snapped);
        badgeEl.style.transform = "none";
        badgeEl.style.right = "auto";
        badgeEl.style.left = left + "px";
        ev.preventDefault();
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        badgeEl.classList.remove("badge--snapped");
        if (!moved) return;
        notchDidDrag = true;
        notchPos = snapped ? "center" : lastLeft / window.innerWidth;
        applyNotchPosition();
        browser.storage.local.set({ notchPos }).catch(() => {});
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });

    // A window that narrows after the notch was parked could leave it
    // hanging off the right-hand side; re-clamping on resize pulls it back.
    window.addEventListener("resize", applyNotchPosition);
  }

  // A floating marker hanging off the top edge of the page, naming the
  // session this tab belongs to. Three states:
  //   untracked  — this tab was never opened as a session: no notch at all
  //   unnamed    — a session exists but has no name yet: "Unnamed", click
  //                to open the naming form
  //   named      — the name, click to copy it
  function renderBadge(current) {
    // Never rebuild while the naming form is open: a storage change or a
    // rule-preview tick would wipe out half-typed input.
    if (notchExpanded) return;

    if (!badgeEnabled || badgeDismissed || !current) {
      badgeEl.style.display = "none";
      return;
    }
    const name = (current.name || "").trim();
    const named = !!(current.confirmed && name);

    badgeEl.style.display = "";
    badgeEl.className = "badge";
    badgeEl.innerHTML = "";
    badgeEl.style.width = "";
    badgeEl.style.height = "";
    clearTimeout(copiedTimer);

    const clip = document.createElement("div");
    clip.className = "badge-clip";

    const collapsed = document.createElement("div");
    collapsed.className = "badge-collapsed";

    const dot = document.createElement("span");
    dot.className = "badge-dot";
    dot.style.background = COLOR_HEX[current.color] || COLOR_HEX.toolbar;

    const label = document.createElement("span");
    label.className = "badge-name" + (named ? "" : " badge-name--unnamed");
    // An unnamed session with a rule watching the page previews the value as
    // it's typed, so you can see what it's about to be called.
    label.textContent = named ? name : (rulePreview || "Unnamed");

    const copied = document.createElement("span");
    copied.className = "badge-copied";

    const main = document.createElement("button");
    main.className = "badge-main";
    main.title = named
      ? `${name} — click to copy, Option-drag to move`
      : "Click to name this session, Option-drag to move";
    main.append(dot, label, copied);
    main.addEventListener("click", (e) => {
      e.stopPropagation();
      // The click that ends an Option-drag shouldn't also act.
      if (notchDidDrag) { notchDidDrag = false; return; }
      if (named) {
        copyToClipboard(name).then((ok) => flashCopied(copied, ok));
      } else {
        expandForm(current);
      }
    });
    collapsed.append(main);

    if (!named) {
      const rule = findSiteRule();
      const ruleIcon = document.createElement("span");
      ruleIcon.className = "badge-rule" + (rule ? " badge-rule--lit" : "");
      ruleIcon.innerHTML = ICONS.rule;
      ruleIcon.title = rule
        ? `Auto-naming from the rule "${rule.label || rule.domain}" — fill the login field and this names itself`
        : "No auto-naming rule for this site";
      collapsed.append(ruleIcon);
    }

    if (named) {
      collapsed.append(mkIconBtn("edit", "Edit name, colour and notes", () => {
        if (notchDidDrag) { notchDidDrag = false; return; }
        expandForm(current);
      }));
    }

    collapsed.append(mkIconBtn("close", "Hide until this page reloads", () => {
      if (notchDidDrag) { notchDidDrag = false; return; }
      badgeDismissed = true;
      renderBadge(current);
    }));

    clip.append(collapsed);
    badgeEl.append(clip);
    applyNotchPosition();
  }

  // --- naming form (the "dynamic island" expansion) ---------------------

  // Width and height can't animate from content-size to content-size, so the
  // collapsed box is pinned to its measured pixel size first; the expanded
  // class then supplies fixed target values and CSS does the rest.
  function expandForm(current) {
    const w = badgeEl.offsetWidth, h = badgeEl.offsetHeight;
    badgeEl.style.width = w + "px";
    badgeEl.style.height = h + "px";

    notchExpanded = true;
    formColor = current.color || COLORS[0];
    // Opening the form by hand means naming it by hand — a rule committing
    // underneath would yank the field away mid-type. Cancelling puts the
    // watcher back.
    stopAutoNaming();

    const form = buildForm(current);
    badgeEl.querySelector(".badge-clip").append(form);

    // Two frames: the browser has to see the pinned start size before the
    // class changes it, or there's nothing to interpolate from.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      badgeEl.classList.add("badge--expanded");
      badgeEl.style.width = "";
      badgeEl.style.height = "";
      form.querySelector("input")?.focus();
    }));

    document.addEventListener("keydown", onFormKeydown, true);
    document.addEventListener("mousedown", onFormOutsideClick, true);
  }

  function collapseForm(restartAutoNaming) {
    if (!notchExpanded) return;
    notchExpanded = false;
    document.removeEventListener("keydown", onFormKeydown, true);
    document.removeEventListener("mousedown", onFormOutsideClick, true);
    badgeEl.classList.remove("badge--expanded");
    const current = identities[ctx.cookieStoreId];
    // Wait out the shrink before swapping the content back, so the notch
    // doesn't visibly pop to its collapsed form mid-animation.
    setTimeout(() => {
      renderBadge(current);
      if (restartAutoNaming) maybeStartAutoNaming();
    }, 260);
  }

  function onFormKeydown(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    collapseForm(true);
  }

  function onFormOutsideClick(e) {
    // The notch lives in a closed shadow root, so a click inside it reports
    // the host as its target — anything else is genuinely outside.
    if (e.composedPath?.().includes(host) || e.target === host) return;
    collapseForm(true);
  }

  function buildForm(current) {
    const form = document.createElement("div");
    form.className = "badge-form";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "badge-input";
    input.maxLength = 60;
    input.placeholder = "Name this session";
    input.value = (current.name || "").trim() || rulePreview || "";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(); }
    });

    const notes = document.createElement("textarea");
    notes.className = "badge-input badge-notes";
    notes.maxLength = 280;
    notes.rows = 2;
    notes.placeholder = "Notes (optional)";
    notes.value = current.notes || "";
    // Enter inserts a newline in a textarea, so Cmd/Ctrl+Enter saves instead.
    notes.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    });

    const swatches = document.createElement("div");
    swatches.className = "badge-swatches";
    for (const color of COLORS) {
      const sw = document.createElement("button");
      sw.className = "badge-swatch" + (color === formColor ? " badge-swatch--on" : "");
      sw.style.background = COLOR_HEX[color];
      sw.title = color;
      sw.addEventListener("click", (e) => {
        e.stopPropagation();
        formColor = color;
        for (const el of swatches.children) el.classList.remove("badge-swatch--on");
        sw.classList.add("badge-swatch--on");
      });
      swatches.append(sw);
    }

    const cancel = document.createElement("button");
    cancel.className = "badge-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", (e) => { e.stopPropagation(); collapseForm(true); });

    const saveBtn = document.createElement("button");
    saveBtn.className = "badge-btn badge-btn--primary";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", (e) => { e.stopPropagation(); save(); });

    const actions = document.createElement("div");
    actions.className = "badge-actions";
    actions.append(cancel, saveBtn);

    async function save() {
      const value = input.value.trim();
      if (!value) { input.focus(); return; }
      // Don't let the rule fire for this page load after a manual name.
      autoNameAttempted = true;
      // An already-confirmed session is being edited, not named: updateIdentity
      // leaves confirmed/lastUsedAt alone, where confirmIdentity would stamp
      // them as if the session had just been created.
      const action = current.confirmed ? "updateIdentity" : "confirmIdentity";
      try {
        await browser.runtime.sendMessage({
          action, cookieStoreId: ctx.cookieStoreId,
          name: value, notes: notes.value.trim(), color: formColor
        });
      } catch (e) {
        logError(`${action} from notch form failed:`, e);
      }
      collapseForm(false);
    }

    form.append(input, notes, swatches, actions);
    return form;
  }

  // navigator.clipboard needs a secure context, so it's simply absent on
  // plain-http pages — which is exactly where a lot of local dev happens.
  // Fall back to the old execCommand path there; both are running inside a
  // click handler, so the user-gesture requirement is satisfied either way.
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      logError("clipboard.writeText failed, falling back:", e);
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      logError("execCommand copy failed:", e);
      return false;
    }
  }

  function flashCopied(overlayEl, ok) {
    clearTimeout(copiedTimer);
    overlayEl.textContent = ok ? "Copied" : "Copy failed";
    overlayEl.classList.add("badge-copied--show");
    copiedTimer = setTimeout(() => overlayEl.classList.remove("badge-copied--show"), 1100);
  }

  // Keeps the notch where it was parked. Centred — the default — is applied
  // as a real 50% + translate so it stays centred as the name (and so the
  // width) changes; a dragged fraction is clamped so neither the notch nor
  // its corner fillets can end up off-screen.
  function applyNotchPosition() {
    if (badgeEl.style.display === "none") return;
    badgeEl.style.transform = "none";
    badgeEl.style.right = "auto";
    if (notchPos === "center") {
      badgeEl.style.left = "50%";
      badgeEl.style.transform = "translateX(-50%)";
      return;
    }
    const width = badgeEl.offsetWidth;
    const max = Math.max(NOTCH_FILLET, window.innerWidth - width - NOTCH_FILLET);
    badgeEl.style.left = Math.min(Math.max(notchPos * window.innerWidth, NOTCH_FILLET), max) + "px";
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

  // read() runs on every keystroke, mutation and poll tick, so only an
  // actual change is allowed to reach the DOM — otherwise the notch would
  // rebuild itself twice a second for its whole life.
  function setRulePreview(value) {
    if (value === rulePreview) return;
    rulePreview = value;
    renderBadge(identities[ctx.cookieStoreId]);
  }

  function stopAutoNaming() {
    if (autoNameCleanup) {
      try { autoNameCleanup(); } catch {}
      autoNameCleanup = null;
    }
    setRulePreview(null);
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
      setRulePreview(value || null);
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

  const CSS = `
    :host { all: initial; }
    .wrap { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

    /* The notch: a bar hanging off the top edge, bottom corners rounded.
       The drop-shadow is a filter rather than a box-shadow so it follows the
       combined silhouette of the bar and its two corner fillets below —
       box-shadow would outline each piece separately and show the seams.
       max-width keeps a long name (an email address, say) from spanning the
       viewport. */
    .badge {
      position: fixed; top: 0; left: 50%; transform: translateX(-50%);
      box-sizing: border-box;
      background: ${NOTCH_BG}; border-radius: 0 0 16px 16px;
      max-width: min(320px, 60vw);
      filter: drop-shadow(0 2px 6px rgba(0,0,0,0.35));
      transition: width 0.28s ${NOTCH_EASE}, height 0.28s ${NOTCH_EASE},
                  border-radius 0.28s ${NOTCH_EASE};
    }
    /* The size animation has to clip its contents, but .badge itself can't:
       its corner fillets are pseudo-elements sitting OUTSIDE its box, and
       overflow:hidden on .badge erases them. So the clipping lives on an
       inner wrapper instead. */
    .badge-clip {
      position: relative; width: 100%; height: 100%;
      overflow: hidden; border-radius: inherit;
    }
    .badge-collapsed {
      display: flex; align-items: center; gap: 2px;
      padding: 5px 5px 7px 4px;
      transition: opacity 0.14s ease;
    }

    /* The expansion. Both sizes are explicit because neither width nor
       height can animate from one content size to another — expandForm()
       pins the collapsed pixel size just before this class lands. */
    .badge--expanded {
      width: ${NOTCH_FORM_W}px; height: ${NOTCH_FORM_H}px;
      max-width: min(${NOTCH_FORM_W}px, 92vw);
      border-radius: 0 0 20px 20px;
    }
    .badge--expanded .badge-collapsed { opacity: 0; pointer-events: none; }

    /* The concave corners where the notch meets the top edge: a square of
       notch colour on each side with a quarter-circle masked out of the
       corner facing AWAY from the bar, which leaves ink hugging the top edge
       and the bar's vertical side — so the edge curves out and back in
       rather than meeting the bar at a hard right angle. Each square is 1px
       wider than the fillet so it tucks under the bar: butted exactly
       against it, the two anti-aliased edges leave a faint vertical seam
       whenever the notch sits on a half pixel (translateX(-50%) often does). */
    .badge::before, .badge::after {
      content: ""; position: absolute; top: 0;
      width: ${NOTCH_FILLET + 1}px; height: ${NOTCH_FILLET}px;
      background: ${NOTCH_BG}; pointer-events: none;
    }
    .badge::before {
      left: -${NOTCH_FILLET}px;
      mask-image: radial-gradient(circle ${NOTCH_FILLET}px at 0 100%, transparent 0 ${NOTCH_FILLET}px, #000 ${NOTCH_FILLET + 0.5}px);
    }
    .badge::after {
      right: -${NOTCH_FILLET}px;
      mask-image: radial-gradient(circle ${NOTCH_FILLET}px at 100% 100%, transparent 0 ${NOTCH_FILLET}px, #000 ${NOTCH_FILLET + 0.5}px);
    }

    /* Shown mid-drag while the notch is sitting in the centre snap zone. */
    .badge.badge--snapped { filter: drop-shadow(0 2px 6px rgba(0,0,0,0.35)) brightness(1.35); }

    /* Always visible, not hover-revealed: the notch is small enough that
       hunting for a control that only appears on hover costs more than the
       two icons cost in space. */
    .icon-btn {
      border: none; background: transparent; color: #7c7c86; cursor: pointer;
      padding: 3px; border-radius: 6px; display: inline-flex;
      align-items: center; justify-content: center;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .icon-btn svg { width: 11px; height: 11px; }
    .icon-btn:hover { background: #333338; color: #fff; }

    .badge-main {
      position: relative;
      display: flex; align-items: center; gap: 7px; min-width: 0;
      border: none; background: transparent; cursor: pointer;
      padding: 3px 6px; border-radius: 7px; font-family: inherit;
      transition: background 0.12s ease;
    }
    .badge-main:hover { background: #333338; }
    .badge-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .badge-name {
      font-size: 12px; font-weight: 600; color: #f0f0f2; line-height: 1.3;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /* Laid over the name, not swapped for it — see renderBadge. */
    .badge-copied {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      border-radius: 7px;
      font-size: 11px; font-weight: 600; color: #f0f0f2; letter-spacing: 0.2px;
      background: rgba(36,36,40,0.5);
      backdrop-filter: blur(4px);
      opacity: 0; pointer-events: none;
      transition: opacity 0.12s ease;
    }
    .badge-copied--show { opacity: 1; }

    /* An unnamed session reads as a prompt, not as a name. */
    .badge-name--unnamed { color: #a8a8b0; font-weight: 500; }

    .badge-rule {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 3px; color: #4a4a52; flex-shrink: 0;
    }
    .badge-rule svg { width: 12px; height: 12px; }
    .badge-rule--lit { color: #e0c341; }

    /* --- naming form ----------------------------------------------------
       Absolutely positioned so it contributes nothing to the collapsed
       size, which is what gets measured on the way in. */
    .badge-form {
      position: absolute; inset: 0;
      display: flex; flex-direction: column; gap: 9px;
      padding: 12px 13px 14px;
      opacity: 0; pointer-events: none;
      transition: opacity 0.16s ease;
    }
    .badge--expanded .badge-form { opacity: 1; pointer-events: auto; transition-delay: 0.08s; }

    .badge-input {
      width: 100%; box-sizing: border-box;
      border: 1px solid #3a3a42; border-radius: 8px;
      background: #1b1b1f; color: #f0f0f2;
      padding: 7px 9px; font-size: 12px; font-family: inherit;
    }
    .badge-input::placeholder { color: #6b6b74; }
    .badge-input:focus { outline: none; border-color: #5b5bd6; }

    .badge-notes { resize: none; line-height: 1.35; }

    .badge-swatches { display: flex; gap: 6px; }
    .badge-swatch {
      width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid transparent; padding: 0; cursor: pointer;
      background-clip: padding-box;
      transition: transform 0.1s ease;
    }
    .badge-swatch:hover { transform: scale(1.15); }
    .badge-swatch--on { border-color: #f0f0f2; }

    .badge-actions { display: flex; gap: 7px; justify-content: flex-end; margin-top: auto; }
    .badge-btn {
      border: none; border-radius: 7px; cursor: pointer;
      padding: 6px 12px; font-size: 11px; font-weight: 600; font-family: inherit;
      background: #33333a; color: #d8d8dc;
      transition: background 0.12s ease;
    }
    .badge-btn:hover { background: #3f3f48; }
    .badge-btn--primary { background: #5b5bd6; color: #fff; }
    .badge-btn--primary:hover { background: #6a6ae0; }
  `;
})();
