import { auth } from './auth.js';
import { supabase } from './config.js';
import { enableAutoSync } from './auto-sync.js';
import { correctParcelEntry } from './parcel-corrections.js';
import { formatFcfa, formatDate, getQueryParam, signedPhotoUrl, createEmptyState, createBadge } from './page-utils.js';

const sortieId = getQueryParam('id');
const el = id => document.getElementById(id);

const headerMeta = el('headerMeta');
const dossierId = el('dossierId');
const livreurName = el('livreurName');
const tourMeta = el('tourMeta');
const statusBadge = el('statusBadge');
const backLink = el('backLink');
const exportDossierBtn = el('exportDossierBtn');
const timeline = el('timeline');
const parcelGrid = el('parcelGrid');
const parcelTitle = el('parcelTitle');
const auditPanel = el('auditPanel');
const auditTitle = el('auditTitle');
const auditDetails = el('auditDetails');
const correctionsPanel = el('correctionsPanel');
const correctionsList = el('correctionsList');
const correctionsCount = el('correctionsCount');

const photoViewer = el('photoViewer');
const closeViewerBtn = el('closeViewerBtn');
const viewerImage = el('viewerImage');

let resume = null;
let colis = [];
let ops = [];
let isClosed = false;
let canCorrect = false;
let correctionAvailable = false;
let parcelCorrections = [];

function money(value) {
  return Number(value ?? 0);
}

function getOps(type) {
  return ops.filter(op => op.type === type);
}

function sumOps(type) {
  return getOps(type).reduce((sum, op) => sum + money(op.montant), 0);
}

