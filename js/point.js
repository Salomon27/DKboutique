import { auth } from './auth.js';
import { supabase } from './config.js';
import { compressImage } from './colis-utils.js';

const tourneeSelect = document.getElementById('tourneeSelect');
const tourneeLoadError = document.getElementById('tourneeLoadError');
const reloadTourneesBtn = document.getElementById('reloadTourneesBtn');

function displayLoadError(error) {
  const code = String(error?.code || '');
  const missingView = code === '42703' || code === 'PGRST204' || /gerant_id.*does not exist|column.*gerant_id/i.test(String(error?.message || ''));
  tourneeLoadError.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = missingView
    ? 'Base Supabase à mettre à jour'
    : 'Impossible de charger les tournées';
  const detail = document.createElement('span');
  detail.textContent = missingView
    ? 'La vue des tournées ne contient pas encore la colonne gerant_id. Exécutez supabase/LIVE_APP_REPAIR.sql dans Supabase → SQL Editor.'
    : [code, error?.message].filter(Boolean).join(' · ') || 'Vérifiez votre connexion et réessayez.';
  tourneeLoadError.append(title, detail);
  tourneeLoadError.classList.remove('hidden');
  reloadTourneesBtn.classList.remove('hidden');
}

function clearLoadError() {
  tourneeLoadError.classList.add('hidden');
  reloadTourneesBtn.classList.add('hidden');
  tourneeLoadError.replaceChildren();
}
const noSortieState = document.getElementById('noSortieState');
const pointContent = document.getElementById('pointContent');
const livreurName = document.getElementById('livreurName');
const zoneName = document.getElementById('zoneName');
const chargementAmount = document.getElementById('chargementAmount');
const totalColisCount = document.getElementById('totalColisCount');
const livresCount = document.getElementById('livresCount');
const retoursSignalesCount = document.getElementById('retoursSignalesCount');
const attenteCount = document.getElementById('attenteCount');

const recapChargement = document.getElementById('recapChargement');
const recapAjouts = document.getElementById('recapAjouts');
const recapRetours = document.getElementById('recapRetours');
const recapDeductions = document.getElementById('recapDeductions');
const recapFrais = document.getElementById('recapFrais');
const recapNet = document.getElementById('recapNet');
const closeBar = document.getElementById('closeBar');
const closeBarNet = document.getElementById('closeBarNet');
const cloturerBtn = document.getElementById('cloturerBtn');

const controlCard = document.getElementById('controlCard');
const controlTitle = document.getElementById('controlTitle');
const controlList = document.getElementById('controlList');

const tabs = [...document.querySelectorAll('.point-tab')];
const panels = [...document.querySelectorAll('.point-panel')];

const photoInput = document.getElementById('photoInput');
const cameraPreview = document.getElementById('cameraPreview');
const photoPlaceholder = document.getElementById('photoPlaceholder');
const montantInput = document.getElementById('montantInput');
const isPaidCheckbox = document.getElementById('isPaidCheckbox');
const noteInput = document.getElementById('noteInput');
const addColisBtn = document.getElementById('addColisBtn');

const retoursList = document.getElementById('retoursList');
const retoursSelectionInfo = document.getElementById('retoursSelectionInfo');
const confirmRetoursBtn = document.getElementById('confirmRetoursBtn');
const pendingReturnBadge = document.getElementById('pendingReturnBadge');

const livraisonsList = document.getElementById('livraisonsList');

const fraisMontant = document.getElementById('fraisMontant');
const fraisMotif = document.getElementById('fraisMotif');
const addFraisBtn = document.getElementById('addFraisBtn');
const fraisList = document.getElementById('fraisList');

const timelineContainer = document.getElementById('timelineContainer');
const toastStack = document.getElementById('toastStack');

