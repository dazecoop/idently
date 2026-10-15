const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  edit: `<svg ${SVG_ATTRS}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  close: `<svg ${SVG_ATTRS}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
};

let rules = [];
let editingId = null;

init();

async function init() {
  const { siteRules, showSidebar } = await browser.storage.sync.get(["siteRules", "showSidebar"]);
  rules = Array.isArray(siteRules) ? siteRules : [];
  renderRules();

  const sidebarCheck = document.getElementById("showSidebarCheck");
  sidebarCheck.checked = showSidebar !== false; // default true
  sidebarCheck.addEventListener("change", async () => {
    await browser.storage.sync.set({ showSidebar: sidebarCheck.checked });
    setStatus(sidebarCheck.checked ? "Sidebar enabled." : "Sidebar hidden on all pages.");
  });

  document.getElementById("addRuleBtn").addEventListener("click", () => openForm(null));
  document.getElementById("cancelRuleBtn").addEventListener("click", closeForm);
  document.getElementById("saveRuleBtn").addEventListener("click", saveRule);
  document.getElementById("exportBtn").addEventListener("click", exportData);
  document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFile").click());
  document.getElementById("importFile").addEventListener("change", importData);
  document.getElementById("exportRulesBtn").addEventListener("click", exportRules);
  document.getElementById("importRulesBtn").addEventListener("click", () => document.getElementById("importRulesFile").click());
  document.getElementById("importRulesFile").addEventListener("change", importRules);

  // Rules can also be created from the popup's "Create rule for this site"
  // window, which may well be open at the same time as this page — reflect
  // that immediately instead of waiting for a manual reload.
  browser.storage.onChanged.addListener((changes) => {
    if (changes.siteRules) {
      rules = Array.isArray(changes.siteRules.newValue) ? changes.siteRules.newValue : [];
      if (!document.getElementById("ruleForm").classList.contains("hidden")) {
        // Don't yank the form out from under an in-progress edit.
        return;
      }
      renderRules();
    }
    if (changes.showSidebar) {
      sidebarCheck.checked = changes.showSidebar.newValue !== false;
    }
  });
}

// --- Site rules export / import -----------------------------------------
// Separate from the Backup section below, which deals in sessions and their
// cookies. Rules are small, contain no credentials and are the thing worth
// sharing between people or profiles, so they get their own plain file.

const RULES_FILE_TYPE = "idently-site-rules";

function setRulesBackupStatus(text) {
  document.getElementById("rulesBackupStatus").textContent = text;
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportRules() {
  if (rules.length === 0) {
    setRulesBackupStatus("Nothing to export — no site rules yet.");
    return;
  }
  downloadJson(
    { type: RULES_FILE_TYPE, version: 1, exportedAt: new Date().toISOString(), rules },
    `idently-site-rules-${new Date().toISOString().slice(0, 10)}.json`
  );
  setRulesBackupStatus(`Exported ${rules.length} rule${rules.length === 1 ? "" : "s"}.`);
}

// Accepts our own export, a bare array of rules, or a full backup file that
// happens to carry a siteRules key — all three are things someone might
// reasonably drop in here.
function extractRules(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rules)) return data.rules;
  if (Array.isArray(data?.siteRules)) return data.siteRules;
  return null;
}

// Rules drive a content script that queries the page, so a malformed one is
// worth dropping rather than storing: anything without a domain + selector
// can never match, and a broken regex would throw on every page load.
function sanitizeRule(raw) {
  if (!raw || typeof raw !== "object") return null;
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

  const domain = str(raw.domain, 200);
  const selector = str(raw.selector, 500);
  if (!domain || !selector) return null;

  const pattern = str(raw.pattern, 300);
  if (pattern) {
    try { new RegExp(pattern); } catch { return null; }
  }

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
    label: str(raw.label, 60),
    domain,
    pathPrefix: str(raw.pathPrefix, 200),
    selectorType: raw.selectorType === "css" ? "css" : "xpath",
    selector,
    readFrom: raw.readFrom === "text" ? "text" : "value",
    pattern,
    shortLabel: str(raw.shortLabel, 20)
  };
}

async function importRules(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  let incoming;
  try {
    incoming = extractRules(JSON.parse(await file.text()));
  } catch {
    setRulesBackupStatus("Import failed — not a valid JSON file.");
    return;
  }
  if (!incoming) {
    setRulesBackupStatus("Import failed — no site rules found in that file.");
    return;
  }

  // Merge rather than replace, so importing someone else's rules can't wipe
  // your own. A rule with a known id updates in place; one that matches an
  // existing rule on domain + path + selector is a duplicate and skipped
  // (re-importing the same file twice shouldn't double the list).
  const merged = rules.slice();
  const indexById = new Map(merged.map((r, i) => [r.id, i]));
  const sameTarget = (a, b) =>
    a.domain === b.domain && a.pathPrefix === b.pathPrefix && a.selector === b.selector;

  let added = 0, updated = 0, skipped = 0, invalid = 0;
  for (const raw of incoming) {
    const rule = sanitizeRule(raw);
    if (!rule) { invalid++; continue; }

    const existingIdx = indexById.get(rule.id);
    if (existingIdx !== undefined) {
      merged[existingIdx] = rule;
      updated++;
      continue;
    }
    if (merged.some((r) => sameTarget(r, rule))) { skipped++; continue; }

    indexById.set(rule.id, merged.length);
    merged.push(rule);
    added++;
  }

  if (added || updated) {
    rules = merged;
    await browser.storage.sync.set({ siteRules: rules });
    renderRules();
  }

  const parts = [];
  if (added) parts.push(`added ${added}`);
  if (updated) parts.push(`updated ${updated}`);
  if (skipped) parts.push(`skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}`);
  if (invalid) parts.push(`ignored ${invalid} invalid`);
  setRulesBackupStatus(parts.length ? `Imported: ${parts.join(", ")}.` : "Nothing to import — that file had no usable rules.");
}

