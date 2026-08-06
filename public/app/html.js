// The one HTML-escaping helper.
//
// This existed as eleven separate copies — one per view/component — which is
// how the Groq client drifted into two implementations with different
// behaviour, and the same thing had already started here (search.js used
// String(s), so escHtml(null) rendered the literal text "null" where every
// other copy rendered an empty string). Escaping is the wrong place to let
// that happen twice, so there is now exactly one.
//
// Escapes & < > " — enough for text nodes and double-quoted attributes, which
// is every interpolation site in the app (there are no single-quoted
// attributes; if one is ever added, ' needs escaping here too).
export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
