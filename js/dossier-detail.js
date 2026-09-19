import { auth } from './auth.js';
import { supabase } from './config.js';
import { formatFcfa, formatDate, getQueryParam, signedPhotoUrl, createEmptyState } from './page-utils.js';

const sortieId = getQueryParam('id');

const headerMeta = document.getElementById('headerMeta');
const statLoad = document.getElementById('statLoad');
const statReturns = document.getElementById('statReturns');
const statFees = document.getElementById('statFees');
const statNet = document.getElementById('statNet');
const livreurName = document.getElementById('livreurName');
const tourMeta = document.getElementById('tourMeta');
const statusBadge = document.getElementById('statusBadge');
const countInitial = document.getElementById('countInitial');
const countAdd = document.getElementById('countAdd');
const countDelivered = document.getElementById('countDelivered');
const countReturns = document.getElementById('countReturns');
const timeline = document.getElementById('timeline');
const parcelGrid = document.getElementById('parcelGrid');

let resume = null;
let colis = [];
let ops = [];

function addTimeline(time, title, detail, amount = null) {
  const item = document.createElement('div');
  item.className = 'timeline-entry';

  const when = document.createElement('div');
  when.className = 'text-sm text-muted';
  when.textContent = formatDate(time, true);

  const titleEl = document.createElement('div');
  titleEl.className = 'font-bold';
  titleEl.textContent = title;

  const detailEl = document.createElement('div');
  detailEl.className = 'text-sm text-muted';
  detailEl.textContent = detail || '';

  item.append(when, titleEl, detailEl);

  if (amount !== null) {
    const amountEl = document.createElement('div');
    amountEl.className = 'font-bold';
    amountEl.textContent = formatFcfa(amount);
    item.appendChild(amountEl);
  }

  timeline.appendChild(item);
}

async function renderParcels() {
  parcelGrid.replaceChildren();

  if (!colis.length) {
    parcelGrid.appendChild(createEmptyState('Aucun colis.'));
    return;
  }

  for (const parcel of colis) {
    const card = document.createElement('div');
    card.className = 'parcel-item';

    const img = document.createElement('img');
    img.alt = 'Colis';
    const url = await signedPhotoUrl(parcel.photo_path);
    if (url) img.src = url;

    const body = document.createElement('div');
    body.className = 'parcel-body';

    const value = document.createElement('div');
    value.className = 'font-bold';
    value.textContent = Number(parcel.valeur) === 0 ? 'PAYÉ' : formatFcfa(parcel.valeur);

    const meta = document.createElement('div');
    meta.className = 'text-sm text-muted';
    const source = parcel.source === 'ajout' ? 'Ajout' : 'Initial';
    const status = parcel.statut_livreur === 'livre' ? 'Livré' : parcel.statut_livreur === 'retourne' ? 'Retour signalé' : 'En attente';
    meta.textContent = `${source} • ${status}`;

    body.append(value, meta);

    if (parcel.commentaire) {
      const note = document.createElement('div');
      note.className = 'text-sm';
      note.style.marginTop = '.35rem';
      note.textContent = parcel.commentaire;
      body.appendChild(note);
    }

    card.append(img, body);
    parcelGrid.appendChild(card);
  }
}

function renderTimeline() {
  timeline.replaceChildren();

  const events = [];
  events.push({
    time: resume.created_at,
    title: 'Départ de la tournée',
    detail: `${resume.nb_colis_initial} colis initiaux`,
    amount: Number(resume.montant_initial || 0)
  });

  colis.filter(c => c.source === 'ajout').forEach(c => {
    events.push({
      time: c.created_at,
      title: 'Colis supplémentaire',
      detail: c.commentaire || 'Ajout à la tournée',
      amount: Number(c.valeur || 0)
    });
  });

  ops.forEach(op => {
    if (op.type === 'retour') {
      events.push({ time: op.created_at, title: 'Retour confirmé', detail: op.commentaire || '', amount: -Number(op.montant || 0) });
    } else if (op.type === 'deduction_livraison') {
      events.push({ time: op.created_at, title: 'Livraison déduite', detail: op.commentaire || '', amount: -Number(op.montant || 0) });
    } else if (op.type === 'frais_divers') {
      events.push({ time: op.created_at, title: 'Frais divers', detail: op.commentaire || '', amount: -Number(op.montant || 0) });
    } else if (op.type === 'cloture') {
      events.push({ time: op.created_at, title: 'Tournée clôturée', detail: 'Encaissement validé', amount: Number(op.montant || 0) });
    }
  });

  events.sort((a, b) => new Date(a.time) - new Date(b.time));
  events.forEach(ev => addTimeline(ev.time, ev.title, ev.detail, ev.amount));
}

function renderSummary() {
  headerMeta.textContent = `${resume.livreur_nom} • ${resume.zone_nom}`;
  livreurName.textContent = resume.livreur_nom;
  tourMeta.textContent = `${resume.zone_nom} • Départ ${formatDate(resume.created_at, true)}`;

  statusBadge.textContent = resume.statut === 'cloturee' ? 'CLÔTURÉE' : 'EN COURS';
  statusBadge.className = `badge ${resume.statut === 'cloturee' ? 'badge-success' : 'badge-primary'}`;

  statLoad.textContent = formatFcfa(resume.montant_chargement);
  statReturns.textContent = formatFcfa(resume.montant_retours);
  statFees.textContent = formatFcfa(Number(resume.deduction_livraison || 0) + Number(resume.frais_divers || 0));
  statNet.textContent = formatFcfa(resume.statut === 'cloturee' ? resume.montant_final : resume.net_a_encaisser);

  countInitial.textContent = String(resume.nb_colis_initial || 0);
  countAdd.textContent = String(resume.nb_colis_ajoutes || 0);
  countDelivered.textContent = String(resume.nb_livres || 0);
  countReturns.textContent = String(resume.nb_retours_confirmes || 0);
}

async function load() {
  const [resumeRes, colisRes, opsRes] = await Promise.all([
    supabase.from('v_sorties_resume').select('*').eq('id', sortieId).maybeSingle(),
    supabase.from('colis').select('*').eq('sortie_id', sortieId).order('created_at'),
    supabase.from('sortie_operations').select('*').eq('sortie_id', sortieId).order('created_at')
  ]);

  if (resumeRes.error) throw resumeRes.error;
  if (!resumeRes.data) throw new Error('Tournée introuvable.');
  if (colisRes.error) throw colisRes.error;
  if (opsRes.error) throw opsRes.error;

  resume = resumeRes.data;
  colis = colisRes.data || [];
  ops = opsRes.data || [];

  renderSummary();
  renderTimeline();
  await renderParcels();
}

async function init() {
  if (!sortieId) {
    window.location.replace('rapports.html');
    return;
  }

  const user = await auth.requireRole(['gerant', 'patronne']);
  if (!user) return;

  try {
    await load();
  } catch (err) {
    console.error(err);
    timeline.replaceChildren(createEmptyState(err.message || 'Impossible de charger ce dossier.'));
  }
}

document.addEventListener('DOMContentLoaded', init);