function setBackupStatus(text) {
  document.getElementById("backupStatus").textContent = text;
}

async function exportData() {
  const includeCookies = document.getElementById("includeCookiesCheck").checked;
  setBackupStatus("Exporting…");
  const payload = await browser.runtime.sendMessage({ action: "exportData", includeCookies });

  downloadJson(payload, `idently-export-${new Date().toISOString().slice(0, 10)}.json`);

  const count = Object.keys(payload.identities || {}).length;
  setBackupStatus(`Exported ${count} session${count === 1 ? "" : "s"}${includeCookies ? " with cookies" : ""}.`);
}

async function importData(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    setBackupStatus("Import failed — not a valid export file.");
    return;
  }

  setBackupStatus("Importing…");
  const result = await browser.runtime.sendMessage({ action: "importData", data });
  setBackupStatus(
    `Imported ${result.imported}${result.skipped ? `, skipped ${result.skipped}` : ""}. New containers created — reload any open tabs to use them.`
  );
}

async function persist() {
  await browser.storage.sync.set({ siteRules: rules });
  setStatus("Saved.");
}

function setStatus(text) {
  const el = document.getElementById("status");
  el.textContent = text;
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 2500);
}

function renderRules() {
  const listEl = document.getElementById("rulesList");
  const emptyEl = document.getElementById("rulesEmpty");
  listEl.innerHTML = "";

  if (rules.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  for (const rule of rules) {
    const card = document.createElement("div");
    card.className = "rule-card";

    const info = document.createElement("div");
    info.className = "rule-info";

    const title = document.createElement("div");
    title.className = "rule-title";
    title.textContent = rule.label || rule.domain;
    if (rule.shortLabel) {
      const badge = document.createElement("span");
      badge.className = "rule-badge";
      badge.textContent = rule.shortLabel;
      title.appendChild(badge);
    }

    const domain = document.createElement("div");
    domain.className = "rule-domain";
    domain.textContent = rule.domain + (rule.pathPrefix ? ` · path starts with ${rule.pathPrefix}` : "");

    const selector = document.createElement("div");
    selector.className = "rule-selector";
    selector.textContent = `${rule.selectorType === "css" ? "CSS" : "XPath"}: ${rule.selector} → ${rule.readFrom === "text" ? "text" : "value"}${rule.pattern ? ` · pattern: ${rule.pattern}` : ""}`;

    info.append(title, domain, selector);

    const actions = document.createElement("div");
    actions.className = "rule-actions";
    actions.append(
      mkIconBtn("edit", "Edit rule", () => openForm(rule.id)),
      mkIconBtn("close", "Delete rule", () => deleteRule(rule.id), true)
    );

    card.append(info, actions);
    listEl.appendChild(card);
  }
}

function mkIconBtn(icon, title, onClick, danger) {
  const btn = document.createElement("button");
  btn.className = "icon-btn" + (danger ? " danger" : "");
  btn.title = title;
  btn.innerHTML = ICONS[icon];
  btn.addEventListener("click", onClick);
  return btn;
}

function openForm(id) {
  editingId = id;
  const rule = id ? rules.find((r) => r.id === id) : null;

  document.getElementById("fLabel").value = rule?.label || "";
  document.getElementById("fDomain").value = rule?.domain || "";
  document.getElementById("fPathPrefix").value = rule?.pathPrefix || "";
  document.getElementById("fShortLabel").value = rule?.shortLabel || "";
  document.getElementById("fSelectorType").value = rule?.selectorType || "xpath";
  document.getElementById("fSelector").value = rule?.selector || "";
  document.getElementById("fReadFrom").value = rule?.readFrom || "value";
  document.getElementById("fPattern").value = rule?.pattern || "";

  document.getElementById("formError").classList.add("hidden");
  document.getElementById("ruleForm").classList.remove("hidden");
  document.getElementById("fLabel").focus();
}

function closeForm() {
  editingId = null;
  document.getElementById("ruleForm").classList.add("hidden");
}

function showError(text) {
  const el = document.getElementById("formError");
  el.textContent = text;
  el.classList.remove("hidden");
}

async function saveRule() {
  const domain = document.getElementById("fDomain").value.trim();
  const selector = document.getElementById("fSelector").value.trim();
  const pattern = document.getElementById("fPattern").value.trim();

  if (!domain) return showError("Domain is required.");
  if (!selector) return showError("Selector is required.");
  if (pattern) {
    try { new RegExp(pattern); }
    catch (e) { return showError(`Value pattern isn't a valid regex: ${e.message}`); }
  }

  const data = {
    id: editingId || crypto.randomUUID(),
    label: document.getElementById("fLabel").value.trim(),
    domain,
    pathPrefix: document.getElementById("fPathPrefix").value.trim(),
    selectorType: document.getElementById("fSelectorType").value,
    selector,
    readFrom: document.getElementById("fReadFrom").value,
    pattern,
    shortLabel: document.getElementById("fShortLabel").value.trim()
  };

  if (editingId) {
    const idx = rules.findIndex((r) => r.id === editingId);
    if (idx !== -1) rules[idx] = data;
  } else {
    rules.push(data);
  }

  await persist();
  closeForm();
  renderRules();
}

async function deleteRule(id) {
  rules = rules.filter((r) => r.id !== id);
  await persist();
  renderRules();
}
