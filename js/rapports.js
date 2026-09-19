import { auth } from './auth.js';
import { supabase } from './config.js';
import { enableAutoSync } from './auto-sync.js';
import { formatFcfa, formatDate, createEmptyState, createBadge } from './page-utils.js';

const PAGE_SIZE = 50;

const searchInput = document.getElementById('searchInput');
const dateInput = document.getElementById('dateInput');
const livreurFilter = document.getElementById('livreurFilter');
const resetFiltersBtn = document.getElementById('resetFiltersBtn');
const exportBtn = document.getElementById('exportBtn');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const archiveFeedback = document.getElementById('archiveFeedback');
const resultCount = document.getElementById('resultCount');
const statsNotice = document.getElementById('statsNotice');
const backLink = document.getElementById('backLink');
const statCount = document.getElementById('statCount');
const statNet = document.getElementById('statNet');
const statColis = document.getElementById('statColis');
const statRetours = document.getElementById('statRetours');
const archiveList = document.getElementById('archiveList');

let archives = [];
let role = null;
let profileId = null;
let totalCount = null;
let requestSerial = 0;
let searchTimer = null;
let isLoading = false;

function safeSearch(value) {
  // Search via PostgREST's OR syntax: exclude all query-control characters.
  return String(value || '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().slice(0, 80);
}

function csvCell(value) {
  let text = String(value ?? '');
  // Prevent spreadsheet formula execution in exported user-supplied text.
  if (/^\s*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function csvNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? String(number).replace('.', ',') : '0';
}

function downloadCsv() {
  if (!archives.length) return;

  const fields = [
    'Identifiant de tournée', 'Livreur', 'Zone', 'Départ',
    'Clôture', 'Colis', 'Chargement initial (F CFA)',
    'Ajouts (F CFA)', 'Retours confirmés (F CFA)',
    'Livraisons déduites (F CFA)', 'Autres frais (F CFA)',
    'Net enregistré après corrections (F CFA)'
  ];

  const rows = archives.map(row => [
    row.id, row.livreur_nom, row.zone_nom,
    formatDate(row.created_at, true), formatDate(row.closed_at, true),
    row.nb_colis_final ?? row.nb_colis_total ?? 0,
    csvNumber(row.montant_initial), csvNumber(row.montant_ajouts),
    csvNumber(row.montant_retours), csvNumber(row.deduction_livraison),
    csvNumber(row.frais_divers), csvNumber(row.montant_final)
  ]);

  const contents = '\uFEFF' + [fields, ...rows]
    .map(values => values.map(csvCell).join(';'))
    .join('\r\n');

  const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `dk-boutique-archives-${dateInput.value || new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadLivreurs() {
  const { data, error } = await supabase
    .from('livreurs')
    .select('id, nom')
    .order('nom');

  if (error) throw error;

  livreurFilter.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Tous les livreurs';
  livreurFilter.appendChild(all);

  (data || []).forEach(livreur => {
    const option = document.createElement('option');
    option.value = livreur.id;
    option.textContent = livreur.nom;
    livreurFilter.appendChild(option);
  });
}

function render() {
  statCount.textContent = String(archives.length);
  statNet.textContent = formatFcfa(archives.reduce((sum, row) => sum + Number(row.montant_final || 0), 0));
  statColis.textContent = String(archives.reduce((sum, row) => sum + Number(row.nb_colis_final ?? row.nb_colis_total ?? 0), 0));
  statRetours.textContent = formatFcfa(archives.reduce((sum, row) => sum + Number(row.montant_retours || 0), 0));

  const denominator = totalCount === null ? '?' : String(totalCount);
  resultCount.textContent = `${archives.length} / ${denominator} dossiers`;

  statsNotice.textContent = totalCount !== null && archives.length < totalCount
    ? `Les montants et l'export concernent uniquement les ${archives.length} dossiers chargés sur ${totalCount}. Chargez la suite pour inclure d'autres dossiers.`
    : 'Les totaux et l’export concernent les dossiers correspondant aux filtres actuels.';

  exportBtn.disabled = !archives.length;
  loadMoreBtn.classList.toggle('hidden', totalCount === null || archives.length >= totalCount);

  archiveList.replaceChildren();

  if (!archives.length) {
    archiveList.appendChild(createEmptyState(
      isLoading ? 'Chargement des dossiers…' : 'Aucun dossier clôturé pour ces filtres.'
    ));
    return;
  }

  const fragment = document.createDocumentFragment();

  archives.forEach(row => {
    const item = document.createElement('a');
    item.className = 'archive-item';
    item.href = `dossier-detail.html?id=${encodeURIComponent(row.id)}`;
    item.setAttribute('aria-label', `Ouvrir le dossier de ${row.livreur_nom || 'livreur'} clôturé le ${formatDate(row.closed_at, true)}`);

    const main = document.createElement('div');
    main.className = 'archive-item-main';

    const title = document.createElement('div');
    title.className = 'archive-item-title';
    title.textContent = row.livreur_nom || 'Livreur';

    const meta = document.createElement('div');
    meta.className = 'archive-item-meta';
    meta.textContent = `${row.zone_nom || 'Zone non définie'} • ${formatDate(row.closed_at, true)} • ${row.nb_colis_final ?? row.nb_colis_total ?? 0} colis`;

    main.append(title, meta);

    const right = document.createElement('div');
    right.className = 'archive-item-right';

    const amount = document.createElement('div');
    amount.className = 'archive-item-amount';
    amount.textContent = row.montant_final === null
      ? 'Montant non figé'
      : formatFcfa(row.montant_final);

    right.append(amount, createBadge('CLÔTURÉE', 'success'));
    item.append(main, right);
    fragment.appendChild(item);
  });

  archiveList.appendChild(fragment);
}

async function loadArchives(reset = false) {
  const ticket = ++requestSerial;

  if (reset) {
    archives = [];
    totalCount = null;
  }

  isLoading = true;
  loadMoreBtn.disabled = true;
  archiveFeedback.textContent = 'Chargement en cours…';
  render();

  try {
    let query = supabase
      .from('v_sorties_resume')
      .select(
        'id, livreur_id, livreur_nom, zone_nom, created_at, closed_at, nb_colis_final, nb_colis_total, montant_initial, montant_ajouts, montant_retours, deduction_livraison, frais_divers, montant_final',
        { count: 'exact' }
      )
      .eq('statut', 'cloturee')
      .order('closed_at', { ascending: false })
      .order('id', { ascending: false })
      .range(archives.length, archives.length + PAGE_SIZE - 1);

    if (role === 'gerant') {
      if (!profileId) throw new Error('Profil Gérant indisponible.');
      query = query.eq('gerant_id', profileId);
    }

    if (livreurFilter.value) query = query.eq('livreur_id', livreurFilter.value);

    if (dateInput.value) {
      const start = new Date(`${dateInput.value}T00:00:00`);
      const end = new Date(start.getTime());
      end.setDate(end.getDate() + 1);
      query = query.gte('closed_at', start.toISOString()).lt('closed_at', end.toISOString());
    }

    const search = safeSearch(searchInput.value);
    if (search) {
      query = query.or(`livreur_nom.ilike.%${search}%,zone_nom.ilike.%${search}%`);
    }

    const { data, error, count } = await query;
    if (ticket !== requestSerial) return;
    if (error) throw error;

    const existing = new Set(archives.map(row => row.id));
    for (const row of data || []) {
      if (!existing.has(row.id)) {
        archives.push(row);
        existing.add(row.id);
      }
    }
    totalCount = count ?? archives.length;
    archiveFeedback.textContent = totalCount > archives.length
      ? 'Chargez la suite pour consulter davantage de dossiers.'
      : 'Fin des dossiers correspondant à votre recherche.';
  } catch (error) {
    if (ticket !== requestSerial) return;
    console.error('Chargement archives:', error);
    archiveFeedback.textContent = 'Impossible de charger les archives. Réessayez.';
    if (!archives.length) totalCount = null;
  } finally {
    if (ticket === requestSerial) {
      isLoading = false;
      loadMoreBtn.disabled = false;
      render();
    }
  }
}

async function init() {
  const user = await auth.requireRole(['gerant', 'patronne']);
  if (!user) return;

  try {
    role = await auth.getCurrentRole();
    if (role === 'gerant') {
      profileId = await auth.getCurrentProfileId();
      if (!profileId) throw new Error('Profil Gérant indisponible.');
    }
    backLink.href = role === 'patronne' ? 'patronne.html' : 'dashboard.html';

    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadArchives(true), 350);
    });

    [dateInput, livreurFilter].forEach(input => {
      input.addEventListener('change', () => loadArchives(true));
    });

    resetFiltersBtn.addEventListener('click', () => {
      clearTimeout(searchTimer);
      searchInput.value = '';
      dateInput.value = '';
      livreurFilter.value = '';
      loadArchives(true);
    });

    exportBtn.addEventListener('click', downloadCsv);
    loadMoreBtn.addEventListener('click', () => {
      if (!isLoading) loadArchives(false);
    });

    await Promise.all([loadLivreurs(), loadArchives(true)]);
    enableAutoSync(() => loadArchives(true), {
      tables: ['sorties'], intervalMs: 45000,
      shouldRefresh: () => !isLoading && archives.length <= PAGE_SIZE
        && !document.activeElement?.matches('input, textarea, select')
    });
  } catch (error) {
    console.error('Initialisation archives:', error);
    archiveFeedback.textContent = 'Impossible d’ouvrir les archives. Vérifiez votre connexion ou vos droits.';
    archiveList.replaceChildren(createEmptyState('Les archives sont indisponibles.'));
  }
}

document.addEventListener('DOMContentLoaded', init);
