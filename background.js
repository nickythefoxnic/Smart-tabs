// background.js v6.38 — Claude + ChatGPT group redirect and binding
const STORAGE_KEY = 'mappings';
const hasGroup = (groupId) => Number.isInteger(groupId) && groupId !== -1;

// ========== In-memory cache ==========
let cachedMappings = {};       // groupName → mapping
let groupIdIndex = {};         // groupId   → { projectUrl, groupName }

// Debounced storage save — avoids burst writes during session restore
let storageSaveTimer = null;
function debouncedSaveMappings() {
  if (storageSaveTimer) clearTimeout(storageSaveTimer);
  storageSaveTimer = setTimeout(async () => {
    storageSaveTimer = null;
    try { await chrome.storage.sync.set({ [STORAGE_KEY]: cachedMappings }); } catch (_) {}
  }, 2000);
}

function rebuildIndex(mappings) {
  groupIdIndex = {};
  for (const [, val] of Object.entries(mappings)) {
    if (hasGroup(val.groupId)) groupIdIndex[val.groupId] = {
      projectUrl: val.projectUrl,
      groupName: val.groupName
    };
  }
}

async function loadMappings() {
  try {
    const data = await chrome.storage.sync.get(STORAGE_KEY);
    cachedMappings = data[STORAGE_KEY] || {};
    rebuildIndex(cachedMappings);
  } catch (_) { cachedMappings = {}; groupIdIndex = {}; }
}

// ========== Rebuild groupIdIndex from live tab groups ==========
// Chrome assigns NEW groupIds to restored tab groups on restart.
// This function matches stored mappings to live groups by NAME,
// updating stale groupIds so redirect works immediately after restart.
async function rebuildIndexFromLiveGroups() {
  try {
    const allGroups = await chrome.tabGroups.query({});
    let updated = 0;
    for (const group of allGroups) {
      const title = (group.title || '').trim();
      if (!title) continue;
      for (const [key, val] of Object.entries(cachedMappings)) {
        const mapName = (val.groupName || '').trim();
        if (mapName === title || key === title) {
          if (val.groupId !== group.id) {
            val.groupId = group.id;
            updated++;
          }
          break;
        }
      }
    }
    if (updated > 0) {
      await chrome.storage.sync.set({ [STORAGE_KEY]: cachedMappings });
      rebuildIndex(cachedMappings);
    }
  } catch (_) {}
}

// Shared initial read: reuse the boot-time read rather than racing another
// storage.sync.get() on the first user-created tab after SW cold start.
let initialMappingsReady = loadMappings();
void initialMappingsReady.then(() => rebuildIndexFromLiveGroups());

// Also rebuild on browser startup — re-arm redirect suppress to protect session restore
chrome.runtime.onStartup.addListener(() => {
  startupRedirectSuppress = true;
  setTimeout(() => { startupRedirectSuppress = false; }, 8000);
  initialMappingsReady = loadMappings();
  void initialMappingsReady.then(() => rebuildIndexFromLiveGroups());
});chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[STORAGE_KEY]) {
    cachedMappings = changes[STORAGE_KEY].newValue || {};
    rebuildIndex(cachedMappings);
  }
});

// ========== Utility functions ==========

function normalizeEmoji(str) {
  if (!str) return str;
  return str.replace(/\u200D[\u2640\u2642]\uFE0F?/g, '');
}

function cleanName(raw) {
  if (!raw) return '';
  let s = raw.trim();
  s = s.replace(/^(?:Project\s*[,，、]\s*|Project\s+)/gi, '');
  if (/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}$/i.test(s)) return '';
  s = s.replace(/\s*[-—|]\s*[Uu]pdated\s.*$/gi, '');
  s = s.replace(/\b[Uu]pdated\s.*$/gi, '');
  s = s.replace(/Updated\s+\w+\s+\d{1,2}\s*$/gi, '');
  s = s.replace(/\s+\|\s*\d+\s+(?:days?|weeks?|months?|hours?)\s+ago.*$/gi, '');
  s = s.replace(/\uFFFD/g, '');
  s = normalizeEmoji(s);
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[,，、\s]+|[,，、\s]+$/g, '');
  return s.length >= 1 ? s : raw.trim();
}

// ========== URL helpers (Claude + ChatGPT, v6.17) ==========
// v6.22: ChatGPT project ids are 24-char hex ("g-p-<hex>"). Require >=16 hex
// chars so truncated/garbage ids (e.g. "g-p-6a6bca2ae", 9 chars) can never be
// redirected to — those produce ChatGPT 404 pages.
function isRedirectableProjectUrl(url) {
  return /^https:\/\/claude\.ai\/project\//.test(url || '') ||
         /^https:\/\/chatgpt\.com\/g\/g-p-[0-9a-f]{16,}/i.test(url || '');
}