let activeSorties = [];
let currentSortieId = null;
let currentResume = null;
let currentColis = [];
let currentOps = [];
let selectedForRetour = new Set();
let realtimeChannel = null;
let refreshTimer = null;
let previewUrl = null;
let currentProfileId = null;

const signedUrlCache = new Map();

function formatFcfa(value) {
  return `${Number(value || 0).toLocaleString('fr-FR')} F`;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'point-toast';
  toast.textContent = message;
  toastStack.appendChild(toast);
  gsap.to(toast, { opacity: 1, y: 4, duration: .2 });
  setTimeout(() => {
    gsap.to(toast, {
      opacity: 0,
      y: -4,
      duration: .2,
      onComplete: () => toast.remove()
    });
  }, 2600);
}

function clearPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  photoInput.value = '';
  cameraPreview.removeAttribute('src');
  cameraPreview.style.display = 'none';
  photoPlaceholder.style.display = 'block';
}

function setBusy(button, busy, label, busyLabel = 'TRAITEMENT...') {
  button.disabled = busy;
  button.textContent = busy ? busyLabel : label;
}

async function init() {
  const user = await auth.requireRole(['gerant']);
  if (!user) return;

  try {
    currentProfileId = await auth.getCurrentProfileId();
    if (!currentProfileId) throw new Error('Profil Gérant introuvable. Reconnectez-vous.');
    setupUI();
    await loadSortiesEnCours();
  } catch (error) {
    console.error('Initialisation Point:', error);
    displayLoadError(error);
  }
}

function setupUI() {
  tourneeSelect.addEventListener('change', async () => {
    const id = tourneeSelect.value;

    if (!id) {
      resetSelection();
      return;
    }

    currentSortieId = id;
    noSortieState.classList.add('hidden');
    pointContent.classList.remove('hidden');
    closeBar.classList.add('visible');

    try {
      clearLoadError();
      await refreshPointData();
      if (currentSortieId === id) setupRealtime();
    } catch (error) {
      console.error('Chargement du Point:', error);
      displayLoadError(error);
      resetSelection();
      tourneeSelect.value = '';
    }
  });

  reloadTourneesBtn.addEventListener('click', async () => {
    reloadTourneesBtn.disabled = true;
    try { await loadSortiesEnCours(); }
    finally { reloadTourneesBtn.disabled = false; }
  });

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const panelId = tab.dataset.panel;
      const panel = document.getElementById(panelId);
      const wasOpen = panel.classList.contains('active');

      panels.forEach(p => p.classList.remove('active'));
      tabs.forEach(b => {
        b.classList.remove('btn-primary');
        b.classList.add('btn-outline');
      });

      if (!wasOpen) {
        panel.classList.add('active');
        tab.classList.remove('btn-outline');
        tab.classList.add('btn-primary');
      }
    });
  });

  isPaidCheckbox.addEventListener('change', () => {
    montantInput.value = isPaidCheckbox.checked ? '0' : '';
    montantInput.disabled = isPaidCheckbox.checked;
  });

  photoInput.addEventListener('change', () => {
    // Do not clear the file input here: it contains the photo just selected.
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    cameraPreview.removeAttribute('src');
    cameraPreview.style.display = 'none';
    photoPlaceholder.style.display = 'block';

    const file = photoInput.files?.[0];
    if (!file) return;

    previewUrl = URL.createObjectURL(file);
    cameraPreview.src = previewUrl;
    cameraPreview.style.display = 'block';
    photoPlaceholder.style.display = 'none';
  });

  addColisBtn.addEventListener('click', handleAddColis);
  confirmRetoursBtn.addEventListener('click', handleConfirmRetours);
  addFraisBtn.addEventListener('click', handleAddFrais);
  cloturerBtn.addEventListener('click', handleCloture);
}

function resetSelection() {
  cleanupRealtime();
  currentSortieId = null;
  currentResume = null;
  currentColis = [];
  currentOps = [];
  selectedForRetour.clear();
  pointContent.classList.add('hidden');
  noSortieState.classList.remove('hidden');
  closeBar.classList.remove('visible');
}

