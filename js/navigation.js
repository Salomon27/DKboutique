import { auth } from './auth.js';

const LINKS = {
  gerant: [
    ['dispatch.html', 'Nouveau'],
    ['point.html', 'Le Point'],
    ['rapports.html', 'Archives'],
    ['livreurs.html', 'Équipe'],
    ['dashboard.html', 'Stats']
  ],
  patronne: [
    ['patronne.html', 'Supervision'],
    ['rapports.html', 'Archives'],
    ['livreurs.html', 'Équipe'],
    ['colis.html', 'Colis'],
    ['bilan-journee.html', 'Bilan']
  ]
};

function currentFile() {
  const file = window.location.pathname.split('/').pop();
  return file || 'index.html';
}

async function initNavigation() {
  const existing = document.querySelector('.bottom-nav');
  if (existing) return;

  let role = null;
  try {
    role = await auth.getCurrentRole();
  } catch {
    return;
  }

  const links = LINKS[role];
  if (!links) return;

  const nav = document.createElement('nav');
  nav.className = 'bottom-nav';
  nav.setAttribute('aria-label', 'Navigation principale');

  const here = currentFile();
  links.forEach(([href, label]) => {
    const a = document.createElement('a');
    a.href = href;
    a.className = 'nav-item';
    if (href === here) a.classList.add('active');

    const span = document.createElement('span');
    span.textContent = label;
    a.appendChild(span);
    nav.appendChild(a);
  });

  document.body.appendChild(nav);
  document.body.classList.add('has-bottom-nav');
}

document.addEventListener('DOMContentLoaded', initNavigation);
