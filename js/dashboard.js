import { auth } from './auth.js';
import { supabase } from './config.js';
import { formatFcfa, formatDate, createBadge, createEmptyState } from './page-utils.js';

const pendingMoney = document.getElementById('pendingMoney');
const activeTours = document.getElementById('activeTours');
const todayCollected = document.getElementById('todayCollected');
const successRate = document.getElementById('successRate');
const recentList = document.getElementById('recentList');

function localDayBounds(date = new Date()) {
  const start = new Date(date);
  start.setHours(0,0,0,0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.toISOString(), end.toISOString()];
}

async function loadStats() {
  const profileId = await auth.getCurrentProfileId();

  let allQuery = supabase
    .from('v_sorties_resume')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);

  let recentQuery = supabase
    .from('v_sorties_resume')
    .select('id, livreur_nom, zone_nom, statut, created_at, closed_at, nb_colis_total, net_a_encaisser, montant_final, gerant_id')
    .order('created_at', { ascending: false })
    .limit(10);

  if (profileId) {
    allQuery = allQuery.eq('gerant_id', profileId);
    recentQuery = recentQuery.eq('gerant_id', profileId);
  }

  const [allRes, recentRes] = await Promise.all([allQuery, recentQuery]);

  if (allRes.error) throw allRes.error;
  if (recentRes.error) throw recentRes.error;

  const all = allRes.data || [];
  const active = all.filter(x => x.statut === 'en_cours');
  const closed = all.filter(x => x.statut === 'cloturee');

  pendingMoney.textContent = formatFcfa(active.reduce((sum, x) => sum + Number(x.net_a_encaisser || 0), 0));
  activeTours.textContent = String(active.length);

  const [start, end] = localDayBounds();
  const today = closed.filter(x => x.closed_at && x.closed_at >= start && x.closed_at < end);
  todayCollected.textContent = formatFcfa(today.reduce((sum, x) => sum + Number(x.montant_final || 0), 0));

  const totalDelivered = all.reduce((sum, x) => sum + Number(x.nb_livres || 0), 0);
  const totalParcels = all.reduce((sum, x) => sum + Number(x.nb_colis_total || 0), 0);
  const rate = totalParcels > 0 ? Math.round((totalDelivered / totalParcels) * 100) : 0;
  successRate.textContent = `${rate}%`;

  recentList.replaceChildren();
  const recent = recentRes.data || [];
  if (!recent.length) {
    recentList.appendChild(createEmptyState('Aucune activité récente.'));
    return;
  }

  recent.forEach(row => {
    const item = document.createElement('div');
    item.className = 'list-row';
    item.style.cursor = 'pointer';

    const main = document.createElement('div');
    main.className = 'list-main';

    const title = document.createElement('div');
    title.className = 'list-title';
    title.textContent = row.livreur_nom;

    const meta = document.createElement('div');
    meta.className = 'list-meta';
    meta.textContent = `${row.zone_nom} • ${formatDate(row.closed_at || row.created_at, true)} • ${row.nb_colis_total} colis`;

    main.append(title, meta);

    const right = document.createElement('div');
    right.style.textAlign = 'right';
    const amount = document.createElement('div');
    amount.className = 'list-amount';
    amount.textContent = formatFcfa(row.statut === 'cloturee' ? row.montant_final : row.net_a_encaisser);
    right.append(amount, createBadge(row.statut === 'cloturee' ? 'CLÔTURÉE' : 'EN COURS', row.statut === 'cloturee' ? 'success' : 'primary'));

    item.append(main, right);
    item.addEventListener('click', () => {
      window.location.href = `dossier-detail.html?id=${encodeURIComponent(row.id)}`;
    });

    recentList.appendChild(item);
  });
}

async function init() {
  const user = await auth.requireRole(['gerant']);
  if (!user) return;

  try { await loadStats(); }
  catch (err) {
    console.error(err);
    recentList.replaceChildren(createEmptyState('Impossible de charger les statistiques.'));
  }
}

document.addEventListener('DOMContentLoaded', init);