async function loadSortiesEnCours() {
  if (!currentProfileId) {
    displayLoadError(new Error('Profil Gérant introuvable. Reconnectez-vous.'));
    return;
  }
  tourneeSelect.disabled = true;
  let query = supabase
    .from('v_sorties_resume')
    .select('id, livreur_nom, zone_nom, nb_colis_total, net_a_encaisser, created_at, gerant_id')
    .eq('statut', 'en_cours')
    .order('created_at', { ascending: false });

  query = query.eq('gerant_id', currentProfileId);

  const { data, error } = await query;
  if (error) {
    console.error('Lecture des tournées:', error);
    displayLoadError(error);
    tourneeSelect.disabled = true;
    tourneeSelect.replaceChildren();
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Chargement indisponible';
    tourneeSelect.appendChild(option);
    return;
  }

  clearLoadError();

  activeSorties = data || [];

  const previousValue = currentSortieId;
  tourneeSelect.replaceChildren();

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = activeSorties.length
    ? '-- Choisir une tournée en cours --'
    : '-- Aucune tournée en cours --';
  tourneeSelect.appendChild(placeholder);

  activeSorties.forEach(sortie => {
    const option = document.createElement('option');
    option.value = sortie.id;
    option.textContent = `${sortie.livreur_nom} • ${sortie.zone_nom} • ${formatFcfa(sortie.net_a_encaisser)}`;
    tourneeSelect.appendChild(option);
  });

  if (previousValue && activeSorties.some(s => s.id === previousValue)) {
    tourneeSelect.value = previousValue;
  }
  tourneeSelect.disabled = false;
}

async function refreshPointData() {
  if (!currentSortieId) return;

  const [resumeRes, colisRes, opsRes] = await Promise.all([
    supabase.from('v_sorties_resume').select('*').eq('id', currentSortieId).maybeSingle(),
    supabase.from('colis').select('*').eq('sortie_id', currentSortieId).order('created_at', { ascending: true }),
    supabase.from('sortie_operations').select('*').eq('sortie_id', currentSortieId).order('created_at', { ascending: true })
  ]);

  if (resumeRes.error) throw resumeRes.error;
  if (colisRes.error) throw colisRes.error;
  if (opsRes.error) throw opsRes.error;

  if (!resumeRes.data || resumeRes.data.statut !== 'en_cours') {
    showToast('Cette tournée n’est plus disponible.');
    await loadSortiesEnCours();
    resetSelection();
    return;
  }

  currentResume = resumeRes.data;
  currentColis = colisRes.data || [];
  currentOps = opsRes.data || [];

  const validSelectedIds = new Set(
    currentColis
      .filter(c => !hasOperation(c.id, 'retour'))
      .map(c => c.id)
  );
  selectedForRetour = new Set([...selectedForRetour].filter(id => validSelectedIds.has(id)));

  await renderAll();
}

function hasOperation(colisId, type) {
  return currentOps.some(op => op.colis_id === colisId && op.type === type);
}

function getOperation(colisId, type) {
  return currentOps.find(op => op.colis_id === colisId && op.type === type) || null;
}

async function renderAll() {
  renderHeader();
  renderFrais();
  renderTimeline();
  renderFinance();
  renderControl();
  await Promise.all([renderRetours(), renderLivraisons()]);
}

function renderHeader() {
  livreurName.textContent = currentResume.livreur_nom || 'Livreur';
  zoneName.textContent = currentResume.zone_nom || 'Zone';
  chargementAmount.textContent = formatFcfa(currentResume.montant_chargement);
  totalColisCount.textContent = String(Number(currentResume.nb_colis_total || 0));
  livresCount.textContent = String(Number(currentResume.nb_livres || 0));
  retoursSignalesCount.textContent = String(Number(currentResume.nb_retour_signale || 0));
  attenteCount.textContent = String(Number(currentResume.nb_en_attente || 0));
}

