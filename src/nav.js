// Sidebar navigation: highlights the section in view and opens the Item List
// panel when it is chosen. Presentation only; the takeoff logic is in app.js.
const links = [...document.querySelectorAll('.nav a')];
const sections = links.map(link => document.querySelector(link.getAttribute('href'))).filter(Boolean);

function select(link) {
  links.forEach(other => other.classList.toggle('active', other === link));
}

links.forEach(link => link.addEventListener('click', () => {
  const target = document.querySelector(link.getAttribute('href'));
  if (target?.tagName === 'DETAILS') target.open = true;
  select(link);
}));

function update() {
  const line = window.innerHeight * 0.3;
  let current = sections[0], best = -Infinity;
  for (const section of sections) {
    const top = section.getBoundingClientRect().top;
    if (top <= line && top > best) { best = top; current = section; }
  }
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = document.getElementById('quote-panel') || current;
  select(links.find(link => link.getAttribute('href') === '#' + current.id));
}

window.addEventListener('scroll', update, {passive: true});
