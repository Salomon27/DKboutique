import { auth } from './auth.js';

const LINKS = {
  gerant: [
    ['dispatch.html', 'Dispatch'],
    ['point.html', 'Le Point'],
    ['rapports.html', 'Archives'],
    ['livreurs.html', 'Équipe'],
    ['zones.html', 'Zones'],
    ['dashboard.html', 'Statistiques'],
    ['bilan-journee.html', 'Bilan du jour']
  ],
  patronne: [
    ['patronne.html', 'Supervision'],
    ['rapports.html', 'Archives'],
    ['livreurs.html', 'Équipe'],
    ['colis.html', 'Colis'],
    ['bilan-journee.html', 'Bilan']
  ]
};

const svgMenu = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';

function currentFile() {
  return window.location.pathname.split('/').pop() || 'index.html';
}

function initDrawer(links) {
  const header = document.querySelector('.app-header');
  if (!header) return;

  // Dispatch has its own menu, including a warning about unsaved parcels.
  if (document.getElementById('dispatchDrawer')) return;
  if (document.getElementById('dkMenuBtn')) return;

  const button = document.createElement('button');
  button.id = 'dkMenuBtn';
  button.type = 'button';
  button.className = 'dk-menu-trigger';
  button.innerHTML = svgMenu;
  button.setAttribute('aria-label', 'Ouvrir le menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'dkNavigationDrawer');
  header.prepend(button);

  const backdrop = document.createElement('div');
  backdrop.id = 'dkNavBackdrop';
  backdrop.className = 'dk-nav-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');

  const drawer = document.createElement('nav');
  drawer.id = 'dkNavigationDrawer';
  drawer.className = 'dk-nav-drawer';
  drawer.setAttribute('aria-label', 'Menu DK Boutique');

  const top = document.createElement('div');
  top.className = 'dk-nav-top';

  const brand = document.createElement('div');
  brand.className = 'dk-nav-brand';
  brand.textContent = 'DK Boutique';

  const close = document.createElement('button');
  close.className = 'dk-nav-close';
  close.type = 'button';
  close.textContent = 'Fermer ×';
  close.setAttribute('aria-label', 'Fermer le menu');
  top.append(brand, close);
  drawer.appendChild(top);

  const current = currentFile();
  const mappedCurrent = current === 'dossier-detail.html' ? 'rapports.html'
    : current === 'livreur-detail.html' ? 'livreurs.html' : current;
  links.forEach(([href, label]) => {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    a.className = 'dk-nav-link';
    if (href === mappedCurrent) a.setAttribute('aria-current', 'page');
    drawer.appendChild(a);
  });

  backdrop.appendChild(drawer);
  document.body.appendChild(backdrop);

  let lastFocus = null;

  function closeDrawer() {
    backdrop.classList.remove('open');
    backdrop.setAttribute('aria-hidden', 'true');
    button.setAttribute('aria-expanded', 'false');
    if (lastFocus?.isConnected) lastFocus.focus();
    lastFocus = null;
  }

  button.addEventListener('click', () => {
    lastFocus = document.activeElement;
    backdrop.classList.add('open');
    backdrop.setAttribute('aria-hidden', 'false');
    button.setAttribute('aria-expanded', 'true');
    close.focus();
  });

  close.addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) closeDrawer();
  });
  document.addEventListener('keydown', event => {
    if (!backdrop.classList.contains('open')) return;
    if (event.key === 'Escape') closeDrawer();
    if (event.key === 'Tab') {
      const items = [close, ...drawer.querySelectorAll('a')];
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
}

async function initNavigation() {
  // Old navigation must never occupy the screen footer.
  document.querySelectorAll('.bottom-nav').forEach(nav => nav.remove());
  document.body.classList.remove('has-bottom-nav');

  let role = null;
  try {
    role = await auth.getCurrentRole();
  } catch (error) {
    console.error('Navigation indisponible:', error);
    return;
  }
  if (!LINKS[role]) return;
  initDrawer(LINKS[role]);
}

document.addEventListener('DOMContentLoaded', initNavigation);
