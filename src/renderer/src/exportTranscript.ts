function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function inlineUrls(css: string): Promise<string> {
  const urls = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)]
  const replacements = new Map<string, string>()
  await Promise.all(
    urls.map(async ([, url]) => {
      if (url.startsWith('data:') || replacements.has(url)) return
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        replacements.set(url, await blobAsDataUrl(await response.blob()))
      } catch (error) {
        throw new Error(
          `Could not embed export resource ${url}: ${error instanceof Error ? error.message : 'unknown error'}`
        )
      }
    })
  )
  return css.replace(/url\(["']?([^"')]+)["']?\)/g, (match, url: string) => {
    const replacement = replacements.get(url)
    return replacement ? `url("${replacement}")` : match
  })
}

async function documentCss(): Promise<string> {
  const rules: string[] = []
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) rules.push(rule.cssText)
    } catch {
      // Ignore inaccessible third-party stylesheets.
    }
  }
  return inlineUrls(rules.join('\n'))
}

const EXPORT_CSS = `
html, body { height: auto; min-height: 100%; }
body { overflow: auto; }
.transcript {
  width: 100%;
  max-width: 1120px;
  height: auto;
  min-height: 100vh;
  margin: 0 auto;
  border-inline: 1px solid var(--border);
}
.transcript-head { overflow: visible; padding-top: 20px; }
.transcript-scroll { overflow: visible; contain: none; will-change: auto; }
.transcript-search-bar { position: sticky; top: 0; z-index: 10; }
.app-only-action, .export-action, .th-back, .th-subagents, .toast { display: none !important; }
@media (max-width: 1120px) {
  .transcript { border-inline: 0; }
}
@media print {
  .transcript-head { break-after: avoid; }
  .transcript-search-bar, .message-type-filter, .msg-toolbar, .collapse-toggle { display: none !important; }
  .collapsible-clip.collapsed { max-height: none; overflow: visible; }
  .msg { break-inside: avoid; }
}
`