async function photoElement(photoPath) {
  if (!photoPath) {
    const empty = document.createElement('div');
    empty.className = 'point-thumb-empty';
    empty.textContent = 'Pas de photo';
    return empty;
  }

  const img = document.createElement('img');
  img.className = 'point-thumb';
  img.alt = 'Colis';

  const url = await getSignedPhotoUrl(photoPath);
  if (url) img.src = url;
  else {
    const empty = document.createElement('div');
    empty.className = 'point-thumb-empty';
    empty.textContent = 'Photo indisponible';
    return empty;
  }

  return img;
}

async function renderRetours() {
  retoursList.replaceChildren();

  const rows = [...currentColis].sort((a, b) => {
    const aSignal = a.statut_livreur === 'retourne' ? 1 : 0;
    const bSignal = b.statut_livreur === 'retourne' ? 1 : 0;
    if (aSignal !== bSignal) return bSignal - aSignal;
    return new Date(a.created_at) - new Date(b.created_at);
  });

  const pendingSignaled = rows.filter(c => c.statut_livreur === 'retourne' && !hasOperation(c.id, 'retour')).length;
  pendingReturnBadge.textContent = `${pendingSignaled} À CONFIRMER`;

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Aucun colis dans cette tournée.';
    retoursList.appendChild(empty);
    updateReturnSelection();
    return;
  }

  for (const colis of rows) {
    const confirmedOp = getOperation(colis.id, 'retour');
    const row = document.createElement('div');
    row.className = 'point-colis-row';

    row.appendChild(await photoElement(colis.photo_path));

    const main = document.createElement('div');
    main.className = 'point-colis-main';

    const title = document.createElement('div');
    title.className = 'point-colis-title';
    title.textContent = Number(colis.valeur) === 0 ? 'PAYÉ — 0 F' : formatFcfa(colis.valeur);

    const meta = document.createElement('div');
    meta.className = 'point-colis-meta';
    meta.textContent = colis.commentaire || (colis.source === 'ajout' ? 'Colis ajouté' : 'Colis initial');

    main.append(title, meta);

    if (colis.statut_livreur === 'retourne' && !confirmedOp) {
      const signal = document.createElement('span');
      signal.className = 'signal-badge';
      signal.textContent = 'SIGNALÉ RETOUR PAR LIVREUR';
      main.appendChild(signal);
    }

    row.appendChild(main);

    const action = document.createElement('div');

    if (confirmedOp) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-danger';
      badge.textContent = 'CONFIRMÉ';
      action.appendChild(badge);

      const cancel = document.createElement('button');
      cancel.className = 'btn btn-outline operation-delete';
      cancel.style.marginTop = '6px';
      cancel.textContent = 'Annuler';
      cancel.addEventListener('click', () => deleteOperation(confirmedOp.id, 'Annuler ce retour confirmé ?'));
      action.appendChild(cancel);
    } else {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'row-check';
      checkbox.checked = selectedForRetour.has(colis.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedForRetour.add(colis.id);
        else selectedForRetour.delete(colis.id);
        updateReturnSelection();
      });
      action.appendChild(checkbox);
    }

    row.appendChild(action);
    retoursList.appendChild(row);
  }

  updateReturnSelection();
}

function updateReturnSelection() {
  const count = selectedForRetour.size;
  const selectedAmount = [...selectedForRetour].reduce((sum, id) => {
    const colis = currentColis.find(c => c.id === id);
    return sum + Number(colis?.valeur || 0);
  }, 0);

  retoursSelectionInfo.textContent = count
    ? `${count} colis • ${formatFcfa(selectedAmount)} à retirer`
    : '0 colis sélectionné';

  confirmRetoursBtn.disabled = count === 0;
}

