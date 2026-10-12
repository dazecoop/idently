const COLORS = ["blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple"];

const STYLE = "background:#16a34a;color:#fff;padding:2px 6px;border-radius:4px;font-weight:bold;";
const ERR_STYLE = "background:#dc2626;color:#fff;padding:2px 6px;border-radius:4px;font-weight:bold;";
const log = (...args) => console.log("%c[Idently][background]", STYLE, ...args);
const logError = (...args) => console.error("%c[Idently][background] ERROR", ERR_STYLE, ...args);

async function getIdentities() {
  const { identities = {} } = await browser.storage.local.get("identities");
  return identities;
}

async function setIdentities(identities) {
  await browser.storage.local.set({ identities });
}

// Several message handlers below do read-modify-write on the same
// `identities` record (confirmIdentity, cleanupUnnamed, openIdentityTab,
// etc.), and messages can genuinely overlap — e.g. auto-naming confirms a
// session right as the popup opens and fires its own opportunistic
// cleanupUnnamed. Without serializing them, two overlapping calls can each
// read the same pre-write snapshot and the second one's write clobbers the
// first's (a classic lost update — the symptom was a container renamed
// correctly but the session never showing up in the list). Every mutation
// now goes through this queue so only one read-modify-write cycle for
// `identities` is ever in flight at a time.
let identitiesQueue = Promise.resolve();

function withIdentities(mutator) {
  const run = identitiesQueue.then(async () => {
    const identities = await getIdentities();
    const result = await mutator(identities);
    await setIdentities(identities);
    return result;
  });
  identitiesQueue = run.then(() => {}, () => {});
  return run;
}

browser.contextualIdentities.onRemoved.addListener(({ contextualIdentity }) =>
  withIdentities((identities) => { delete identities[contextualIdentity.cookieStoreId]; })
);

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

// Site rules are user-editable data (see the extension's Settings page).
// Each rule: { id, label, domain, pathPrefix, selectorType, selector,
// readFrom, pattern, shortLabel }. The sidebar uses them for auto-naming; here the
// optional shortLabel shortens the native container name's domain prefix
// (purely cosmetic — what you see in about:preferences#containers).
const DEFAULT_SITE_RULES = [
  {
    id: "cloudflare",
    label: "Cloudflare",
    domain: "dash.cloudflare.com",
    pathPrefix: "",
    selectorType: "xpath",
    selector: '//*[@id="email"]',
    readFrom: "value",
    pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
    shortLabel: "CF"
  }
];

// Site rules and preferences live in storage.sync so they follow the user
// across machines via Firefox Sync. Session metadata (identities) stays
// local — it's keyed by cookieStoreId, which only exists on this machine;
// export/import covers full migration. Seed/migrate once, never overwrite.
(async () => {
  const [{ siteRules: syncRules }, { siteRules: localRules }] = await Promise.all([
    browser.storage.sync.get("siteRules"),
    browser.storage.local.get("siteRules")
  ]);
  if (!Array.isArray(syncRules)) {
    const seed = Array.isArray(localRules) ? localRules : DEFAULT_SITE_RULES;
    await browser.storage.sync.set({ siteRules: seed });
    log(Array.isArray(localRules) ? "migrated site rules to sync storage" : "seeded default site rules to sync storage");
  }
  if (Array.isArray(localRules)) {
    await browser.storage.local.remove("siteRules");
  }
})();

async function getSiteRules() {
  const { siteRules } = await browser.storage.sync.get("siteRules");
  return Array.isArray(siteRules) ? siteRules : [];
}

async function containerName(domain, name) {
  const rules = await getSiteRules();
  const rule = rules.find((r) => r.domain === domain && r.shortLabel);
  return `${rule ? rule.shortLabel : domain} - ${name}`;
}

// contextualIdentities.update() can silently fail (e.g. a stale/removed
// cookieStoreId from earlier testing) and — since nothing was awaiting the
// rejection — the error used to just vanish as an unhandled promise
// rejection buried in page noise, leaving storage saying "confirmed" while
// the real Firefox container still showed its old name. This wraps it,
// logs loudly on failure, and verifies the rename actually took.
async function renameContainer(cookieStoreId, domain, name, color) {
  const newName = await containerName(domain, name);
  try {
    await browser.contextualIdentities.update(cookieStoreId, { name: newName, color, icon: "fingerprint" });
  } catch (e) {
    logError(`contextualIdentities.update(${cookieStoreId}) threw — container was likely removed or never existed:`, e);
    return false;
  }
  const after = await browser.contextualIdentities.get(cookieStoreId).catch(() => null);
  if (!after || after.name !== newName) {
    logError(`renamed container but a re-check shows name="${after?.name}", expected "${newName}"`);
    return false;
  }
  log(`container ${cookieStoreId} renamed to "${newName}"`);
  return true;
}