// ========== Fuzzy group-name matching (v6.18) ==========
// 组名常带 emoji 前缀或长后缀（如 "🏦 Finance | 资产 | 财务 | 金融"），
// 映射名可能是简称（如 "Finance"），按 精确 → 归一化 → 包含 三级匹配
function normalizeTitle(t) {
  return (t || '').trim().replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findMappingByTitle(mappings, title) {
  if (!title || !mappings) return null;
  // Explicit bindings only: exact group title first; never substring-match projects.
  const raw = title.trim();
  const exact = Object.entries(mappings).filter(([key, val]) => val &&
    ((val.groupName || '').trim() === raw || key.trim() === raw));
  if (exact.length === 1) return exact[0][1];
  if (exact.length > 1) {
    const urls = new Set(exact.map(([, val]) => val.projectUrl));
    return urls.size === 1 ? exact[0][1] : null;
  }
  // Compatible with legacy Emoji styling, but only if a single URL matches.
  const norm = normalizeTitle(raw);
  if (!norm) return null;
  const near = Object.entries(mappings).filter(([key, val]) => val &&
    (normalizeTitle(val.groupName) === norm || normalizeTitle(key) === norm));
  const urls = new Set(near.map(([, val]) => val.projectUrl));
  return urls.size === 1 ? near[0][1] : null;
}

// ========== Core: new tab redirect ==========

// Track session-restore window to suppress redirect during crash recovery
// v6.20 FIX: only arm the suppress window on real browser startup (runtime.onStartup).
// Previously it was armed at top-level of the service worker, i.e. on EVERY cold start —
// Chrome kills idle SWs after ~30s, so the next group new-tab after any idle period
// was silently suppressed for 8s (blank new tab). That was the "binding stops working
// after a while" bug.
let startupRedirectSuppress = false;

// v6.26: decision ring buffer — every redirect decision is recorded so the
// popup can show exactly why a group opened blank/404/correct.
const debugLog = [];
// Candidate performance telemetry: bounded, memory-only, no Project URLs/chat text.
const perfLog = [];
const perfNow = () => performance.now();
function perfRecord(action, phases, outcome) {
  perfLog.push({action, ...phases, outcome});
  if (perfLog.length > 48) perfLog.shift();
}
function dbgLog(line) {
  debugLog.push(new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + line);
  if (debugLog.length > 8) debugLog.shift();
}

// v6.34: extension reload does not retroactively install manifest scripts into
// already-open ChatGPT pages. v6.33 tried only once and marked even failed tabs
// as covered. Retry *per tab* on activation and full navigation; the content
// script itself is idempotent within a document.
const observerReady = new Set();
const observerPending = new Set();
async function ensureGptObserver(tabId) {
  if (!Number.isInteger(tabId) || observerReady.has(tabId) || observerPending.has(tabId)) return;
  observerPending.add(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!/^https:\/\/chatgpt\.com\//i.test(tab.url || tab.pendingUrl || '')) return;
    await chrome.scripting.executeScript({target: {tabId}, files: ['gpt404.js']});
    observerReady.add(tabId);
  } catch (err) {
    // Never mark failed injections complete; tab activation/navigation retries.
    dbgLog('ARCHIVE observer retry pending for tab ' + tabId + ': ' + String(err).slice(0, 55));
  } finally { observerPending.delete(tabId); }
}
async function installExistingGptObservers() {
  try {
    const open = await chrome.tabs.query({url: 'https://chatgpt.com/*'});
    await Promise.allSettled(open.map(tab => ensureGptObserver(tab.id)));
    dbgLog('ARCHIVE observers ready ' + observerReady.size + '/' + open.length + ' existing GPT tabs');
  } catch (err) { dbgLog('ARCHIVE observer scan error: ' + String(err).slice(0, 60)); }
}
void installExistingGptObservers();
chrome.tabs.onActivated.addListener(({tabId}) => { void ensureGptObserver(tabId); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') observerReady.delete(tabId);
  if (changeInfo.status === 'complete' && /^https:\/\/chatgpt\.com\//i.test(tab?.url || '')) {
    void ensureGptObserver(tabId);
  }
});

// Chrome's native new-tab surface is an explicit, browser-owned URL.
// Never classify an empty/about:blank tab as native: delayed window.open and
// ordinary links can start with no URL at tabs.onCreated time.
const isNativeChromeNewTab = url => /^chrome:\/\/newtab\/?$/i.test(url || '');
const lateGroupTabs = new Map(); // tabId -> {windowId, createdAt}

chrome.tabs.onCreated.addListener(async (tab) => {
  const t0 = perfNow();
  if (!hasGroup(tab.groupId)) {
    lateGroupTabs.set(tab.id, {windowId: tab.windowId, createdAt: perfNow()});
    dbgLog('NEW TAB pending late group assignment: ' + tab.id);
    return;
  }

  // Keep v6.30 false-positive guard. Link/window.open may acquire a URL shortly
  // after onCreated, and openerTabId cannot distinguish it from the group +.
  if (tab.pendingUrl && /^https?:\/\//.test(tab.pendingUrl)) return;
  if (tab.url && /^https?:\/\//.test(tab.url)) return;
  if (tab.openerTabId !== undefined) dbgLog('opener-spawned (still eligible)');
  if (startupRedirectSuppress) { dbgLog('SKIP startup-suppress'); return; }

  // Begin the original 500 ms conservative waiting period immediately. Mapping
  // read and group-name repair can run concurrently with it; no guard is removed.
  const safetyGate = new Promise(resolve => setTimeout(resolve, 500));
  const coldCache = Object.keys(cachedMappings).length === 0;
  if (coldCache) await initialMappingsReady;
  const tMapping = perfNow();

  let entry = groupIdIndex[tab.groupId];
  if (!entry) {
    try {
      const group = await chrome.tabGroups.get(tab.groupId);
      if (group && group.title) {
        const val = findMappingByTitle(cachedMappings, group.title);
        if (val) {
          entry = {projectUrl: val.projectUrl, groupName: val.groupName};
          val.groupId = tab.groupId;
          groupIdIndex[tab.groupId] = entry;
          debouncedSaveMappings();
        }
      }
    } catch (_) {}
  }
  const tResolved = perfNow();

  if (!entry?.projectUrl || !isRedirectableProjectUrl(entry.projectUrl)) {
    dbgLog('BLANK: group has no valid Project binding');
    perfRecord('group-plus', {mappingMs: Math.round(tMapping-t0), lookupMs: Math.round(tResolved-tMapping)}, 'unbound');
    return;
  }
  // Safe fast path: only a verifiable native chrome://newtab (not an empty
  // URL) may bypass the 500ms late-navigation guard. This is conservative on
  // purpose: Chrome does not guarantee URL/group presence at onCreated.
  // If Chrome hides the native URL, retain the original 500ms behavior.
  let path = 'guarded-500ms';
  if (tab.openerTabId === undefined) {
    if (!isNativeChromeNewTab(tab.url) && !isNativeChromeNewTab(tab.pendingUrl)) {
      // Give Chrome a tiny chance to populate the NTP URL, without blocking
      // the conservative safety timer or mapping/lookup work.
      await new Promise(resolve => setTimeout(resolve, 55));
    }
    try {
      const candidate = await chrome.tabs.get(tab.id);
      if (candidate.groupId === tab.groupId && candidate.windowId === tab.windowId &&
          candidate.active === true && candidate.openerTabId === undefined &&
          (isNativeChromeNewTab(candidate.url) || isNativeChromeNewTab(candidate.pendingUrl)) &&
          (!candidate.url || isNativeChromeNewTab(candidate.url)) &&
          (!candidate.pendingUrl || isNativeChromeNewTab(candidate.pendingUrl))) {
        path = 'native-newtab-fast';
      }
    } catch (_) { /* deleted tab: original guard/get below will fail closed */ }
  }
  if (path !== 'native-newtab-fast') await safetyGate;
  const tGuard = perfNow();
  let fresh;
  try { fresh = await chrome.tabs.get(tab.id); }
  catch (_) { perfRecord('group-plus', {totalMs: Math.round(perfNow()-t0), path}, 'tab-gone'); return; }
  // Fast path must still match the exact browser NTP URL at the final write.
  // Any intervening navigation, link, move, or opener cancels the redirect.
  if (fresh.groupId !== tab.groupId || fresh.windowId !== tab.windowId ||
      (fresh.url && /^https?:\/\//.test(fresh.url)) ||
      (fresh.pendingUrl && /^https?:\/\//.test(fresh.pendingUrl)) ||
      (path === 'native-newtab-fast' &&
       (fresh.active !== true || fresh.openerTabId !== undefined ||
        !(isNativeChromeNewTab(fresh.url) || isNativeChromeNewTab(fresh.pendingUrl)) ||
        (fresh.url && !isNativeChromeNewTab(fresh.url)) ||
        (fresh.pendingUrl && !isNativeChromeNewTab(fresh.pendingUrl))))) {
    dbgLog('SKIP tab moved or self-navigated');
    perfRecord('group-plus', {totalMs: Math.round(perfNow()-t0), path}, 'self-navigation-or-moved');
    return;
  }
  try {
    await chrome.tabs.update(tab.id, {url: entry.projectUrl});
    perfRecord('group-plus', {
      mappingMs: Math.round(tMapping-t0), lookupMs: Math.round(tResolved-tMapping),
      gateMs: Math.round(tGuard-t0), updateMs: Math.round(perfNow()-tGuard),
      totalMs: Math.round(perfNow()-t0), coldCache, path
    }, 'navigation-started');
  } catch (_) {
    perfRecord('group-plus', {totalMs: Math.round(perfNow()-t0), path}, 'update-failed');
  }
});

// ========== Tab group title change → sync mapping ==========
chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (!Object.prototype.hasOwnProperty.call(changes, 'groupId') || !hasGroup(tab?.groupId)) return;
  const pending = lateGroupTabs.get(tabId);
  if (!pending || pending.windowId !== tab.windowId) return;
  lateGroupTabs.delete(tabId);
  // Re-enter only after Chrome has supplied a real groupId; the normal handler
  // retains its 500ms safety gate for ambiguous navigations.
  void chrome.tabs.get(tabId).then(fresh => {
    if (!isNativeChromeNewTab(fresh.url) && !isNativeChromeNewTab(fresh.pendingUrl)) return;
    return chrome.tabGroups.get(fresh.groupId).then(group => {
      const entry = findMappingByTitle(cachedMappings, group?.title || '');
      if (!entry?.projectUrl || !isRedirectableProjectUrl(entry.projectUrl)) return;
      return chrome.tabs.update(tabId, {url: entry.projectUrl}).then(() => {
        perfRecord('group-plus-late-group', {totalMs: Math.round(perfNow() - pending.createdAt)}, 'navigation-started');
      });
    });
  }).catch(() => {});
});

chrome.tabGroups.onUpdated.addListener(async (group) => {
  if (!group?.title) return;
  try {
    const data = await chrome.storage.sync.get(STORAGE_KEY);
    const mappings = data[STORAGE_KEY] || {};
    for (const [key, val] of Object.entries(mappings)) {
      if (val.groupId === group.id) {
        const newName = cleanName(group.title);
        val.groupName = newName;
        delete mappings[key];
        mappings[newName] = val;
        await chrome.storage.sync.set({ [STORAGE_KEY]: mappings });
        cachedMappings = mappings;
        if (groupIdIndex[group.id]) groupIdIndex[group.id].groupName = newName;
        break;
      }
    }
  } catch (_) {}
});

// ========== Context menu: ONE direct Project binding action ==========
// One extension item per page prevents Chrome from nesting a multi-item submenu.
// Existing logo comes from manifest icons; no tab-group creation/recolor/rename.
const STG_BIND_MENU = 'stg-bind-project';
function parseBoundProjectUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.origin === 'https://claude.ai') {
      const m = u.pathname.match(/^\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
      if (!m) return null;
      return {projectId: m[1], projectUrl: u.origin + '/project/' + m[1], platform: 'claude'};
    }
    if (u.origin === 'https://chatgpt.com') {
      // Only a Project landing URL, never a /c/... conversation or unknown route.
      const m = u.pathname.match(/^\/g\/(g-p-[0-9a-f]{16,})(?:-[a-z0-9-]+)?(?:\/([a-z0-9-]+))?\/?$/i);
      if (!m || (m[2] && /^(?:c|chat|conversation|settings)$/i.test(m[2]))) return null;
      return {projectId: m[1], projectUrl: u.origin + u.pathname.replace(/\/$/, ''), platform: 'chatgpt'};
    }
  } catch (_) {}
  return null;
}

// Chrome retains old menu IDs across extension reloads. Rebuild exactly ONE
// visible entry at service-worker start, including after an existing install.
chrome.contextMenus.removeAll(() => {
  const removalError = chrome.runtime.lastError;
  if (removalError) { dbgLog('BIND menu reset failed: ' + removalError.message); return; }
  chrome.contextMenus.create({
    id: STG_BIND_MENU,
    title: 'Bind page to Tab',
    contexts: ['page'],
    documentUrlPatterns: ['https://claude.ai/project/*', 'https://chatgpt.com/g/*']
  }, () => {
    const err = chrome.runtime.lastError;
    if (err) dbgLog('BIND menu unavailable: ' + err.message);
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== STG_BIND_MENU || !Number.isInteger(tab?.id)) return;
  const tabId = tab.id;
  const fail = async (reason) => {
    dbgLog('BIND blocked: ' + reason);
    try { await chrome.action.setBadgeText({tabId, text: '!'}); } catch (_) {}
  };
  try {
    const fresh = await chrome.tabs.get(tabId);
    const project = parseBoundProjectUrl(fresh.url);
    if (!project || !hasGroup(fresh.groupId)) {
      await fail('open a Project inside an existing tab group first'); return;
    }
    if (info.pageUrl && new URL(info.pageUrl).pathname !== new URL(fresh.url).pathname) {
      await fail('page changed since right-click'); return;
    }
    const group = await chrome.tabGroups.get(fresh.groupId);
    const title = (group?.title || '').trim();
    if (!title || group.windowId !== fresh.windowId) {
      await fail('tab group missing/unnamed/changed'); return;
    }
    // Group title is a user-owned name. Two live groups with the same name
    // cannot share one title-keyed mapping safely; never guess which wins.
    const liveGroups = await chrome.tabGroups.query({});
    if (liveGroups.filter(g => (g.title || '').trim() === title).length !== 1) {
      await fail('duplicate live tab group names'); return;
    }
    const saved = await chrome.storage.sync.get(STORAGE_KEY);
    const mappings = saved[STORAGE_KEY] || {};
    const current = await chrome.tabs.get(tabId);
    const still = await chrome.tabGroups.get(fresh.groupId);
    if (current.groupId !== group.id || current.windowId !== fresh.windowId ||
        !parseBoundProjectUrl(current.url) || current.url !== fresh.url ||
        (still.title || '').trim() !== title) {
      await fail('tab/group changed while binding'); return;
    }
    // Only the user's explicit click writes the Project mapping, not group visuals.
    mappings[title] = {
      groupId: group.id, groupName: title,
      projectId: project.projectId, projectUrl: project.projectUrl,
      projectName: title, platform: project.platform, boundAt: Date.now()
    };
    await chrome.storage.sync.set({[STORAGE_KEY]: mappings});
    cachedMappings = mappings;
    rebuildIndex(mappings);
    dbgLog('BIND success: ' + title + ' (' + project.platform + ')');
    try { await chrome.action.setBadgeText({tabId, text: '✓'}); } catch (_) {}
  } catch (err) {
    await fail(String(err).slice(0, 70));
  }
});

// ========== Keyboard shortcut: new tab in current group ==========
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'new-tab-in-group') return;
  const t0 = perfNow();
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab) return;
    if (!hasGroup(tab.groupId)) {
      await chrome.tabs.create({windowId: tab.windowId});
      perfRecord('shortcut', {totalMs: Math.round(perfNow()-t0)}, 'ordinary-blank-tab');
      return;
    }
    let entry = groupIdIndex[tab.groupId];
    if (!entry) {
      const group = await chrome.tabGroups.get(tab.groupId);
      if (group?.title) {
        const val = findMappingByTitle(cachedMappings, group.title);
        if (val) entry = {projectUrl: val.projectUrl, groupName: val.groupName};
      }
    }
    const projectUrl = entry?.projectUrl && isRedirectableProjectUrl(entry.projectUrl)
      ? entry.projectUrl : null;
    const tResolved = perfNow();

    // This tab is explicitly owned by our command, so unlike arbitrary onCreated
    // tabs there is no need to wait for a link/window.open discrimination guard.
    const newTab = await chrome.tabs.create({
      index: tab.index + 1, windowId: tab.windowId,
      ...(projectUrl ? {url: projectUrl} : {})
    });
    const tCreated = perfNow();
    await chrome.tabs.group({groupId: tab.groupId, tabIds: newTab.id});
    perfRecord('shortcut', {
      lookupMs: Math.round(tResolved-t0), createMs: Math.round(tCreated-tResolved),
      groupMs: Math.round(perfNow()-tCreated), totalMs: Math.round(perfNow()-t0)
    }, projectUrl ? 'project-navigation-started' : 'unbound-group-tab');
  } catch (err) {
    dbgLog('shortcut failed: ' + String(err).slice(0, 50));
    perfRecord('shortcut', {totalMs: Math.round(perfNow()-t0)}, 'error');
  }
});