async function renderLivraisons() {
  livraisonsList.replaceChildren();

  const paid = currentColis.filter(c => Number(c.valeur) === 0 && !hasOperation(c.id, 'retour'));

  if (!paid.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Aucun colis déjà payé à traiter.';
    livraisonsList.appendChild(empty);
    return;
  }

  for (const colis of paid) {
    const existing = getOperation(colis.id, 'deduction_livraison');
    const row = document.createElement('div');
    row.className = 'point-colis-row';

    row.appendChild(await photoElement(colis.photo_path));

    const main = document.createElement('div');
    main.className = 'point-colis-main';

    const title = document.createElement('div');
    title.className = 'point-colis-title';
    title.textContent = 'PAYÉ — 0 F';

    const meta = document.createElement('div');
    meta.className = 'point-colis-meta';
    meta.textContent = colis.commentaire || 'Colis déjà payé';

    main.append(title, meta);
    row.appendChild(main);

    if (existing) {
      const box = document.createElement('div');
      box.style.textAlign = 'right';

      const badge = document.createElement('span');
      badge.className = 'badge badge-warning';
      badge.textContent = `-${formatFcfa(existing.montant)}`;

      const cancel = document.createElement('button');
      cancel.className = 'btn btn-outline operation-delete';
      cancel.style.marginTop = '6px';
      cancel.textContent = 'Annuler';
      cancel.addEventListener('click', () => deleteOperation(existing.id, 'Annuler cette déduction ?'));

      box.append(badge, cancel);
      row.appendChild(box);
    } else {
      const box = document.createElement('div');
      box.className = 'deduction-box';

      const input = document.createElement('input');
      input.type = 'number';
      input.inputMode = 'numeric';
      input.min = '1';
      input.className = 'form-control';
      input.placeholder = 'Montant';

      const button = document.createElement('button');
      button.className = 'btn btn-primary';
      button.textContent = 'DÉDUIRE';
      button.addEventListener('click', () => addDeliveryDeduction(colis.id, input, button));

      box.append(input, button);
      row.appendChild(box);
    }

    livraisonsList.appendChild(row);
  }
}

function renderFrais() {
  fraisList.replaceChildren();
  const fees = currentOps.filter(op => op.type === 'frais_divers');

  if (!fees.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.padding = '14px 0';
    empty.textContent = 'Aucun frais enregistré.';
    fraisList.appendChild(empty);
    return;
  }

  fees.forEach(fee => {
    const row = document.createElement('div');
    row.className = 'operation-row';

    const main = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'operation-title';
    title.textContent = `-${formatFcfa(fee.montant)}`;

    const note = document.createElement('div');
    note.className = 'operation-note';
    note.textContent = fee.commentaire || 'Frais divers';

    main.append(title, note);

    const button = document.createElement('button');
    button.className = 'btn btn-outline operation-delete';
    button.textContent = 'Supprimer';
    button.addEventListener('click', () => deleteOperation(fee.id, 'Supprimer ce frais ?'));

    row.append(main, button);
    fraisList.appendChild(row);
  });
}

