// Sidebar navigation: switches between the takeoff and Settings, and
// highlights the takeoff section in view. Presentation only; the takeoff logic
// is in app.js.
const links = [...document.querySelectorAll('.nav a')];
const takeoffLinks = links.filter(link => link.dataset.view === 'takeoff');
const sections = takeoffLinks.map(link => document.querySelector(link.getAttribute('href'))).filter(Boolean);
const views = {takeoff: document.getElementById('takeoff-view'), settings: document.getElementById('settings')};
let view = 'takeoff';

function select(link) {
  links.forEach(other => other.classList.toggle('active', other === link));
}

function show(name) {
  view = name;
  for (const [key, element] of Object.entries(views)) element.hidden = key !== name;
  document.getElementById('crumb-title').textContent = name === 'settings' ? 'Settings' : 'Drawing takeoff';
}

function route() {
  if (location.hash === '#settings') {
    show('settings');
    select(links.find(link => link.dataset.view === 'settings'));
    window.scrollTo(0, 0);
    return;
  }
  const wasSettings = view === 'settings';
  show('takeoff');
  const target = location.hash && document.querySelector(location.hash);
  if (wasSettings && target) target.scrollIntoView();
  update();
}

function update() {
  if (view !== 'takeoff') return;
  const line = window.innerHeight * 0.3;
  let current = sections[0], best = -Infinity;
  for (const section of sections) {
    const top = section.getBoundingClientRect().top;
    if (top <= line && top > best) { best = top; current = section; }
  }
  if (window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = document.getElementById('quote-panel') || current;
  select(takeoffLinks.find(link => link.getAttribute('href') === '#' + current.id));
}

window.addEventListener('hashchange', route);
window.addEventListener('scroll', update, {passive: true});
route();
