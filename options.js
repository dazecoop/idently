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
}

function setBackupStatus(text) {
  document.getElementById("backupStatus").textContent = text;
}

async function exportData() {
  const includeCookies = document.getElementById("includeCookiesCheck").checked;
  setBackupStatus("Exporting…");
  const payload = await browser.runtime.sendMessage({ action: "exportData", includeCookies });

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `idently-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

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