function renderTimeline() {
  timelineContainer.replaceChildren();

  const events = [{
    time: new Date(currentResume.created_at),
    type: 'DÉPART',
    desc: `${Number(currentResume.nb_colis_initial || 0)} colis initiaux`,
    amount: Number(currentResume.montant_initial || 0),
    tone: 'var(--text-main)'
  }];

  currentColis
    .filter(c => c.source === 'ajout')
    .forEach(c => events.push({
      time: new Date(c.created_at),
      type: 'AJOUT',
      desc: c.commentaire || 'Colis supplémentaire',
      amount: Number(c.valeur || 0),
      tone: 'var(--success)'
    }));

  currentOps.forEach(op => {
    if (op.type === 'retour') {
      events.push({
        time: new Date(op.created_at),
        type: 'RETOUR CONFIRMÉ',
        desc: op.commentaire || 'Retour retiré du net',
        amount: -Number(op.montant || 0),
        tone: 'var(--danger)'
      });
    } else if (op.type === 'deduction_livraison') {
      events.push({
        time: new Date(op.created_at),
        type: 'LIVRAISON DÉDUITE',
        desc: op.commentaire || 'Colis déjà payé',
        amount: -Number(op.montant || 0),
        tone: 'var(--warning)'
      });
    } else if (op.type === 'frais_divers') {
      events.push({
        time: new Date(op.created_at),
        type: 'FRAIS',
        desc: op.commentaire || 'Frais divers',
        amount: -Number(op.montant || 0),
        tone: 'var(--danger)'
      });
    }
  });

  events
    .sort((a, b) => a.time - b.time)
    .forEach(event => {
      const row = document.createElement('div');
      row.className = 'timeline-row';

      const top = document.createElement('div');
      top.className = 'timeline-top';

      const type = document.createElement('div');
      type.className = 'timeline-type';
      type.style.color = event.tone;
      type.textContent = event.type;

      const time = document.createElement('div');
      time.className = 'timeline-time';
      time.textContent = event.time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

      top.append(type, time);

      const desc = document.createElement('div');
      desc.className = 'timeline-desc';
      desc.textContent = event.desc;

      const amount = document.createElement('div');
      amount.className = 'timeline-amount';
      amount.style.color = event.tone;
      const sign = event.amount > 0 && event.type !== 'DÉPART' ? '+' : '';
      amount.textContent = `${sign}${formatFcfa(event.amount)}`;

      row.append(top, desc, amount);
      timelineContainer.appendChild(row);
    });
}

function renderFinance() {
  recapChargement.textContent = formatFcfa(currentResume.montant_initial);
  recapAjouts.textContent = `+${formatFcfa(currentResume.montant_ajouts)}`;
  recapRetours.textContent = `-${formatFcfa(currentResume.montant_retours)}`;
  recapDeductions.textContent = `-${formatFcfa(currentResume.deduction_livraison)}`;
  recapFrais.textContent = `-${formatFcfa(currentResume.frais_divers)}`;
  recapNet.textContent = formatFcfa(currentResume.net_a_encaisser);
  closeBarNet.textContent = formatFcfa(currentResume.net_a_encaisser);
}

function closureIssues() {
  const waiting = currentColis.filter(c => c.statut_livreur === 'en_attente');
  const unconfirmedReturns = currentColis.filter(
    c => c.statut_livreur === 'retourne' && !hasOperation(c.id, 'retour')
  );

  const issues = [];

  if (waiting.length) {
    issues.push(`${waiting.length} colis encore en attente de décision du livreur.`);
  }

  if (unconfirmedReturns.length) {
    issues.push(`${unconfirmedReturns.length} retour(s) signalé(s) mais pas encore confirmé(s).`);
  }

  if (!currentColis.length) {
    issues.push('La tournée ne contient aucun colis.');
  }

  return issues;
}

function renderControl() {
  const issues = closureIssues();
  controlList.replaceChildren();

  if (!issues.length) {
    controlCard.classList.add('ok');
    controlTitle.textContent = 'Contrôle terminé';
    const line = document.createElement('div');
    line.textContent = 'Tous les colis sont traités et les retours signalés sont confirmés.';
    controlList.appendChild(line);
    cloturerBtn.disabled = false;
    return;
  }

  controlCard.classList.remove('ok');
  controlTitle.textContent = 'Clôture impossible pour le moment';

  issues.forEach(issue => {
    const line = document.createElement('div');
    line.textContent = `• ${issue}`;
    controlList.appendChild(line);
  });

  cloturerBtn.disabled = true;
}