function cookieUrl(cookie) {
  const domain = (cookie.domain || "").replace(/^\./, "");
  return `${cookie.secure ? "https" : "http"}://${domain}${cookie.path || "/"}`;
}

async function setCookieInStore(cookie, toStoreId, url) {
  const details = {
    url: url || cookieUrl(cookie),
    storeId: toStoreId,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate
  };
  if (!cookie.hostOnly) details.domain = cookie.domain;
  try { await browser.cookies.set(details); } catch (e) {
    // individual cookie failed to restore (e.g. secure cookie on an http url) — skip it
  }
}

async function groupTabWithDomain(domain, tabId, windowId) {
  try {
    // Scoped to this tab's own window — a group is only ever a group within
    // one window, so matching a same-titled group in another window would
    // silently drag the tab there (including onto another monitor).
    const groups = await browser.tabGroups.query({ title: domain, windowId });
    if (groups.length > 0) {
      await browser.tabs.group({ tabIds: [tabId], groupId: groups[0].id });
      return;
    }
    const groupId = await browser.tabs.group({ tabIds: [tabId] });
    await browser.tabGroups.update(groupId, { title: domain, color: "grey" });
  } catch (e) {
    // tabGroups unsupported on this Firefox version — tab still opens normally, just ungrouped
  }
}

browser.runtime.onMessage.addListener((msg, sender) => handleMessage(msg, sender));

