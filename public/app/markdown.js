// Minimal, safe markdown renderer for journal entry text. Escapes first,
// then layers markdown transforms on top of the escaped string — so the
// output is always safe HTML regardless of what's in the source text.
// Supports: **bold**, *italic*, "- " / "* " bullet lists, paragraph breaks.

export function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineMd(escapedText) {
  return escapedText
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
}

export function renderMarkdown(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const escaped = escHtml(text);
  const blocks = escaped.split(/\n{2,}/);
  return blocks.map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const isList = lines.length > 0 && lines.every(l => /^[-*]\s+/.test(l));
    if (isList) {
      const items = lines.map(l => `<li>${inlineMd(l.replace(/^[-*]\s+/, ''))}</li>`).join('');
      return `<ul class="md-list">${items}</ul>`;
    }
    return `<p class="md-p">${inlineMd(block.replace(/\n/g, '<br>'))}</p>`;
  }).join('');
}