async function handleAddColis() {
  const rawFile = photoInput.files?.[0];
  const rawAmount = montantInput.value.trim();
  const value = Number(rawAmount);

  if (!rawFile) {
    showToast('La photo du colis est obligatoire.');
    return;
  }

  if (rawAmount === '' || !Number.isFinite(value) || value < 0) {
    showToast('Montant invalide.');
    return;
  }

  setBusy(addColisBtn, true, 'AJOUTER À LA TOURNÉE');

  let photoPath = null;

  try {
    const compressed = await compressImage(rawFile);
    const colisId = crypto.randomUUID();
    photoPath = `sorties/${currentSortieId}/${colisId}.jpg`;

    const { error: uploadError } = await supabase.storage
      .from('colis-photos')
      .upload(photoPath, compressed, { upsert: false });

    if (uploadError) throw uploadError;

    const { error: insertError } = await supabase
      .from('colis')
      .insert({
        id: colisId,
        sortie_id: currentSortieId,
        photo_path: photoPath,
        valeur: value,
        commentaire: noteInput.value.trim() || null,
        statut_livreur: 'en_attente',
        source: 'ajout'
      });

    if (insertError) {
      await supabase.storage.from('colis-photos').remove([photoPath]);
      throw insertError;
    }

    clearPreview();
    montantInput.value = '';
    montantInput.disabled = false;
    isPaidCheckbox.checked = false;
    noteInput.value = '';

    showToast('Colis ajouté à la tournée.');
    await refreshPointData();
  } catch (err) {
    console.error(err);
    if (photoPath) {
      try { await supabase.storage.from('colis-photos').remove([photoPath]); } catch {}
    }
    showToast('Impossible d’ajouter ce colis.');
  } finally {
    setBusy(addColisBtn, false, 'AJOUTER À LA TOURNÉE');
  }
}

async function handleConfirmRetours() {
  const ids = [...selectedForRetour];
  if (!ids.length) return;

  setBusy(confirmRetoursBtn, true, 'CONFIRMER LA SÉLECTION', 'CONFIRMATION...');

  try {
    const operations = ids
      .map(id => currentColis.find(c => c.id === id))
      .filter(Boolean)
      .filter(c => !hasOperation(c.id, 'retour'))
      .map(c => ({
        sortie_id: currentSortieId,
        colis_id: c.id,
        type: 'retour',
        montant: Number(c.valeur || 0),
        quantite: 1,
        commentaire: c.statut_livreur === 'retourne'
          ? 'Retour signalé par le livreur puis confirmé par le Gérant'
          : 'Retour confirmé manuellement par le Gérant'
      }));

    if (!operations.length) {
      showToast('Aucun nouveau retour à confirmer.');
      return;
    }

    const { error } = await supabase.from('sortie_operations').insert(operations);
    if (error) throw error;

    selectedForRetour.clear();
    showToast(`${operations.length} retour(s) confirmé(s).`);
    await refreshPointData();
  } catch (err) {
    console.error(err);
    showToast('Impossible de confirmer les retours.');
  } finally {
    setBusy(confirmRetoursBtn, false, 'CONFIRMER LA SÉLECTION');
    updateReturnSelection();
  }
}

async function addDeliveryDeduction(colisId, input, button) {
  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) {
    showToast('Montant de livraison invalide.');
    return;
  }

  setBusy(button, true, 'DÉDUIRE');

  try {
    const { error } = await supabase.from('sortie_operations').insert({
      sortie_id: currentSortieId,
      colis_id: colisId,
      type: 'deduction_livraison',
      montant: value,
      quantite: 1,
      commentaire: 'Frais de livraison sur colis déjà payé'
    });

    if (error) throw error;

    showToast('Livraison déduite.');
    await refreshPointData();
  } catch (err) {
    console.error(err);
    showToast('Impossible d’enregistrer cette déduction.');
  } finally {
    setBusy(button, false, 'DÉDUIRE');
  }
}

