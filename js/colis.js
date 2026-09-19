import { auth } from './auth.js';
import { supabase } from './config.js';
import { enableAutoSync } from './auto-sync.js';
import { formatFcfa, formatDate, signedPhotoUrl, createEmptyState, createBadge } from './page-utils.js';

const searchInput = document.getElementById('searchInput');
const statusFilter = document.getElementById('statusFilter');
const sourceFilter = document.getElementById('sourceFilter');
const statCount = document.getElementById('statCount');
const statValue = document.getElementById('statValue');
const statDelivered = document.getElementById('statDelivered');
const statReturned = document.getElementById('statReturned');
const parcelList = document.getElementById('parcelList');

let parcels = [];
const tourMap = new Map();

async function loadData() {
  const { data, error } = await supabase
    .from('colis')
    .select('id, sortie_id, source, valeur, commentaire, photo_path, statut_livreur, created_at')
    .order('created_at', { ascending: false })
    .limit(300);

  if (error) throw error;
  parcels = data || [];

  const sortieIds = [...new Set(parcels.map(p => p.sortie_id))];
  tourMap.clear();

  if (sortieIds.length) {
    const role = await auth.getCurrentRole();
    let tourQuery = supabase
      .from('v_sorties_resume')
      .select('id, livreur_nom, zone_nom, statut, created_at, closed_at, gerant_id')
      .in('id', sortieIds);

    if (role === 'gerant') {
      const profileId = await auth.getCurrentProfileId();
      if (profileId) tourQuery = tourQuery.eq('gerant_id', profileId);
    }

    const { data: tours, error: tourError } = await tourQuery;
    if (tourError) throw tourError;
    (tours || []).forEach(t => tourMap.set(t.id, t));

    if (role === 'gerant') {
      parcels = parcels.filter(p => tourMap.has(p.sortie_id));
    }
  }

  await render();
}

async function render() {
  const q = searchInput.value.trim().toLowerCase();
  const status = statusFilter.value;
  const source = sourceFilter.value;

  const rows = parcels.filter(p => {
    if (status && p.statut_livreur !== status) return false;
    if (source && p.source !== source) return false;

    if (q) {
      const tour = tourMap.get(p.sortie_id);
      const haystack = `${tour?.livreur_nom || ''} ${tour?.zone_nom || ''} ${p.commentaire || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });

  statCount.textContent = String(rows.length);
  statValue.textContent = formatFcfa(rows.reduce((sum, p) => sum + Number(p.valeur || 0), 0));
  statDelivered.textContent = String(rows.filter(p => p.statut_livreur === 'livre').length);
  statReturned.textContent = String(rows.filter(p => p.statut_livreur === 'retourne').length);

  parcelList.replaceChildren();
  if (!rows.length) {
    parcelList.appendChild(createEmptyState('Aucun colis pour ces filtres.'));
    return;
  }

  for (const p of rows) {
    const tour = tourMap.get(p.sortie_id);

    const row = document.createElement('div');
    row.className = 'list-row';
    row.style.cursor = 'pointer';

    const img = document.createElement('img');
    img.className = 'parcel-row-img';
    img.alt = 'Colis';
    const url = await signedPhotoUrl(p.photo_path);
    if (url) img.src = url;

    const main = document.createElement('div');
    main.className = 'list-main';

    const title = document.createElement('div');
    title.className = 'list-title';
    title.textContent = Number(p.valeur) === 0 ? 'PAYÉ' : formatFcfa(p.valeur);

    const meta = document.createElement('div');
    meta.className = 'list-meta';
    meta.textContent = `${tour?.livreur_nom || 'Livreur'} • ${tour?.zone_nom || 'Zone'} • ${formatDate(p.created_at, true)}`;

    main.append(title, meta);

    if (p.commentaire) {
      const note = document.createElement('div');
      note.className = 'list-meta';
      note.textContent = p.commentaire;
      main.appendChild(note);
    }

    const right = document.createElement('div');
    const label = p.statut_livreur === 'livre' ? 'LIVRÉ' : p.statut_livreur === 'retourne' ? 'RETOUR' : 'ATTENTE';
    const kind = p.statut_livreur === 'livre' ? 'success' : p.statut_livreur === 'retourne' ? 'danger' : 'warning';
    right.appendChild(createBadge(label, kind));

    row.append(img, main, right);
    row.addEventListener('click', () => {
      window.location.href = `dossier-detail.html?id=${encodeURIComponent(p.sortie_id)}`;
    });

    parcelList.appendChild(row);
  }
}

async function init() {
  const user = await auth.requireRole(['gerant', 'patronne']);
  if (!user) return;

  searchInput.addEventListener('input', () => render().catch(console.error));
  statusFilter.addEventListener('change', () => render().catch(console.error));
  sourceFilter.addEventListener('change', () => render().catch(console.error));

  enableAutoSync(() => loadData(), {
    tables: ['colis', 'sorties', 'sortie_operations'], intervalMs: 30000,
    shouldRefresh: () => !document.activeElement?.matches('input, select, textarea')
  });
  try { await loadData(); }
  catch (err) {
    console.error(err);
    parcelList.replaceChildren(createEmptyState('Impossible de charger les colis.'));
  }
}

document.addEventListener('DOMContentLoaded', init);