function csvCell(value) {
  let str = String(value ?? '');
  if (/^\s*[=+@-]/.test(str)) str = "'" + str;
  return '"' + str.replace(/"/g, '""') + '"';
}

function downloadCsv() {
  if (!resume) return;

  const rows = [
    ['DK BOUTIQUE - DOSSIER TOURNÉE', sortieId],
    ['Livreur', resume.livreur_nom],
    ['Zone', resume.zone_nom],
    ['Date départ', formatDate(resume.created_at, true)],
    ['Date clôture', isClosed ? formatDate(resume.closed_at, true) : 'En cours'],
    ['Statut', isClosed ? 'Clôturée' : 'En cours'],
    ['Chargement initial (F CFA)', money(resume.montant_initial)],
    ['Ajouts (F CFA)', money(resume.montant_ajouts)],
    ['Retours confirmés (F CFA)', sumOps('retour')],
    ['Livraisons déduites (F CFA)', sumOps('deduction_livraison')],
    ['Autres frais (F CFA)', sumOps('frais_divers')],
    ['Net à encaisser (F CFA)', isClosed ? money(resume.montant_final) : money(resume.net_a_encaisser)],
    [],
    ['COLIS'],
    ['Identifiant', 'Source', 'Montant (F CFA)', 'Statut livreur', 'Retour confirmé', 'Déduction livraison (F CFA)', 'Commentaire', 'Photo - chemin privé'],
    ...colis.map(c => [
      c.id, c.source, money(c.valeur), c.statut_livreur,
      getOps('retour').some(op => op.colis_id === c.id) ? 'Oui' : 'Non',
      getOps('deduction_livraison').filter(op => op.colis_id === c.id).reduce((sum, op) => sum + money(op.montant), 0),
      c.commentaire || '', c.photo_path || ''
    ]),
    [],
    ['OPÉRATIONS ENREGISTRÉES'],
    ['Identifiant', 'Date', 'Type', 'Colis lié', 'Montant (F CFA)', 'Motif'],
    ...ops.map(op => [op.id, formatDate(op.created_at, true), op.type, op.colis_id || '', money(op.montant), op.commentaire || ''])
  ];

  const csv = '\uFEFF' + rows
    .map(row => row.map(csvCell).join(';'))
    .join('\r\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `dk-boutique-dossier-${sortieId.slice(0, 8)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderSummary() {
  isClosed = resume.statut === 'cloturee';
  dossierId.textContent = `TOURNÉE · ${resume.id.slice(0, 8).toUpperCase()}`;
  livreurName.textContent = resume.livreur_nom || 'Livreur';
  headerMeta.textContent = resume.zone_nom || 'Zone non définie';
  tourMeta.textContent = `Zone : ${resume.zone_nom || 'Non définie'} • Départ : ${formatDate(resume.created_at, true)}${isClosed ? ` • Clôture : ${formatDate(resume.closed_at, true)}` : ''}`;
  statusBadge.textContent = isClosed ? 'CLÔTURÉE' : 'EN COURS';
  statusBadge.className = isClosed ? 'badge badge-success' : 'badge badge-primary';

  el('statLoad').textContent = formatFcfa(resume.montant_chargement);
  el('statReturns').textContent = formatFcfa(resume.montant_retours);
  el('statFees').textContent = formatFcfa(money(resume.deduction_livraison) + money(resume.frais_divers));
  el('statNet').textContent = isClosed && resume.montant_final !== null
    ? formatFcfa(resume.montant_final)
    : formatFcfa(resume.net_a_encaisser);

  el('countInitial').textContent = String(resume.nb_colis_initial ?? 0);
  el('countAdd').textContent = String(resume.nb_colis_ajoutes ?? 0);
  el('countDelivered').textContent = String(resume.nb_livres ?? 0);
  el('countReturns').textContent = String(resume.nb_retours_confirmes ?? 0);

  el('ledgerInitial').textContent = formatFcfa(resume.montant_initial);
  el('ledgerAdds').textContent = `+${formatFcfa(resume.montant_ajouts)}`;
  el('ledgerReturns').textContent = `-${formatFcfa(resume.montant_retours)}`;
  el('ledgerDelivery').textContent = `-${formatFcfa(resume.deduction_livraison)}`;
  el('ledgerFees').textContent = `-${formatFcfa(resume.frais_divers)}`;
  el('netLabel').textContent = isClosed
    ? (parcelCorrections.length ? 'Net rectifié après clôture' : 'Net figé à la clôture')
    : 'Net actuel (provisoire)';
  el('ledgerNet').textContent = isClosed && resume.montant_final !== null
    ? formatFcfa(resume.montant_final)
    : formatFcfa(resume.net_a_encaisser);

  parcelTitle.textContent = `Colis du dossier · ${colis.length}`;
  exportDossierBtn.disabled = false;
}

function renderAudit() {
  const issues = [];
  const parcelIds = new Set(colis.map(parcel => parcel.id));
  const confirmedReturns = getOps('retour');
  const deductions = getOps('deduction_livraison');
  const fees = getOps('frais_divers');
  const closedOps = getOps('cloture');

  const gross = colis.reduce((sum, parcel) => sum + money(parcel.valeur), 0);
  const returns = sumOps('retour');
  const delivery = sumOps('deduction_livraison');
  const expenses = sumOps('frais_divers');
  const rawNet = gross - returns - delivery - expenses;
  const expectedNet = Math.max(0, rawNet);
  const displayedNet = isClosed ? money(resume.montant_final) : money(resume.net_a_encaisser);

  if (!colis.length && !parcelCorrections.length) {
    issues.push('Le dossier ne contient aucun colis.');
  }
  if (rawNet < -0.01) issues.push('Le total des déductions et retours dépasse la valeur du chargement.');
  if (Math.abs(expectedNet - displayedNet) > 0.01) {
    issues.push(`Écart de montant : net reconstitué ${formatFcfa(expectedNet)}, net ${isClosed ? 'figé' : 'affiché'} ${formatFcfa(displayedNet)}.`);
  }
  if (Number(resume.nb_colis_total) !== colis.length) {
    issues.push('Le nombre de colis diffère du récapitulatif.');
  }

  if (isClosed) {
    if (resume.montant_final === null) issues.push('Montant final absent du dossier clôturé.');
    if (Number(resume.nb_colis_final) !== colis.length) issues.push('Le nombre figé à la clôture diffère des colis enregistrés.');
    if (!resume.closed_at) issues.push('Date de clôture absente.');
    if (closedOps.length !== 1) issues.push('L’opération de clôture est absente ou présente plusieurs fois.');
    if (closedOps.length === 1 && Math.abs(money(closedOps[0].montant) - money(resume.montant_final)) > 0.01) {
      issues.push('Le montant enregistré dans l’opération de clôture diffère du montant final.');
    }
    const waiting = colis.filter(c => c.statut_livreur === 'en_attente').length;
    if (waiting) issues.push(`${waiting} colis sont encore marqués « en attente » dans un dossier clôturé.`);
  }

  const uniqueOperations = new Set();
  [...confirmedReturns, ...deductions].forEach(op => {
    const key = `${op.type}:${op.colis_id}`;
    if (!op.colis_id || !parcelIds.has(op.colis_id)) {
      issues.push(`Opération ${op.type} liée à un colis absent du dossier.`);
    }
    if (uniqueOperations.has(key)) issues.push(`Déduction ou retour enregistré plusieurs fois pour le même colis.`);
    uniqueOperations.add(key);
  });

  deductions.forEach(op => {
    const target = colis.find(c => c.id === op.colis_id);
    if (target && money(target.valeur) !== 0) {
      issues.push('Une déduction livraison concerne un colis non payé à l’avance.');
    }
  });

  if (fees.some(op => money(op.montant) <= 0)) {
    issues.push('Un montant de frais est nul ou négatif.');
  }

  auditPanel.classList.toggle('ok', issues.length === 0);
  auditTitle.textContent = issues.length
    ? `Contrôle de cohérence · ${issues.length} point(s) à vérifier`
    : 'Contrôle de cohérence · aucun écart détecté';
  auditDetails.replaceChildren();

  if (!issues.length) {
    const p = document.createElement('p');
    p.textContent = isClosed
      ? 'Les montants et le nombre de colis présents correspondent au récapitulatif figé à la clôture.'
      : 'Le net actuel correspond aux colis et aux opérations enregistrées.';
    auditDetails.appendChild(p);
  } else {
    issues.forEach(issue => {
      const p = document.createElement('p');
      p.textContent = '• ' + issue;
      auditDetails.appendChild(p);
    });
  }
}

function renderCorrections() {
  correctionsList.replaceChildren();
  correctionsPanel.classList.toggle('hidden', !parcelCorrections.length);
  correctionsCount.textContent = parcelCorrections.length ? '· ' + parcelCorrections.length : '';
  parcelCorrections.forEach(correction => {
    const row = document.createElement('div');
    row.className = 'correction-audit-item';
    const title = document.createElement('strong');
    title.textContent = formatDate(correction.cree_at, true)
      + ' · Colis de ' + formatFcfa(correction.valeur) + ' supprimé pour erreur de saisie';
    const detail = document.createElement('div');
    detail.textContent = 'Motif : ' + correction.motif
      + ' · Net avant : ' + formatFcfa(correction.montant_avant)
      + ' · Net corrigé : ' + formatFcfa(correction.montant_apres);
    row.append(title, detail);
    correctionsList.appendChild(row);
  });
}

function renderTimeline() {
  timeline.replaceChildren();

  const events = [{
    time: resume.created_at,
    label: 'Départ de tournée',
    detail: `${resume.nb_colis_initial ?? 0} colis initiaux`,
    amount: money(resume.montant_initial)
  }];

  colis.filter(parcel => parcel.source === 'ajout').forEach(parcel => {
    events.push({
      time: parcel.created_at,
      label: 'Colis supplémentaire',
      detail: parcel.commentaire || 'Ajout à la tournée',
      amount: money(parcel.valeur)
    });
  });

  ops.forEach(op => {
    let label = null;
    let amount = -money(op.montant);
    if (op.type === 'retour') label = 'Retour confirmé';
    else if (op.type === 'deduction_livraison') label = 'Livraison déduite';
    else if (op.type === 'frais_divers') label = 'Frais divers';
    else if (op.type === 'cloture') {
      label = 'Tournée clôturée';
      amount = money(op.montant);
    }
    if (label) events.push({ time: op.created_at, label, detail: op.commentaire || '', amount });
  });

  events.sort((a, b) => new Date(a.time) - new Date(b.time));

  events.forEach(event => {
    const row = document.createElement('div');
    row.className = 'dossier-event';

    const top = document.createElement('div');
    top.className = 'event-top';

    const label = document.createElement('span');
    label.textContent = event.label;

    const when = document.createElement('span');
    when.className = 'event-time';
    when.textContent = formatDate(event.time, true);

    top.append(label, when);

    const detail = document.createElement('div');
    detail.className = 'event-detail';
    detail.textContent = event.detail;

    const amount = document.createElement('div');
    amount.className = 'event-amount';
    amount.textContent = `${event.amount > 0 && event.label !== 'Départ de tournée' ? '+' : ''}${formatFcfa(event.amount)}`;

    row.append(top, detail, amount);
    timeline.appendChild(row);
  });
}

function openPhoto(url) {
  viewerImage.src = url;
  photoViewer.classList.add('open');
  closeViewerBtn.focus();
}

function closePhoto() {
  photoViewer.classList.remove('open');
  viewerImage.removeAttribute('src');
}

async function renderParcels() {
  parcelGrid.replaceChildren();

  if (!colis.length) {
    parcelGrid.appendChild(createEmptyState('Aucun colis enregistré dans ce dossier.'));
    return;
  }

  const returns = new Set(getOps('retour').map(op => op.colis_id));
  const delivery = new Set(getOps('deduction_livraison').map(op => op.colis_id));
  const photoJobs = [];

  colis.forEach((parcel, index) => {
    const card = document.createElement('article');
    card.className = 'parcel-item';

    const imageContainer = document.createElement('div');
    const img = document.createElement('img');
    img.className = 'parcel-photo';
    img.alt = `Photo du colis ${index + 1}`;
    img.loading = 'lazy';

    if (parcel.photo_path) {
      imageContainer.appendChild(img);
      photoJobs.push({ img, path: parcel.photo_path, container: imageContainer });
    } else {
      const missing = document.createElement('div');
      missing.className = 'parcel-photo-empty';
      missing.textContent = 'Photo indisponible';
      imageContainer.appendChild(missing);
    }

    const body = document.createElement('div');
    body.className = 'parcel-body';

    const value = document.createElement('strong');
    value.textContent = Number(parcel.valeur) === 0 ? 'PAYÉ · 0 F' : formatFcfa(parcel.valeur);

    const meta = document.createElement('div');
    meta.className = 'parcel-meta';
    const status = parcel.statut_livreur === 'livre' ? 'Livré'
      : parcel.statut_livreur === 'retourne' ? 'Retour signalé'
        : 'En attente';
    meta.textContent = `Colis n° ${index + 1} · ${parcel.source === 'ajout' ? 'Ajout' : 'Initial'} · ${status}`;

    const flags = document.createElement('div');
    flags.className = 'parcel-flags';
    if (returns.has(parcel.id)) flags.appendChild(createBadge('RETOUR CONFIRMÉ', 'danger'));
    if (delivery.has(parcel.id)) flags.appendChild(createBadge('LIVRAISON DÉDUITE', 'warning'));

    body.append(value, meta, flags);

    if (parcel.commentaire) {
      const note = document.createElement('div');
      note.className = 'parcel-note';
      note.textContent = parcel.commentaire;
      body.appendChild(note);
    }

    if (canCorrect && correctionAvailable) {
      const correctionButton = document.createElement('button');
      correctionButton.className = 'dossier-correct-btn';
      correctionButton.type = 'button';
      correctionButton.textContent = 'Corriger une erreur de saisie';
      correctionButton.addEventListener('click', async () => {
        await correctParcelEntry(parcel, {
          setBusy: busy => {
            correctionButton.disabled = busy;
            correctionButton.textContent = busy ? 'Correction…' : 'Corriger une erreur de saisie';
          },
          notify: (message, error) => {
            if (error) window.alert(message);
            else {
              const status = document.getElementById('dossierCorrectionMessage');
              if (status) status.textContent = message;
            }
          },
          after: () => loadDossier()
        });
      });
      body.appendChild(correctionButton);
    }
    card.append(imageContainer, body);
    parcelGrid.appendChild(card);
  });

  // Limit simultaneous signed URL calls; card order stays stable on screen.
  for (let index = 0; index < photoJobs.length; index += 6) {
    await Promise.all(photoJobs.slice(index, index + 6).map(async job => {
      const url = await signedPhotoUrl(job.path);
      if (!url) {
        job.img.remove();
        const missing = document.createElement('div');
        missing.className = 'parcel-photo-empty';
        missing.textContent = 'Photo indisponible';
        job.container.appendChild(missing);
        return;
      }
      job.img.src = url;
      job.img.addEventListener('click', () => openPhoto(url));
    }));
  }
}

async function loadDossier() {
  const [resumeRes, colisRes, opsRes] = await Promise.all([
    supabase.from('v_sorties_resume').select('*').eq('id', sortieId).maybeSingle(),
    supabase.from('colis').select('id, source, valeur, statut_livreur, commentaire, photo_path, created_at').eq('sortie_id', sortieId).order('created_at'),
    supabase.from('sortie_operations').select('id, sortie_id, colis_id, type, montant, commentaire, created_at').eq('sortie_id', sortieId).order('created_at')
  ]);

  if (resumeRes.error) throw resumeRes.error;
  if (colisRes.error) throw colisRes.error;
  if (opsRes.error) throw opsRes.error;
  if (!resumeRes.data) {
    // Une désactivation depuis une autre tablette masque immédiatement ce dossier.
    resume = null;
    colis = [];
    ops = [];
    parcelGrid.replaceChildren();
    timeline.replaceChildren();
    window.location.replace('rapports.html');
    throw new Error('Dossier masqué ou non autorisé.');
  }

  resume = resumeRes.data;
  colis = colisRes.data || [];
  ops = opsRes.data || [];

  const { data: correctedRows, error: correctionsError } = await supabase
    .rpc('consulter_corrections_colis', { p_sortie_id: sortieId });
  correctionAvailable = !correctionsError;
  parcelCorrections = correctionAvailable ? correctedRows || [] : [];
  renderCorrections();
  renderSummary();
  renderAudit();
  renderTimeline();
  await renderParcels();
}

async function init() {
  if (!sortieId || !/^[0-9a-f-]{36}$/i.test(sortieId)) {
    window.location.replace('rapports.html');
    return;
  }

  const user = await auth.requireRole(['gerant', 'patronne']);
  if (!user) return;

  try {
    const role = await auth.getCurrentRole();
    canCorrect = role === 'gerant';
    if (role === 'gerant') {
      const profileId = await auth.getCurrentProfileId();
      if (!profileId) throw new Error('Profil Gérant indisponible.');
      // Match the archive list's dossier scope: only this manager's tours.
      const { data, error } = await supabase
        .from('sorties')
        .select('id')
        .eq('id', sortieId)
        .eq('gerant_id', profileId)
        .maybeSingle();
      if (error || !data) throw new Error('Dossier introuvable ou non autorisé.');
    }

    backLink.href = 'rapports.html';
    exportDossierBtn.addEventListener('click', downloadCsv);
    closeViewerBtn.addEventListener('click', closePhoto);
    photoViewer.addEventListener('click', event => {
      if (event.target === photoViewer) closePhoto();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && photoViewer.classList.contains('open')) closePhoto();
    });

    await loadDossier();
    enableAutoSync(() => loadDossier(), {
      tables: ['sorties', 'colis', 'sortie_operations'], intervalMs: 30000,
      shouldRefresh: () => !photoViewer.classList.contains('open')
    });
  } catch (error) {
    console.error('Dossier:', error);
    auditDetails.replaceChildren();
    const p = document.createElement('p');
    p.textContent = 'Impossible de charger le dossier ou accès non autorisé.';
    auditDetails.appendChild(p);
    timeline.replaceChildren(createEmptyState('Dossier indisponible.'));
    parcelGrid.replaceChildren();
    exportDossierBtn.disabled = true;
  }
}

document.addEventListener('DOMContentLoaded', init);