async function handleAddFrais() {
  const value = Number(fraisMontant.value);
  const reason = fraisMotif.value.trim();

  if (!Number.isFinite(value) || value <= 0 || !reason) {
    showToast('Montant et motif sont obligatoires.');
    return;
  }

  setBusy(addFraisBtn, true, 'ENREGISTRER LE FRAIS');

  try {
    const { error } = await supabase.from('sortie_operations').insert({
      sortie_id: currentSortieId,
      type: 'frais_divers',
      montant: value,
      quantite: 1,
      commentaire: reason
    });

    if (error) throw error;

    fraisMontant.value = '';
    fraisMotif.value = '';
    showToast('Frais enregistré.');
    await refreshPointData();
  } catch (err) {
    console.error(err);
    showToast('Impossible d’enregistrer ce frais.');
  } finally {
    setBusy(addFraisBtn, false, 'ENREGISTRER LE FRAIS');
  }
}

async function deleteOperation(operationId, question) {
  if (!window.confirm(question)) return;

  try {
    const { error } = await supabase
      .from('sortie_operations')
      .delete()
      .eq('id', operationId);

    if (error) throw error;

    showToast('Opération annulée.');
    await refreshPointData();
  } catch (err) {
    console.error(err);
    showToast('Impossible d’annuler cette opération.');
  }
}

async function handleCloture() {
  const issues = closureIssues();

  if (issues.length) {
    renderControl();
    showToast('Terminez le contrôle avant de clôturer.');
    return;
  }

  const net = formatFcfa(currentResume.net_a_encaisser);
  const ok = window.confirm(
    `Clôturer définitivement la tournée de ${currentResume.livreur_nom} ?\n\nNet à encaisser : ${net}\n\nAprès validation, la tournée passera dans les archives.`
  );

  if (!ok) return;

  setBusy(cloturerBtn, true, 'VALIDER L\'ENCAISSEMENT', 'CLÔTURE...');

  try {
    const { error } = await supabase.rpc('cloturer_sortie', {
      p_sortie_id: currentSortieId
    });

    if (error) throw error;

    showToast(`Tournée clôturée • ${net}`);
    cleanupRealtime();
    await loadSortiesEnCours();
    tourneeSelect.value = '';
    resetSelection();
  } catch (err) {
    console.error(err);
    const message = String(err?.message || '');
    if (message.includes('attente')) showToast('Des colis sont encore en attente.');
    else if (message.includes('retour')) showToast('Un retour signalé doit être confirmé.');
    else if (message.includes('déjà clôturée')) showToast('Cette tournée est déjà clôturée.');
    else showToast('Impossible de clôturer cette tournée.');
    cloturerBtn.disabled = false;
    cloturerBtn.textContent = 'VALIDER L\'ENCAISSEMENT';
  }
}

async function getSignedPhotoUrl(path) {
  if (!path) return null;

  const now = Date.now();
  const cached = signedUrlCache.get(path);
  if (cached && now < cached.expiresAt - 300000) return cached.url;

  const { data, error } = await supabase.storage
    .from('colis-photos')
    .createSignedUrl(path, 86400);

  if (error || !data?.signedUrl) return null;

  signedUrlCache.set(path, {
    url: data.signedUrl,
    expiresAt: now + 86400000
  });

  return data.signedUrl;
}

function setupRealtime() {
  cleanupRealtime();
  if (!currentSortieId) return;

  realtimeChannel = supabase
    .channel(`point-${currentSortieId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'colis', filter: `sortie_id=eq.${currentSortieId}` }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sortie_operations', filter: `sortie_id=eq.${currentSortieId}` }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sorties', filter: `id=eq.${currentSortieId}` }, scheduleRefresh)
    .subscribe();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      await refreshPointData();
      await loadSortiesEnCours();
    } catch (err) {
      console.error('Realtime refresh:', err);
    }
  }, 300);
}

function cleanupRealtime() {
  clearTimeout(refreshTimer);
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

document.addEventListener('DOMContentLoaded', init);