async function handleMessage(msg, sender) {
  switch (msg.action) {
    case "getTabContext": {
      const tab = sender.tab;
      let domain = "", origin = "";
      try {
        const u = new URL(tab.url);
        domain = u.host; // includes port, e.g. localhost:5050
        origin = u.origin;
      } catch {}
      return { cookieStoreId: tab.cookieStoreId, tabId: tab.id, url: tab.url, domain, origin };
    }

    case "getIdentities": {
      return await getIdentities();
    }

    case "confirmIdentity": {
      const { cookieStoreId, name, notes, color } = msg;
      log("confirmIdentity", { cookieStoreId, name, notes, color });
      let domain;
      await withIdentities((identities) => {
        domain = identities[cookieStoreId]?.domain;
        identities[cookieStoreId] = {
          ...identities[cookieStoreId], name, notes, color, confirmed: true, lastUsedAt: Date.now()
        };
      });
      await renameContainer(cookieStoreId, domain, name, color);
      return { ok: true };
    }

    case "updateIdentity": {
      // domain is optional — omitted, it's left as-is (sidebar's own edit
      // form only ever touches name/notes/color). When given, it lets a
      // session be moved into a different group, e.g. merging a duplicate
      // "account.proton.me" session into the "proton.me" one.
      const { cookieStoreId, name, notes, color, domain } = msg;
      let effectiveDomain;
      await withIdentities((identities) => {
        effectiveDomain = domain || identities[cookieStoreId]?.domain;
        identities[cookieStoreId] = { ...identities[cookieStoreId], name, notes, color, domain: effectiveDomain };
      });
      await renameContainer(cookieStoreId, effectiveDomain, name, color);
      return { ok: true };
    }

    case "removeIdentity": {
      const { cookieStoreId } = msg;
      await withIdentities((identities) => { delete identities[cookieStoreId]; });
      try { await browser.contextualIdentities.remove(cookieStoreId); } catch {}
      return { ok: true };
    }

    case "createNewIdentity": {
      const { domain, origin } = msg;
      const url = `${origin || "https://" + domain}/`;
      const color = randomColor();
      const container = await browser.contextualIdentities.create({
        name: await containerName(domain, "Unnamed"), color, icon: "fingerprint"
      });
      await withIdentities((identities) => {
        identities[container.cookieStoreId] = {
          name: "", notes: "", color, domain, url,
          confirmed: false, createdAt: Date.now(), lastUsedAt: Date.now()
        };
      });
      const newTab = await browser.tabs.create({ url, cookieStoreId: container.cookieStoreId });
      await groupTabWithDomain(domain, newTab.id, newTab.windowId);
      return { ok: true, cookieStoreId: container.cookieStoreId };
    }

    case "cleanupUnnamed": {
      // Housekeeping for abandoned "+ New session tab" clicks that never
      // got named. Run on-demand (popup open / sidebar expand) rather than
      // on a timer. Closes any tabs still open in those containers too —
      // except whichever tab triggered this cleanup, so we never yank the
      // tab out from under whoever just opened the popup/sidebar. The
      // decision of which sessions are still unconfirmed is made atomically
      // with deleting them from storage (via withIdentities), so a
      // same-moment confirmIdentity can never get silently undone by this.
      const { excludeCookieStoreId } = msg;
      const removedIds = await withIdentities((identities) => {
        const ids = [];
        for (const [cookieStoreId, record] of Object.entries(identities)) {
          if (record.confirmed || cookieStoreId === excludeCookieStoreId) continue;
          ids.push(cookieStoreId);
          delete identities[cookieStoreId];
        }
        return ids;
      });
      for (const cookieStoreId of removedIds) {
        const staleTabs = await browser.tabs.query({ cookieStoreId });
        for (const t of staleTabs) {
          try { await browser.tabs.remove(t.id); } catch {}
        }
        try { await browser.contextualIdentities.remove(cookieStoreId); } catch {}
      }
      if (removedIds.length > 0) log(`cleanupUnnamed: removed ${removedIds.length} abandoned pending session(s)`);
      return { ok: true, removed: removedIds.length };
    }

    case "openIdentityTab": {
      const { cookieStoreId, url } = msg;
      let domain;
      await withIdentities((identities) => {
        domain = identities[cookieStoreId]?.domain;
        if (identities[cookieStoreId]) identities[cookieStoreId].lastUsedAt = Date.now();
      });
      const newTab = await browser.tabs.create({ url, cookieStoreId });
      if (domain) await groupTabWithDomain(domain, newTab.id, newTab.windowId);
      return { ok: true };
    }

    case "sessionHealth": {
      // "Logged out" heuristic: a session whose container holds zero cookies
      // for its own domain almost certainly has no live login. Cookies that
      // exist might still be expired server-side, so this only flags the
      // clear-cut case; expired-at-the-browser cookies are already purged
      // from getAll results.
      const identities = await getIdentities();
      const health = {};
      for (const [cookieStoreId, record] of Object.entries(identities)) {
        if (!record.confirmed) continue;
        const hostname = (record.domain || "").split(":")[0];
        try {
          const cookies = await browser.cookies.getAll({ storeId: cookieStoreId });
          health[cookieStoreId] = cookies.some((c) => {
            const cd = (c.domain || "").replace(/^\./, "");
            return hostname === cd || hostname.endsWith("." + cd) || cd.endsWith("." + hostname);
          });
        } catch (e) {
          health[cookieStoreId] = true; // unknown — don't flag
        }
      }
      return health;
    }

    case "exportData": {
      const { includeCookies } = msg;
      const identities = await getIdentities();
      const payload = { version: 1, exportedAt: new Date().toISOString(), identities };
      if (includeCookies) {
        const cookiesByStore = {};
        for (const cookieStoreId of Object.keys(identities)) {
          try {
            cookiesByStore[cookieStoreId] = await browser.cookies.getAll({ storeId: cookieStoreId });
          } catch (e) {
            cookiesByStore[cookieStoreId] = [];
          }
        }
        payload.cookies = cookiesByStore;
      }
      return payload;
    }

    case "importData": {
      const { data } = msg;
      let imported = 0, skipped = 0;
      const newEntries = {};

      for (const [oldCookieStoreId, record] of Object.entries(data.identities || {})) {
        if (!record || !record.domain) { skipped++; continue; }

        const container = await browser.contextualIdentities.create({
          name: await containerName(record.domain, record.name || "Unnamed"),
          color: record.color || randomColor(),
          icon: "fingerprint"
        });
        newEntries[container.cookieStoreId] = {
          name: record.name || "", notes: record.notes || "", color: container.color,
          domain: record.domain, url: record.url, confirmed: record.confirmed !== false,
          createdAt: record.createdAt || Date.now()
        };

        const cookies = data.cookies?.[oldCookieStoreId];
        if (Array.isArray(cookies)) {
          for (const cookie of cookies) {
            await setCookieInStore(cookie, container.cookieStoreId);
          }
        }
        imported++;
      }

      await withIdentities((identities) => { Object.assign(identities, newEntries); });
      return { ok: true, imported, skipped };
    }

    default:
      return undefined;
  }
}