const EXPORT_SCRIPT = `
(() => {
  const transcript = document.querySelector('.transcript');
  const searchBar = document.querySelector('.transcript-search-bar');
  const searchInput = document.querySelector('.ts-input');
  const searchCount = document.querySelector('.ts-count');
  const activeRoles = new Set();
  let matches = [], current = 0;

  function visibleMessages() {
    return [...document.querySelectorAll('[data-message-role]')].filter((el) => !el.hidden);
  }
  function applyFilter() {
    document.querySelectorAll('[data-message-role]').forEach((el) => {
      el.hidden = activeRoles.size > 0 && !activeRoles.has(el.dataset.messageRole);
    });
    document.querySelectorAll('[data-filter-role]').forEach((button) => {
      const role = button.dataset.filterRole;
      const on = role ? activeRoles.has(role) : activeRoles.size === 0;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
      button.style.borderColor = on && role ? button.dataset.filterColor : '';
      button.style.color = on && role ? button.dataset.filterColor : '';
    });
    const shown = visibleMessages().length;
    const counter = document.querySelector('.message-filter-count');
    if (counter) counter.textContent = shown + '/' + document.querySelectorAll('[data-message-role]').length;
    runSearch();
  }
  function showCurrent() {
    CSS.highlights?.delete('transcript-export-current');
    if (!matches.length) return;
    current = (current + matches.length) % matches.length;
    CSS.highlights?.set('transcript-export-current', new Highlight(matches[current]));
    matches[current].startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (searchCount) searchCount.textContent = (current + 1) + '/' + matches.length;
  }
  function runSearch() {
    CSS.highlights?.delete('transcript-export-search');
    CSS.highlights?.delete('transcript-export-current');
    matches = []; current = 0;
    const query = searchInput?.value.trim().toLowerCase() || '';
    document.querySelectorAll('[data-search-prev], [data-search-next]').forEach((button) => button.disabled = !query);
    if (searchCount) searchCount.hidden = !query;
    if (!query) { if (searchCount) searchCount.textContent = ''; return; }
    visibleMessages().forEach((message) => {
      const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode, text = node.textContent.toLowerCase();
        if (node.parentElement?.closest('.msg-toolbar, .collapse-toggle')) continue;
        const item = node.parentElement?.closest('.msg');
        if (node.parentElement?.closest('.text-view-source') && !item?.classList.contains('source-view')) continue;
        if (node.parentElement?.closest('.text-view-markdown') && item?.classList.contains('source-view')) continue;
        let start = 0, index;
        while ((index = text.indexOf(query, start)) !== -1) {
          const range = new Range();
          range.setStart(node, index); range.setEnd(node, index + query.length);
          matches.push(range); start = index + query.length;
        }
      }
    });
    document.querySelectorAll('[data-search-prev], [data-search-next]').forEach((button) => button.disabled = matches.length === 0);
    if (matches.length) {
      CSS.highlights?.set('transcript-export-search', new Highlight(...matches.slice(0, 500)));
      showCurrent();
    } else if (searchCount) searchCount.textContent = 'No matches';
  }
  function openSearch() { searchBar.hidden = false; searchInput?.focus(); searchInput?.select(); }
  function closeSearch() { searchBar.hidden = true; if (searchInput) searchInput.value = ''; runSearch(); }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.matches('[data-filter-role]')) {
      const role = target.dataset.filterRole;
      if (!role) activeRoles.clear();
      else if (activeRoles.has(role)) activeRoles.delete(role);
      else activeRoles.add(role);
      applyFilter();
    }
    if (target.matches('.view-toggle')) {
      const message = target.closest('.msg');
      const source = message.classList.toggle('source-view');
      target.lastChild.textContent = source ? ' Markdown' : ' Source';
      runSearch();
    }
    if (target.matches('.collapse-toggle')) {
      const clip = target.closest('.collapsible').querySelector('.collapsible-clip');
      const collapsed = clip.classList.toggle('collapsed');
      target.lastChild.textContent = collapsed ? ' Show more' : ' Show less';
    }
    if (target.matches('[data-search-prev]')) { current--; showCurrent(); }
    if (target.matches('[data-search-next]')) { current++; showCurrent(); }
    if (target.matches('[data-search-close]')) closeSearch();
  });
  searchInput?.addEventListener('input', runSearch);
  searchInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { current += event.shiftKey ? -1 : 1; showCurrent(); }
    if (event.key === 'Escape') closeSearch();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'f') { event.preventDefault(); openSearch(); }
  });
  transcript?.querySelectorAll('a').forEach((link) => link.setAttribute('target', '_blank'));
  applyFilter();
})();
`

export async function buildTranscriptHtml(root: HTMLElement, title: string): Promise<string> {
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll<HTMLElement>('[hidden]').forEach((element) => {
    if (element.matches('[data-message-role]')) element.hidden = false
  })
  const searchBar = clone.querySelector<HTMLElement>('.transcript-search-bar')
  if (searchBar) searchBar.hidden = true
  const searchInput = clone.querySelector<HTMLInputElement>('.ts-input')
  if (searchInput) searchInput.setAttribute('value', '')
  clone.querySelectorAll<HTMLElement>('[data-filter-role]').forEach((button) => {
    button.removeAttribute('style')
  })
  clone.querySelector('.filter-empty')?.remove()

  const rootStyle = document.documentElement.getAttribute('style') ?? ''
  const mode = document.documentElement.dataset.mode ?? 'dark'
  const css = await documentCss()
  return `<!doctype html>
<html lang="en" data-mode="${escapeHtml(mode)}" style="${escapeHtml(rootStyle)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${css}\n${EXPORT_CSS}\n::highlight(transcript-export-search){background:var(--mark);color:var(--mark-text)}::highlight(transcript-export-current){background:var(--accent);color:var(--on-accent)}</style>
</head>
<body>${clone.outerHTML}<script>${EXPORT_SCRIPT}</script></body>
</html>`
}
