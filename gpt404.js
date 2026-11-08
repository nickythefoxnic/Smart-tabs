// v6.34: idempotent if injected into an already-open tab and later loaded again.
if (!globalThis.__aiTabGroupsContentV634) {
  globalThis.__aiTabGroupsContentV634 = true;
// gpt404.js (v6.28) — remove a project binding only when ChatGPT clearly
// renders a project-level not-found page. Never close the user's tab.
(function() {
  var done = false;
  function isNotFoundPage() {
    if (!/\/g\/g-p-[0-9a-f]{16,}/i.test(location.pathname)) return false;
    var title = (document.title || '').trim();
    if (/page not found|not found/i.test(title)) return true;
    var headings = document.querySelectorAll('h1, h2, [role="heading"]');
    for (var i = 0; i < headings.length; i++) {
      var t = (headings[i].textContent || '').trim();
      if (/^(404|page not found|not found)$/i.test(t)) return true;
    }
    return false;
  }
  function check() {
    if (done || !isNotFoundPage()) return;
    done = true;
    try { chrome.runtime.sendMessage({ type: 'GPT_PROJECT_404', url: location.href }); } catch (_) {}
  }
  check();
  var attempts = 0;
  var timer = setInterval(function() {
    attempts++;
    check();
    if (done || attempts >= 8) clearInterval(timer);
  }, 1000);
})();




// v6.34 — Listen for native Archive action on the active conversation.
// ChatGPT Project chat URLs have g-p-<hex>-<slug>/c/<chatId>, not only g-p-<hex>/c/<chatId>.
// The 6.31 regex silently rejected all slugged Project chats. Observe SPA
// navigation locally as a fallback when Chrome tabs.onUpdated is not emitted.
(function observeCurrentChatArchive() {
  const chatPath = /^\/(?:g\/g-p-[0-9a-f]{16,}(?:-[a-z0-9-]+)?\/)?c\/[0-9a-f-]{16,}(?:\/|$)/i;
  const archiveLabel = /^(?:archive(?:\s+(?:chat|conversation))?|归档(?:对话)?|收纳(?:对话)?|存档(?:对话)?|移至归档)(?:\s|$)/i;
  let observer = null;
  document.addEventListener('click', function(event) {
    if (!chatPath.test(location.pathname)) return;
    const element = event.target instanceof Element
      ? event.target.closest('button,[role="menuitem"],[role="menuitemcheckbox"]') : null;
    if (!element) return;
    const aria = (element.getAttribute('aria-label') || '').trim();
    const visible = (element.textContent || '').trim();
    if (!archiveLabel.test(aria) && !archiveLabel.test(visible)) return;
    const chatUrl = location.href.split('#')[0];
    // Listener only observes a click. It does not execute the Archive action.
    try { chrome.runtime.sendMessage({type: 'GPT_ARCHIVE_INTENT', chatUrl}).catch(() => {}); } catch (_) {}
    if (observer) clearInterval(observer);
    const startedAt = Date.now();
    let reported = false;
    observer = setInterval(function() {
      if (Date.now() - startedAt > 12000 || reported) {
        clearInterval(observer);
        observer = null;
        return;
      }
      const now = location.href.split('#')[0];
      if (now !== chatUrl && /^https:\/\/chatgpt\.com\//.test(now)) {
        reported = true;
        // Handles a same-document React/History API transition as well as
        // tab URL updates observed directly in background.js.
        try { chrome.runtime.sendMessage({type: 'GPT_ARCHIVE_NAVIGATED', url: now}).catch(() => {}); } catch (_) {}
      }
    }, 200);
  }, true);
})();


}




// v6.38: UI-only re-expansion after a real in-page conversation selection.
// Separate idempotence guard also works on already-open v6.37 documents.
if (!globalThis.__stgConversationExpandV638) {
  globalThis.__stgConversationExpandV638 = true;
  (function observeProjectConversationSelection() {
    const projectPage = /^\/g\/g-p-[0-9a-f]{16,}(?:-[a-z0-9-]+)?(?:\/project)?\/?$/i;
    const chatPage = /^\/(?:g\/g-p-[0-9a-f]{16,}(?:-[a-z0-9-]+)?\/)?c\/[0-9a-f-]{16,}(?:\/|$)/i;
    let watching = false;
    document.addEventListener('click', function(event) {
      // A Chrome-side-panel tab selection cannot generate a document click.
      if (!event.isTrusted || event.button !== 0 || event.metaKey || event.ctrlKey ||
          event.shiftKey || event.altKey || !projectPage.test(location.pathname) || watching) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || !target.closest('a[href],button,[role="link"],[role="button"]')) return;
      const fromUrl = location.href.split('#')[0];
      let reported = false;
      const report = (toUrl) => {
        if (reported) return;
        reported = true;
        try { chrome.runtime.sendMessage({
          type: 'GPT_PROJECT_CONVERSATION_OPENED', fromUrl, toUrl
        }).catch(() => {}); } catch (_) {}
      };
      // Anchor navigation might destroy the document before any polling tick.
      // The background independently waits for real navigation, not just href.
      const link = target.closest('a[href]');
      if (link) {
        try {
          const intended = new URL(link.href, location.href);
          if (intended.origin === location.origin && chatPage.test(intended.pathname))
            report(intended.href);
        } catch (_) {}
      }
      if (reported) return;
      watching = true;
      const start = Date.now();
      const timer = setInterval(function() {
        const current = location.href.split('#')[0];
        if (current !== fromUrl && chatPage.test(location.pathname)) report(current);
        if (reported || Date.now() - start > 3500) {
          clearInterval(timer);
          watching = false;
        }
      }, 80);
    }, true);
  })();
}