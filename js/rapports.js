import { auth } from './auth.js';
import { supabase } from './config.js';
import { formatFcfa, formatDate, createEmptyState, createBadge } from './page-utils.js';

const searchInput = document.getElementById('searchInput');
const dateInput = document.getElementById('dateInput');
const livreurFilter = document.getElementById('livreurFilter');
const statCount = document.getElementById('statCount');
const statNet = document.getElementById('statNet');
const statColis = document.getElementById('statColis');
const statRetours = document.getElementById('statRetours');
const archiveList = document.getElementById('archiveList');

let archives = [];

async function loadLivreurs() {
  const { data, error } = await supabase
    .from('livreurs')
    .select('id, nom')
    .order('nom');

  if (error) throw error;

  (data || []).forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = l.nom;
    livreurFilter.appendChild(opt);
  });
}

async function loadArchives() {
  const { data, error } = await supabase
    .from('v_sorties_resume')
    .select('*')
    .eq('statut', 'cloturee')
    .order('closed_at', { ascending: false })
    .limit(500);

  if (error) throw error;
  archives = data || [];
  render();
}

function matchesDate(row, date) {
  if (!date) return true;
  if (!row.closed_at) return false;
  const d = new Date(row.closed_at);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  return local === date;
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const date = dateInput.value;
  const livreurId = livreurFilter.value;

  const rows = archives.filter(row => {
    if (livreurId && row.livreur_id !== livreurId) return false;
    if (!matchesDate(row, date)) return false;
    if (q) {
      const haystack = `${row.livreur_nom || ''} ${row.zone_nom || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  statCount.textContent = String(rows.length);
  statNet.textContent = formatFcfa(rows.reduce((s, r) => s + Number(r.montant_final || 0), 0));
  statColis.textContent = String(rows.reduce((s, r) => s + Number(r.nb_colis_final ?? r.nb_colis_total ?? 0), 0));
  statRetours.textContent = formatFcfa(rows.reduce((s, r) => s + Number(r.montant_retours || 0), 0));

  archiveList.replaceChildren();

  if (!rows.length) {
    archiveList.appendChild(createEmptyState('Aucun dossier pour ces filtres.'));
    return;
  }

  rows.forEach(row => {
    const item = document.createElement('div');
    item.className = 'list-row';
    item.style.cursor = 'pointer';

    const main = document.createElement('div');
    main.className = 'list-main';

    const title = document.createElement('div');
    title.className = 'list-title';
    title.textContent = row.livreur_nom || 'Livreur';

    const meta = document.createElement('div');
    meta.className = 'list-meta';
    meta.textContent = `${row.zone_nom || 'Sans zone'} • ${formatDate(row.closed_at, true)} • ${row.nb_colis_final ?? row.nb_colis_total} colis`;

    main.append(title, meta);

    const right = document.createElement('div');
    right.style.textAlign = 'right';
    const amount = document.createElement('div');
    amount.className = 'list-amount';
    amount.textContent = formatFcfa(row.montant_final);
    right.append(amount, createBadge('CLÔTURÉE', 'success'));

    item.append(main, right);
    item.addEventListener('click', () => {
      window.location.href = `dossier-detail.html?id=${encodeURIComponent(row.id)}`;
    });

    archiveList.appendChild(item);
  });
}

async function init() {
  const user = await auth.requireRole(['gerant', 'patronne']);
  if (!user) return;

  [searchInput, dateInput, livreurFilter].forEach(el => {
    el.addEventListener(el.tagName === 'INPUT' && el.type === 'text' ? 'input' : 'change', render);
  });

  try {
    await Promise.all([loadLivreurs(), loadArchives()]);
  } catch (err) {
    console.error(err);
    archiveList.replaceChildren(createEmptyState('Impossible de charger les archives.'));
  }
}

document.addEventListener('DOMContentLoaded', init);
