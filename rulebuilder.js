const STYLE = "background:#5b5bd6;color:#fff;padding:2px 6px;border-radius:4px;font-weight:bold;";
const log = (...args) => console.log("%c[Idently][rulebuilder]", STYLE, ...args);

// This page is opened as its own small window (not inside the toolbar
// popup, which auto-closes the instant it loses focus) so the user can
// freely switch back to the actual tab — to log in, trigger a field, etc.
// — then return here to detect/test without losing the form.
const params = new URLSearchParams(location.search);
const targetTabId = Number(params.get("tabId"));
const targetDomain = params.get("domain") || "";

init();

function init() {
  document.getElementById("rbDomainDisplay").textContent = targetDomain;

  document.getElementById("cancelRuleBtn").addEventListener("click", () => window.close());
  document.getElementById("detectBtn").addEventListener("click", runDetect);
  document.getElementById("testSelectorBtn").addEventListener("click", runTest);
  document.getElementById("saveRuleBtn").addEventListener("click", saveRule);

  runDetect();
}

function setStatusEl(id, text, kind) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "rb-status" + (kind ? ` ${kind}` : "");
}

async function sendToTargetTab(action, extra) {
  if (!targetTabId) throw new Error("No target tab");
  return await browser.tabs.sendMessage(targetTabId, { action, ...extra });
}

async function runDetect() {
  setStatusEl("detectStatus", "Scanning page…");
  document.getElementById("candidatesList").classList.add("hidden");

  let res;
  try {
    res = await sendToTargetTab("idently-probe-fields");
  } catch (e) {
    log("detect failed:", e);
    setStatusEl("detectStatus", "Couldn't scan this page — try reloading the tab, or fill the selector in manually.", "error");
    return;
  }
  if (!res?.ok) {
    setStatusEl("detectStatus", res?.error || "Scan failed.", "error");
    return;
  }

  const candidates = res.candidates || [];
  renderCandidates(candidates);
  if (candidates.length) {
    setStatusEl("detectStatus", `Found ${candidates.length} possible field${candidates.length === 1 ? "" : "s"} — pick one below, or fill the selector in manually.`, "ok");
  } else {
    setStatusEl("detectStatus", "No obvious login/account fields found — fill the selector in manually.", "warn");
  }
}

function renderCandidates(list) {
  const wrap = document.getElementById("candidatesList");
  wrap.innerHTML = "";
  if (!list.length) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");

  for (const candidate of list) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "candidate-card";

    const label = document.createElement("div");
    label.className = "candidate-label";
    label.textContent = candidate.label;

    const preview = document.createElement("div");
    preview.className = "candidate-preview";
    preview.textContent = candidate.preview ? `"${candidate.preview}"` : "(empty right now)";

    card.append(label, preview);
    card.addEventListener("click", () => {
      wrap.querySelectorAll(".candidate-card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      applyCandidate(candidate);
    });
    wrap.appendChild(card);
  }
}

function applyCandidate(candidate) {
  document.getElementById("rbSelectorType").value = candidate.selectorType;
  document.getElementById("rbSelector").value = candidate.selector;
  document.getElementById("rbReadFrom").value = candidate.readFrom;
  runTest();
}

async function runTest() {
  const selectorType = document.getElementById("rbSelectorType").value;
  const selector = document.getElementById("rbSelector").value.trim();
  const readFrom = document.getElementById("rbReadFrom").value;
  const pattern = document.getElementById("rbPattern").value.trim();

  if (!selector) {
    setStatusEl("testResult", "Enter a selector first.", "warn");
    return;
  }

  setStatusEl("testResult", "Testing…");
  let res;
  try {
    res = await sendToTargetTab("idently-test-selector", { selectorType, selector, readFrom, pattern });
  } catch (e) {
    log("test failed:", e);
    setStatusEl("testResult", "Couldn't test — reload the tab and try again.", "error");
    return;
  }
  if (!res?.ok) {
    setStatusEl("testResult", res?.error || "Test failed.", "error");
    return;
  }

  if (!res.found) {
    setStatusEl("testResult", "✗ No element matched this selector.", "error");
  } else if (!res.value) {
    setStatusEl("testResult", "⚠ Element found, but it's empty right now.", "warn");
  } else if (pattern && !res.patternOk) {
    setStatusEl("testResult", `⚠ Found "${res.value}" — but it doesn't match your value pattern.`, "warn");
  } else {
    setStatusEl("testResult", `✓ Found "${res.value}"`, "ok");
  }
}

async function saveRule() {
  document.getElementById("rbFormError").classList.add("hidden");

  const selector = document.getElementById("rbSelector").value.trim();
  const pattern = document.getElementById("rbPattern").value.trim();

  if (!selector) return showFormError("Selector is required — use Detect, or paste one in manually.");
  if (pattern) {
    try { new RegExp(pattern); }
    catch (e) { return showFormError(`Value pattern isn't a valid regex: ${e.message}`); }
  }

  const rule = {
    id: crypto.randomUUID(),
    label: document.getElementById("rbLabel").value.trim(),
    domain: targetDomain,
    pathPrefix: document.getElementById("rbPathPrefix").value.trim(),
    selectorType: document.getElementById("rbSelectorType").value,
    selector,
    readFrom: document.getElementById("rbReadFrom").value,
    pattern,
    shortLabel: document.getElementById("rbShortLabel").value.trim()
  };

  const { siteRules } = await browser.storage.sync.get("siteRules");
  const rules = Array.isArray(siteRules) ? siteRules : [];
  rules.push(rule);
  await browser.storage.sync.set({ siteRules: rules });
  log("saved site rule:", rule);

  setStatusEl("rbSaveStatus", "Saved ✓ — closing…", "ok");
  setTimeout(() => window.close(), 1100);
}

function showFormError(text) {
  const el = document.getElementById("rbFormError");
  el.textContent = text;
  el.classList.remove("hidden");
}
