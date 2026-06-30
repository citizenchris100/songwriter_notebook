// dom.js — the low-level render primitives shared by both views: the generator
// (ui.js) and the Songs tab (songsView.js). Impure (it touches `document`) but
// trivial, so it is the one safe place to share element builders without coupling
// the two view modules to each other.

export const h = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

// One chord chip: big name over its triad/voicing notes.
export function chip(c) {
  const el = h('div', 'pchip');
  el.appendChild(h('div', 'pchip-name', c.name));
  el.appendChild(h('div', 'pchip-notes', c.notes.join(' ')));
  return el;
}

// A progression rendered as a single horizontal row of chips. Pass 'allchords' as
// `cls` for the wrapping palette variant.
export function chipRow(chords, cls) {
  const row = h('div', 'prow' + (cls ? ' ' + cls : ''));
  chords.forEach((c) => row.appendChild(chip(c)));
  return row;
}

// A labeled section: an uppercase heading over its children.
export function sectionBlock(title, children) {
  const sec = h('div', 'sec');
  sec.appendChild(h('div', 'seclabel', title));
  children.forEach((c) => sec.appendChild(c));
  return sec;
}