// v6.34 — After a native ChatGPT Archive click and an observed navigation:
//    multiple tabs in a bound group: close only the archived chat's Chrome tab;
//    final tab: reuse it for the group's bound Project page.
// Never invoke ChatGPT Archive ourselves; ignore unrelated navigation and
// fail closed when project binding, URL, tab/group identity or count is unsafe.
const archiveIntents = new Map(); // tabId -> {groupId, chatUrl, projectUrl, until}
const isChatUrl = (url) => /^https:\/\/chatgpt\.com\/(?:g\/g-p-[0-9a-f]{16,}(?:-[a-z0-9-]+)?\/)?c\/[0-9a-f-]{16,}(?:[/?#]|$)/i.test(url || '');
const projectIdFromUrl = (url) => (String(url || '').match(/^https:\/\/chatgpt\.com\/g\/(g-p-[0-9a-f]{16,})(?:-[a-z0-9-]+)?(?:[/?#]|$)/i) || [])[1]?.toLowerCase() || null;

async function archiveGroupState(tabId, groupId, originalChatUrl) {
  if (!hasGroup(groupId)) return null;
  const [liveTab, peers, saved, group] = await Promise.all([
    chrome.tabs.get(tabId),
    chrome.tabs.query({groupId}),
    chrome.storage.sync.get(STORAGE_KEY),
    chrome.tabGroups.get(groupId)
  ]);
  if (liveTab.groupId !== groupId || !peers.some(t => t.id === tabId)) return null;
  const groupTitle = normalizeTitle(group.title || '').replace(/｜/g, '|').replace(/\s*\|\s*/g, '|');
  const mappings = Object.entries(saved[STORAGE_KEY] || {});
  const chatPid = projectIdFromUrl(originalChatUrl);
  const valid = ([, v]) => v && typeof v.projectUrl === 'string' &&
    /^https:\/\/chatgpt\.com\//.test(v.projectUrl) &&
    isRedirectableProjectUrl(v.projectUrl) &&
    (!chatPid || projectIdFromUrl(v.projectUrl) === chatPid);
  const mapped = mappings.filter(valid);
  // Priority 1: exact normalized group title, including a legacy storage key.
  const canon = s => normalizeTitle(s || '').replace(/｜/g, '|').replace(/\s*\|\s*/g, '|');
  let matches = mapped.filter(([key, v]) => groupTitle &&
    (canon(v.groupName) === groupTitle || canon(key) === groupTitle));
  let source = 'group-title';
  // Priority 2: existing binding's groupId, even when its historical name is
  // stale after renaming a long-lived group. Project ID still must match.
  if (!matches.length) {
    matches = mapped.filter(([, v]) => v.groupId === groupId);
    source = 'group-id';
  }
  // Priority 3: Chrome may renumber groupIds on restart. For a renamed Project
  // group, require a unique existing project binding AND the live group's first
  // name token to equal the real Project URL slug prefix. Never infer solely
  // from the chat's project ID, and never steal a mapping bound to another live
  // group. This is only a read-time compatibility fallback, not an auto-rebind.
  if (!matches.length && chatPid) {
    const slug = (originalChatUrl.match(/^https:\/\/chatgpt\.com\/g\/g-p-[0-9a-f]{16,}-([a-z0-9-]+)\/c\//i) || [])[1] || '';
    const lead = slug.split('-')[0];
    const titleLead = groupTitle.split(/[|\s]/)[0];
    if (lead.length >= 4 && titleLead === lead) {
      const liveGroups = await chrome.tabGroups.query({});
      const liveIds = new Set(liveGroups.map(g => g.id));
      matches = mapped.filter(([, v]) => !hasGroup(v.groupId) || !liveIds.has(v.groupId));
      source = 'legacy-project-alias';
    }
  }
  const targets = [...new Set(matches.map(([, v]) => v.projectUrl))];
  if (targets.length !== 1) {
    dbgLog('ARCHIVE no unique binding: group=' + (group.title || '').slice(0, 35) + ', route=' + source + ', matches=' + targets.length);
    return null;
  }
  const targetPid = projectIdFromUrl(targets[0]);
  if (chatPid && (!targetPid || chatPid !== targetPid)) return null;
  return {projectUrl: targets[0], count: peers.length, source};
}

async function recordChatArchiveIntent(senderTab, chatUrl) {
  if (!senderTab?.id || !isChatUrl(chatUrl) || !hasGroup(senderTab.groupId)) {
    dbgLog('ARCHIVE skip: invalid chat URL/group'); return;
  }
  // On a fast ChatGPT SPA transition sender.tab.url may already be on the
  // Project page by the time the click's message reaches the service worker.
  const senderUrl = (senderTab.url || '').split('#')[0];
  const stillOnChat = isChatUrl(senderUrl) && senderUrl === chatUrl.split('#')[0];
  const alreadyOnLanding = /^https:\/\/chatgpt\.com\//.test(senderUrl) && !isChatUrl(senderUrl) &&
    (!projectIdFromUrl(senderUrl) || projectIdFromUrl(senderUrl) === projectIdFromUrl(chatUrl));
  if (!stillOnChat && !alreadyOnLanding) {
    dbgLog('ARCHIVE skip: sender switched chat or origin'); return;
  }
  try {
    const state = await archiveGroupState(senderTab.id, senderTab.groupId, chatUrl);
    if (!state) { dbgLog('ARCHIVE skip: missing/mismatched group binding'); return; }
    dbgLog('ARCHIVE intent accepted (' + state.count + ' tabs, ' + state.source + ')');
    archiveIntents.set(senderTab.id, {
      groupId: senderTab.groupId,
      chatUrl: chatUrl.split('#')[0],
      projectUrl: state.projectUrl,
      until: Date.now() + 12000
    });
    // Handle navigation that finishes before the async registration.
    const fresh = await chrome.tabs.get(senderTab.id);
    if (fresh.url && fresh.url.split('#')[0] !== chatUrl.split('#')[0]) {
      await completeArchiveAction(senderTab.id, fresh.url);
    }
  } catch (err) { dbgLog('ARCHIVE intent error: ' + String(err).slice(0, 80)); }
}

// v6.37: Collapse only after the final archived tab has returned to its exact
// bound Project and Chrome reports that page has finished loading. Never collapse
// a group based merely on tabs.update() resolving (that only starts navigation).
// ChatGPT currently serves real Project landings as /g/<project-id>/project,
// not only the bare /g/<project-id> root. A project URL can also carry a
// display slug; only the stable Project ID determines identity. Never treat
// /c/<chat-id>, another project, a different origin or an arbitrary path as
// a successful Project landing. Both actual and bound URLs must be Project pages.
function projectLandingId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://chatgpt.com') return null;
    const match = parsed.pathname.match(/^\/g\/(g-p-[0-9a-f]{16,})(?:-[a-z0-9-]+)?(?:\/project)?\/?$/i);
    return match ? match[1].toLowerCase() : null;
  } catch (_) { return null; }
}
function isExactProjectLanding(url, boundUrl) {
  const boundPid = projectLandingId(boundUrl);
  return Boolean(boundPid && projectLandingId(url) === boundPid);
}
async function waitForBoundProjectLoaded(tabId, groupId, projectUrl) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.groupId !== groupId) return false;
      if (tab.pendingUrl && !isExactProjectLanding(tab.pendingUrl, projectUrl)) return false;
      if (tab.status === 'complete' && isExactProjectLanding(tab.url, projectUrl)) return true;
    } catch (_) { return false; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

async function collapseReturnedArchiveGroup(tabId, intent, originalWindowId) {
  if (!isExactProjectLanding(intent.projectUrl, intent.projectUrl)) {
    dbgLog('ARCHIVE-COLLAPSE skip: invalid Project landing URL'); return;
  }
  if (!await waitForBoundProjectLoaded(tabId, intent.groupId, intent.projectUrl)) {
    dbgLog('ARCHIVE-COLLAPSE skip: destination not loaded or tab moved'); return;
  }
  // Binding and group membership can change *during* navigation; revalidate both
  // immediately before the irreversible-for-this-action UI focus change.
  const state = await archiveGroupState(tabId, intent.groupId, intent.chatUrl);
  if (!state || state.count !== 1 || state.projectUrl !== intent.projectUrl) {
    dbgLog('ARCHIVE-COLLAPSE skip: mapping or tab count changed'); return;
  }
  const [tab, group, peers] = await Promise.all([
    chrome.tabs.get(tabId), chrome.tabGroups.get(intent.groupId),
    chrome.tabs.query({groupId: intent.groupId})
  ]);
  if (tab.groupId !== intent.groupId || tab.windowId !== originalWindowId ||
      group.windowId !== originalWindowId || peers.length !== 1 || peers[0].id !== tabId ||
      tab.status !== 'complete' || !isExactProjectLanding(tab.url, intent.projectUrl) ||
      (tab.pendingUrl && !isExactProjectLanding(tab.pendingUrl, intent.projectUrl))) {
    dbgLog('ARCHIVE-COLLAPSE skip: final live state changed'); return;
  }
  const updatedGroup = await chrome.tabGroups.update(intent.groupId, {collapsed: true});
  // v6.38: Arm only after Chrome confirms THIS extension collapsed the group.
  // Session-scoped, not synced to the user's mappings or permanent settings.
  if (updatedGroup?.collapsed === true) {
    try {
      await chrome.storage.session.set({
        ['stgAutoCollapsed:' + intent.groupId]: {
          tabId, windowId: originalWindowId, projectUrl: intent.projectUrl,
          createdAt: Date.now()
        }
      });
    } catch (err) { dbgLog('AUTO-EXPAND arm failed: ' + String(err).slice(0, 55)); }
  }
  dbgLog(updatedGroup?.collapsed === true
    ? 'ARCHIVE-COLLAPSE → original group collapsed'
    : 'ARCHIVE-COLLAPSE requested (Chrome UI state unverified)');
}

// v6.38: A collapsed group remains folded when the user activates ANOTHER
// Chrome tab. Expand only after a real click INSIDE the preserved Project tab
// navigates that SAME tab to a conversation. No tab activation, new tab, or
// automatic project/chat relocation is performed here.
const AUTO_EXPAND_PREFIX = 'stgAutoCollapsed:';
const autoExpandActionsInFlight = new Set();
const sameChatPath = (a,b) => {
  try {
    const x = new URL(a), y = new URL(b);
    const id = path => (path.match(/\/c\/([0-9a-f-]{16,})(?:\/|$)/i) || [])[1]?.toLowerCase();
    return x.origin === 'https://chatgpt.com' && y.origin === x.origin &&
      isChatUrl(x.href) && isChatUrl(y.href) && Boolean(id(x.pathname)) &&
      id(x.pathname) === id(y.pathname);
  } catch (_) { return false; }
};
async function expandAfterInPageConversationClick(tabId, message) {
  if (!Number.isInteger(tabId) || autoExpandActionsInFlight.has(tabId) ||
      !message || !isChatUrl(message.toUrl)) return;
  autoExpandActionsInFlight.add(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.id !== tabId || !hasGroup(tab.groupId)) return;
    const key = AUTO_EXPAND_PREFIX + tab.groupId;
    const saved = await chrome.storage.session.get(key);
    const marker = saved[key];
    if (!marker || marker.tabId !== tabId || marker.windowId !== tab.windowId ||
        !isExactProjectLanding(message.fromUrl, marker.projectUrl)) return;
    const [group, peers, bound] = await Promise.all([
      chrome.tabGroups.get(tab.groupId),
      chrome.tabs.query({groupId: tab.groupId}),
      archiveGroupState(tabId, tab.groupId, marker.projectUrl)
    ]);
    if (group.collapsed !== true || group.windowId !== marker.windowId ||
        peers.length !== 1 || peers[0].id !== tabId ||
        !bound || bound.count !== 1 || bound.projectUrl !== marker.projectUrl) return;
    // Full-document and SPA navigations both count, but an anchor's href alone
    // does NOT count until Chrome reports this very tab at the target chat.
    const deadline = Date.now() + 3500;
    let atChat = false;
    while (Date.now() < deadline) {
      const fresh = await chrome.tabs.get(tabId);
      if (fresh.groupId !== tab.groupId || fresh.windowId !== marker.windowId) return;
      if (sameChatPath(fresh.url, message.toUrl)) { atChat = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!atChat) return;
    // Revalidate just before UI mutation; do not undo a manual group action.
    const [lastGroup, finalTab, lastPeers, still] = await Promise.all([
      chrome.tabGroups.get(tab.groupId), chrome.tabs.get(tabId),
      chrome.tabs.query({groupId: tab.groupId}), chrome.storage.session.get(key)
    ]);
    if (!still[key] || still[key].tabId !== tabId ||
        lastGroup.collapsed !== true || lastGroup.windowId !== marker.windowId ||
        lastPeers.length !== 1 || lastPeers[0].id !== tabId ||
        finalTab.groupId !== tab.groupId || finalTab.windowId !== marker.windowId ||
        !sameChatPath(finalTab.url, message.toUrl)) return;
    await chrome.tabGroups.update(tab.groupId, {collapsed: false});
    await chrome.storage.session.remove(key);
    dbgLog('AUTO-EXPAND → in-page conversation click; original tab shown');
  } catch (err) {
    dbgLog('AUTO-EXPAND error: ' + String(err).slice(0, 75));
  } finally { autoExpandActionsInFlight.delete(tabId); }
}
// If a user manually expands a group, discard our auto-collapse provenance.
chrome.tabGroups.onUpdated.addListener(group => {
  if (group && group.collapsed === false && hasGroup(group.id)) {
    void chrome.storage.session.remove(AUTO_EXPAND_PREFIX + group.id).catch(() => {});
  }
});

const archiveActionInFlight = new Set();
async function completeArchiveAction(tabId, observedUrl) {
  const intent = archiveIntents.get(tabId);
  if (!intent || archiveActionInFlight.has(tabId)) return;
  if (Date.now() > intent.until) {
    archiveIntents.delete(tabId); dbgLog('ARCHIVE expired'); return;
  }
  const url = (observedUrl || '').split('#')[0];
  // Never act on navigation to another conversation. Native Archive normally
  // navigates to a project/home surface; ordinary sidebar chat switching won't.
  if (url === intent.chatUrl || !/^https:\/\/chatgpt\.com\//.test(url) || isChatUrl(url)) return;
  archiveActionInFlight.add(tabId);
  try {
    const state = await archiveGroupState(tabId, intent.groupId, intent.chatUrl);
    if (!state || state.projectUrl !== intent.projectUrl) {
      archiveIntents.delete(tabId);
      dbgLog('ARCHIVE skip: mapping/group changed'); return;
    }
    // Re-check that this tab has not moved to another chat since the event.
    const fresh = await chrome.tabs.get(tabId);
    if (fresh.groupId !== intent.groupId ||
        (fresh.url && fresh.url.split('#')[0] !== intent.chatUrl && isChatUrl(fresh.url))) {
      archiveIntents.delete(tabId);
      dbgLog('ARCHIVE skip: tab switched chat or group'); return;
    }
    archiveIntents.delete(tabId); // idempotent against dual SPA/tab URL signals
    if (state.count > 1) {
      await chrome.tabs.remove(tabId);
      dbgLog('ARCHIVE-CLOSE → archived tab only; peers kept: ' + (state.count - 1));
    } else if (state.count === 1) {
      const originalWindowId = fresh.windowId;
      await chrome.tabs.update(tabId, {url: intent.projectUrl});
      dbgLog('ARCHIVE-RETURN → bound Project (last tab preserved)');
      try {
        await collapseReturnedArchiveGroup(tabId, intent, originalWindowId);
      } catch (err) {
        // Never roll back a successfully returned Project tab just because
        // optional group collapsing failed.
        dbgLog('ARCHIVE-COLLAPSE error: ' + String(err).slice(0, 75));
      }
    }
  } catch (err) { dbgLog('ARCHIVE action error: ' + String(err).slice(0, 80)); }
  finally { archiveActionInFlight.delete(tabId); }
}

chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (!changes.url || !archiveIntents.has(tabId)) return;
  void completeArchiveAction(tabId, changes.url);
});
chrome.tabs.onRemoved.addListener((tabId) => { archiveIntents.delete(tabId); lateGroupTabs.delete(tabId); observerReady.delete(tabId); observerPending.delete(tabId); });

// Message handler
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') { sendResponse('pong'); return false; }
  if (msg.type === 'GET_DEBUG') { sendResponse(debugLog.slice()); return false; }
  if (msg.type === 'GET_PERF') { sendResponse(perfLog.slice()); return false; }
  if (msg.type === 'GPT_PROJECT_CONVERSATION_OPENED') {
    if (sender.tab?.id) void expandAfterInPageConversationClick(sender.tab.id, msg);
    sendResponse('ok');
    return false;
  }
  if (msg.type === 'GPT_ARCHIVE_INTENT') {
    // Respond after registration, so the content script never reports navigation before an intent exists.
    void recordChatArchiveIntent(sender.tab, msg.chatUrl).then(() => sendResponse('ok'));
    return true;
  }
  if (msg.type === 'GPT_ARCHIVE_NAVIGATED') {
    if (sender.tab?.id) void completeArchiveAction(sender.tab.id, msg.url);
    sendResponse('ok');
    return false;
  }
  if (msg.type === 'REFRESH_CACHE' && msg.mappings) {
    cachedMappings = msg.mappings;
    rebuildIndex(cachedMappings);
    sendResponse('ok');
    return false;
  }
  // v6.24: content script detected a ChatGPT project 404 — delete the corrupt
  // mapping(s) pointing at that project id so the group stops 404ing.
  if (msg.type === 'GPT_PROJECT_404' && msg.url) {
    const pid = (msg.url.match(/g-p-[0-9a-f]+/i) || [])[0];
    if (pid) {
      (async () => {
        try {
          const data = await chrome.storage.sync.get(STORAGE_KEY);
          const mappings = data[STORAGE_KEY] || {};
          let removed = 0;
          for (const key of Object.keys(mappings)) {
            if (mappings[key]?.projectUrl && mappings[key].projectUrl.includes(pid)) {
              delete mappings[key];
              removed++;
            }
          }
          if (removed) {
            await chrome.storage.sync.set({ [STORAGE_KEY]: mappings });
            cachedMappings = mappings;
            rebuildIndex(mappings);
            console.log('[CPT] 404 self-heal: removed ' + removed + ' corrupt mapping(s) for ' + pid);
          }
        } catch (_) {}
      })();
    }
    sendResponse('ok');
    return false;
  }
  return false;
});
