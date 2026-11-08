// Smart Tab Groups — explicit Project URL binding manager (Claude + ChatGPT).
// Auto Setup discovery/creation/reconciliation was retired by user decision.
const DONATE_URL = 'https://ko-fi.com/nickythefox';
function $(id) { return document.getElementById(id); }
function showStatus(type, text) {
  const el = $('status');
  if (!el) return;
  el.className = type ? 'status status-' + type : 'status hidden';
  el.textContent = type ? text : '';
}
document.addEventListener('DOMContentLoaded', () => {
  $('btnDonate').setAttribute('href', DONATE_URL);
  void renderBindList();
  $('bindList').addEventListener('click', onBindListClick);
});

function colorHex(c) {
  return ({ grey:'#9aa0a6', blue:'#1c7ef2', red:'#e5484d', yellow:'#eab308',
            green:'#16a34a', pink:'#ec4899', purple:'#8b5cf6', cyan:'#06b6d4' })[c] || '#9aa0a6';
}
function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function parseProjectUrl(raw) {
  try {
    const u = new URL((raw || '').trim());
    if (u.origin === 'https://claude.ai') {
      const m = u.pathname.match(/^\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
      return m ? {projectId:m[1], projectUrl:u.origin + '/project/' + m[1], platform:'claude'} : null;
    }
    if (u.origin === 'https://chatgpt.com') {
      const m = u.pathname.match(/^\/g\/(g-p-[0-9a-f]{16,})(?:-[a-z0-9-]+)?(?:\/([a-z0-9-]+))?\/?$/i);
      if (!m || (m[2] && /^(?:c|chat|conversation|settings)$/i.test(m[2]))) return null;
      return {projectId:m[1], projectUrl:u.origin + u.pathname.replace(/\/$/, ''), platform:'chatgpt'};
    }
  } catch (_) {}
  return null;
}
function isProjectUrl(u) { return Boolean(parseProjectUrl(u)); }

async function renderBindList() {
  var list = $('bindList');
  if (!list) return;
  try {
    var win = await chrome.windows.getCurrent();
    var groups = await chrome.tabGroups.query({ windowId: win.id });
    groups = groups.filter(function(g) { return (g.title || '').trim(); });
    groups.sort(function(a, b) { return a.title.localeCompare(b.title); });
    var data = await chrome.storage.sync.get('mappings');
    var mappings = data.mappings || {};
    if (!groups.length) {
      list.innerHTML = '<div class="bind-row" style="opacity:.6">No named tab groups in this window</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < groups.length; i++) {
      var grp = groups[i];
      // Match only the live group and its exact stored title; avoid stale groupId collisions.
      var bindings = Object.entries(mappings).filter(function(pair) {
        var entry = pair[1];
        return entry && entry.groupId === grp.id &&
               ((entry.groupName || '').trim() === grp.title.trim() || pair[0].trim() === grp.title.trim());
      });
      var boundKey = bindings.length === 1 ? bindings[0][0] : null;
      var bound = boundKey !== null ? bindings[0][1] : null;
      html += '<div class="bind-row"><div class="gname"><span class="gdot" style="background:' +
              colorHex(grp.color) + '"></span>' + escapeHtml(grp.title) + '</div>';
      if (bound && isProjectUrl(bound.projectUrl)) {
        var shortU = bound.projectUrl.replace(/^https:\/\/(chatgpt\.com\/g\/|claude\.ai\/project\/)/, '');
        if (shortU.length > 38) shortU = shortU.slice(0, 35) + '…';
        html += '<div class="bind-url">✅ ' + escapeHtml(shortU) + '</div>' +
                '<button class="unbind" data-key="' + escapeHtml(boundKey) + '">Unbind</button>';
      } else {
        html += '<div class="bind-form"><input type="text" placeholder="Paste Project URL…" data-gid="' + grp.id +
                '" data-title="' + escapeHtml(grp.title) + '"><button class="dobind" data-gid="' + grp.id +
                '" data-title="' + escapeHtml(grp.title) + '">Bind</button></div>';
      }
      html += '</div>';
    }
    list.innerHTML = html;
  } catch (e) {
    list.innerHTML = '<div class="bind-row">Unable to load groups: ' + escapeHtml(e.message) + '</div>';
  }
}

async function onBindListClick(e) {
  var t = e.target && e.target.closest ? e.target.closest('button') : null;
  if (!t || t.disabled) return;
  if (t.classList.contains('dobind')) {
    var gid = parseInt(t.getAttribute('data-gid'), 10);
    var title = t.getAttribute('data-title');
    var input = t.parentElement.querySelector('input');
    await bindGroupUrl(gid, title, input ? input.value : '');
  } else if (t.classList.contains('unbind')) {
    await unbindGroup(t.getAttribute('data-key'));
  }
}

async function bindGroupUrl(gid, title, url) {
  const project = parseProjectUrl(url);
  if (!project) {
    showStatus('error', 'Please enter a valid Claude or ChatGPT Project URL, not a conversation URL.');
    return;
  }
  try {
    const group = await chrome.tabGroups.get(gid);
    if (!group || (group.title || '').trim() !== title) {
      showStatus('error', 'The tab group has changed. Reopen the extension and try again.'); return;
    }
    const allGroups = await chrome.tabGroups.query({});
    if (allGroups.filter(g => (g.title || '').trim() === title).length !== 1) {
      showStatus('error', 'Multiple tab groups have the same name. Rename them to unique names first.'); return;
    }
    const data = await chrome.storage.sync.get('mappings');
    const mappings = data.mappings || {};
    mappings[title] = {
      groupId: gid, groupName: title, projectId: project.projectId,
      projectUrl: project.projectUrl, projectName: title,
      platform: project.platform, boundAt: Date.now()
    };
    await chrome.storage.sync.set({ mappings });
    try { await chrome.runtime.sendMessage({ type: 'REFRESH_CACHE', mappings }); } catch (_) {}
    await renderBindList();
    showStatus('ok', 'Bound “' + title + '”. Group name and color are unchanged.');
  } catch (e) {
    showStatus('error', 'Binding failed: ' + e.message);
  }
}

async function unbindGroup(key) {
  try {
    var data = await chrome.storage.sync.get('mappings');
    var mappings = data.mappings || {};
    delete mappings[key];
    await chrome.storage.sync.set({ mappings: mappings });
    try { await chrome.runtime.sendMessage({ type: 'REFRESH_CACHE', mappings: mappings }); } catch (_) {}
    await renderBindList();
  } catch (_) {}
}
