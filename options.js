// options.js v6.28 — safe binding management for the shared `mappings` store
// Previously this page wrote a dead `projectMappings` key; unified in v6.17.
let mappings = {};

const isClaudeUrl = (u) => /^https:\/\/claude\.ai\/project\/[a-f0-9-]{36}(?:[/?#]|$)/i.test(u || '');
const isChatGptUrl = (u) => /^https:\/\/chatgpt\.com\/g\/g-p-[0-9a-f]{16,}(?:[/?#]|$)/i.test(u || '');

document.addEventListener('DOMContentLoaded', async () => {
  await loadMappings();
  renderMappings();

  document.getElementById('btnAdd').addEventListener('click', addMapping);
});

async function loadMappings() {
  const result = await chrome.storage.sync.get('mappings');
  mappings = result.mappings || {};
}

async function saveMappings() {
  await chrome.storage.sync.set({ mappings });
}

function platformName(url) {
  if (isClaudeUrl(url)) return 'Claude';
  if (isChatGptUrl(url)) return 'ChatGPT';
  return '';
}

function renderMappings() {
  const container = document.getElementById('mappings');
  const keys = Object.keys(mappings);
  container.replaceChildren();

  if (keys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No bindings yet. Right-click a Claude/ChatGPT project page to bind, or add one below.';
    container.appendChild(empty);
    return;
  }

  keys.forEach((key) => {
    const m = mappings[key] || {};
    const card = document.createElement('div');
    card.className = 'mapping-card';

    const group = document.createElement('div');
    group.className = 'group-name';
    group.appendChild(document.createTextNode(m.groupName || key));
    const platform = platformName(m.projectUrl);
    if (platform) {
      const badge = document.createElement('span');
      badge.className = 'badge ' + (platform === 'Claude' ? 'badge-claude' : 'badge-gpt');
      badge.textContent = platform;
      group.appendChild(badge);
    }

    const url = document.createElement('div');
    url.className = 'project-url';
    url.textContent = m.projectUrl || m.projectId || '';

    const actions = document.createElement('div');
    actions.className = 'actions';
    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = 'Delete';
    del.dataset.key = key;
    del.addEventListener('click', async () => {
      delete mappings[key];
      await saveMappings();
      renderMappings();
    });
    actions.appendChild(del);

    card.append(group, url, actions);
    container.appendChild(card);
  });
}

async function addMapping() {
  const groupName = document.getElementById('groupName').value.trim();
  const projectUrl = document.getElementById('projectUrl').value.trim();

  if (!groupName || !projectUrl) {
    alert('Please fill in all fields');
    return;
  }

  if (!isClaudeUrl(projectUrl) && !isChatGptUrl(projectUrl)) {
    alert('Please enter a valid Claude Project URL (claude.ai/project/...) or ChatGPT Project URL (chatgpt.com/g/g-p-...)');
    return;
  }

  const claudeId = projectUrl.match(/\/project\/([a-f0-9-]+)/)?.[1];
  const gptId = projectUrl.match(/\/g\/(g-p-[A-Za-z0-9]+)/)?.[1];

  mappings[groupName] = {
    groupName,
    projectUrl,
    projectId: claudeId || gptId,
    projectName: groupName,
    platform: isClaudeUrl(projectUrl) ? 'claude' : 'chatgpt',
    boundAt: Date.now()
  };

  await saveMappings();

  document.getElementById('groupName').value = '';
  document.getElementById('projectUrl').value = '';
  renderMappings();
}
