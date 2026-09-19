import { auth } from './auth.js';
import { supabase } from './config.js';
import { compressImage } from './colis-utils.js';

let user = null;
let activeSorties = [];
let currentSortieId = null;

let currentResume = null;
let currentColis = [];
let currentOps = [];
let selectedForRetour = []; // stocke les IDs des colis sélectionnés pour le retour

const signedUrlCache = new Map();

// UI Elements
const tourneeSelect = document.getElementById('tourneeSelect');
const pointContent = document.getElementById('pointContent');
const livreurName = document.getElementById('livreurName');
const zoneName = document.getElementById('zoneName');
const chargementInitialAmount = document.getElementById('chargementInitialAmount');
const totalColisCount = document.getElementById('totalColisCount');

const recapChargement = document.getElementById('recapChargement');
const recapAjouts = document.getElementById('recapAjouts');
const recapRetours = document.getElementById('recapRetours');
const recapDeductions = document.getElementById('recapDeductions');
const recapFrais = document.getElementById('recapFrais');
const recapNet = document.getElementById('recapNet');
const cloturerBtn = document.getElementById('cloturerBtn');

const timelineContainer = document.getElementById('timelineContainer');
const actionBtns = document.querySelectorAll('.action-btn');
const panels = document.querySelectorAll('.panel');

const photoInput = document.getElementById('photoInput');
const cameraPreview = document.getElementById('cameraPreview');
const photoPlaceholder = document.getElementById('photoPlaceholder');
const montantInput = document.getElementById('montantInput');
const isPaidCheckbox = document.getElementById('isPaidCheckbox');
const noteInput = document.getElementById('noteInput');
const addColisBtn = document.getElementById('addColisBtn');

const retoursList = document.getElementById('retoursList');
const tplRetourColis = document.getElementById('tplRetourColis');
const retoursSelectionInfo = document.getElementById('retoursSelectionInfo');
const confirmRetoursBtn = document.getElementById('confirmRetoursBtn');

const livraisonsList = document.getElementById('livraisonsList');
const tplLivraisonColis = document.getElementById('tplLivraisonColis');

const fraisMontant = document.getElementById('fraisMontant');
const fraisMotif = document.getElementById('fraisMotif');
const addFraisBtn = document.getElementById('addFraisBtn');
const fraisList = document.getElementById('fraisList');

let realtimeChannel = null;
let isRefreshing = false;

async function init() {
    user = await auth.requireRole(['gerant']);
    if (!user) return;
    setupUIListeners();
    await loadSortiesEnCours();
}

function setupUIListeners() {
    tourneeSelect.addEventListener('change', handleSortieChange);

    actionBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            panels.forEach(p => p.classList.remove('active'));
            document.getElementById(btn.getAttribute('data-panel')).classList.add('active');
            actionBtns.forEach(b => { b.classList.remove('btn-primary'); b.classList.add('btn-outline'); });
            btn.classList.remove('btn-outline');
            btn.classList.add('btn-primary');
        });
    });

    isPaidCheckbox.addEventListener('change', () => {
        montantInput.value = isPaidCheckbox.checked ? '0' : '';
        montantInput.disabled = isPaidCheckbox.checked;
    });

    photoInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            cameraPreview.src = URL.createObjectURL(file);
            cameraPreview.style.display = 'block';
            photoPlaceholder.style.display = 'none';
        }
    });

    addColisBtn.addEventListener('click', handleAddColis);
    confirmRetoursBtn.addEventListener('click', handleConfirmRetours);
    addFraisBtn.addEventListener('click', handleAddFrais);
    cloturerBtn.addEventListener('click', handleCloture);
}

// --- DATA LOADING & REALTIME ---

async function loadSortiesEnCours() {
    try {
        const { data, error } = await supabase.from('v_sorties_resume').select('*').eq('statut', 'en_cours');
        if (error) throw error;
        activeSorties = data;
        tourneeSelect.innerHTML = '<option value="">-- Sélectionner une tournée --</option>';
        data.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = `${s.livreur_nom} (${s.nb_colis_total} colis) - ${s.net_a_encaisser.toLocaleString('fr-FR')} F`;
            tourneeSelect.appendChild(opt);
        });
    } catch (err) {
        console.error(err);
    }
}

async function handleSortieChange(e) {
    const sId = e.target.value;
    if (!sId) {
        pointContent.classList.add('hidden');
        cleanupRealtime();
        currentSortieId = null;
        return;
    }
    currentSortieId = sId;
    pointContent.classList.remove('hidden');
    await refreshPointData();
    setupRealtime();
}

async function refreshPointData() {
    if (!currentSortieId || isRefreshing) return;
    isRefreshing = true;
    try {
        const [resResume, resColis, resOps] = await Promise.all([
            supabase.from('v_sorties_resume').select('*').eq('id', currentSortieId).maybeSingle(),
            supabase.from('colis').select('*').eq('sortie_id', currentSortieId).order('created_at', { ascending: true }),
            supabase.from('sortie_operations').select('*').eq('sortie_id', currentSortieId).order('created_at', { ascending: true })
        ]);
        if (resResume.error) throw resResume.error;
        currentResume = resResume.data;
        currentColis = resColis.data || [];
        currentOps = resOps.data || [];

        if (currentResume.statut === 'cloturee') {
            handleAlreadyClosed();
            return;
        }

        renderAll();
    } catch (err) {
        console.error(err);
    } finally {
        isRefreshing = false;
    }
}

function renderAll() {
    renderHeaderAndSummary();
    renderRetoursPanel();
    renderLivraisonsPanel();
    renderFraisPanel();
    renderTimeline();
}

function setupRealtime() {
    cleanupRealtime();
    realtimeChannel = supabase.channel(`point_${currentSortieId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'colis', filter: `sortie_id=eq.${currentSortieId}` }, onRealtimeEvent)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sortie_operations', filter: `sortie_id=eq.${currentSortieId}` }, onRealtimeEvent)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sorties', filter: `id=eq.${currentSortieId}` }, onRealtimeEvent)
        .subscribe();
}

function cleanupRealtime() {
    if (realtimeChannel) {
        supabase.removeChannel(realtimeChannel);
        realtimeChannel = null;
    }
}

let realtimeTimeout = null;
function onRealtimeEvent() {
    if (realtimeTimeout) clearTimeout(realtimeTimeout);
    realtimeTimeout = setTimeout(() => refreshPointData(), 1000); // debounce
}

function handleAlreadyClosed() {
    pointContent.style.opacity = '0.5';
    pointContent.style.pointerEvents = 'none';
    alert("Cette tournée vient d'être clôturée.");
    cleanupRealtime();
}

// --- PHOTO HELPERS ---

async function getPhotoUrl(path) {
    if (!path) return '';
    if (path.startsWith('http') || path.startsWith('blob:')) return path;
    const now = Date.now();
    if (signedUrlCache.has(path) && now < signedUrlCache.get(path).expiresAt - 3600000) {
        return signedUrlCache.get(path).url;
    }
    const { data } = await supabase.storage.from('colis-photos').createSignedUrl(path, 86400);
    if (data) signedUrlCache.set(path, { url: data.signedUrl, expiresAt: now + 86400000 });
    return data?.signedUrl || '';
}

// --- RENDERING ---

function renderHeaderAndSummary() {
    livreurName.textContent = currentResume.livreur_nom;
    zoneName.textContent = currentResume.zone_nom || 'Sans zone';
    chargementInitialAmount.textContent = currentResume.montant_initial.toLocaleString('fr-FR') + ' F';
    totalColisCount.textContent = currentResume.nb_colis_total;

    recapChargement.textContent = currentResume.montant_initial.toLocaleString('fr-FR') + ' F';
    recapAjouts.textContent = '+' + currentResume.montant_ajouts.toLocaleString('fr-FR') + ' F';
    recapRetours.textContent = '-' + currentResume.montant_retours.toLocaleString('fr-FR') + ' F';
    recapDeductions.textContent = '-' + currentResume.deduction_livraison.toLocaleString('fr-FR') + ' F';
    recapFrais.textContent = '-' + currentResume.frais_divers.toLocaleString('fr-FR') + ' F';
    recapNet.textContent = currentResume.net_a_encaisser.toLocaleString('fr-FR') + ' F';
}

async function renderRetoursPanel() {
    retoursList.innerHTML = '';
    selectedForRetour = [];
    let previewTotal = 0;

    const sortedColis = [...currentColis].sort((a, b) => (a.statut_livreur === 'retourne' ? -1 : 1));

    for (const colis of sortedColis) {
        const opRetour = currentOps.find(op => op.colis_id === colis.id && op.type === 'retour');
        const isConfirmed = !!opRetour;

        const clone = document.importNode(tplRetourColis.content, true);
        const checkbox = clone.querySelector('.retour-checkbox');
        clone.querySelector('.point-colis-photo').src = await getPhotoUrl(colis.photo_path);
        
        const montantEl = clone.querySelector('.point-colis-montant');
        if (colis.valeur === 0) { montantEl.textContent = 'PAYÉ'; montantEl.classList.add('text-success'); }
        else montantEl.textContent = colis.valeur.toLocaleString('fr-FR') + ' F';

        const statutEl = clone.querySelector('.point-colis-statut');
        statutEl.textContent = colis.statut_livreur === 'retourne' ? 'SIGNALÉ RETOUR' : colis.statut_livreur.toUpperCase();
        if (colis.statut_livreur === 'retourne') statutEl.classList.add('text-danger');
        else statutEl.classList.add('text-muted');

        if (isConfirmed) {
            checkbox.classList.add('hidden');
            clone.querySelector('.point-colis-deja-retourne').classList.remove('hidden');
            const btnAnnuler = clone.querySelector('.point-btn-annuler-retour');
            btnAnnuler.classList.remove('hidden');
            btnAnnuler.onclick = (e) => { e.preventDefault(); handleAnnulerOp(opRetour.id); };
        } else {
            checkbox.value = colis.id;
            if (colis.statut_livreur === 'retourne') {
                checkbox.checked = true;
                selectedForRetour.push(colis.id);
                previewTotal += colis.valeur;
            }
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) { selectedForRetour.push(colis.id); previewTotal += colis.valeur; }
                else { selectedForRetour = selectedForRetour.filter(id => id !== colis.id); previewTotal -= colis.valeur; }
                updateRetoursPreview(previewTotal);
            });
        }
        retoursList.appendChild(clone);
    }
    updateRetoursPreview(previewTotal);
}

function updateRetoursPreview(total) {
    retoursSelectionInfo.textContent = `${selectedForRetour.length} colis sélectionné(s) - TOTAL RETOUR : ${total.toLocaleString('fr-FR')} F`;
    confirmRetoursBtn.disabled = selectedForRetour.length === 0;
}

async function renderLivraisonsPanel() {
    livraisonsList.innerHTML = '';
    const colisPayes = currentColis.filter(c => c.valeur === 0);
    
    for (const colis of colisPayes) {
        const opDed = currentOps.find(op => op.colis_id === colis.id && op.type === 'deduction_livraison');
        const clone = document.importNode(tplLivraisonColis.content, true);
        clone.querySelector('.point-colis-photo').src = await getPhotoUrl(colis.photo_path);
        
        if (opDed) {
            clone.querySelector('.point-deduction-form').classList.add('hidden');
            const existDiv = clone.querySelector('.point-deduction-exist');
            existDiv.classList.remove('hidden');
            existDiv.querySelector('.point-deduction-montant').textContent = `DÉDUIT: ${opDed.montant} F`;
            existDiv.querySelector('.point-btn-annuler-deduction').onclick = () => handleAnnulerOp(opDed.id);
        } else {
            const input = clone.querySelector('.point-deduction-input');
            clone.querySelector('.point-btn-deduire').onclick = () => handleDeduireLivraison(colis.id, input.value);
        }
        livraisonsList.appendChild(clone);
    }
}

function renderFraisPanel() {
    fraisList.innerHTML = '';
    const frais = currentOps.filter(op => op.type === 'frais_divers');
    frais.forEach(f => {
        const div = document.createElement('div');
        div.className = 'flex justify-between items-center py-2 border-bottom';
        div.style.borderBottom = '1px solid var(--border)';
        div.innerHTML = `
            <div>
                <div class="font-bold">${f.montant.toLocaleString('fr-FR')} F</div>
                <div class="text-muted">${f.commentaire}</div>
            </div>
            <button class="btn btn-outline btn-sm text-danger" style="padding: 2px 8px;" onclick="handleAnnulerOp('${f.id}')">Suppr.</button>
        `;
        fraisList.appendChild(div);
    });
}

function renderTimeline() {
    timelineContainer.innerHTML = '';
    const events = [];
    events.push({ time: new Date(currentResume.created_at), type: 'DÉPART', desc: `${currentColis.filter(c => c.source === 'initial').length} colis initiaux`, amount: currentResume.montant_initial, color: 'var(--text-main)' });
    
    currentColis.filter(c => c.source === 'ajout').forEach(c => events.push({ time: new Date(c.created_at), type: 'AJOUT', desc: `Colis ${c.valeur === 0 ? 'PAYÉ' : 'supplémentaire'}`, amount: c.valeur, color: 'var(--success)' }));
    currentOps.forEach(op => {
        if (op.type === 'retour') events.push({ time: new Date(op.created_at), type: 'RETOUR CONFIRMÉ', desc: 'Déduction du net', amount: -op.montant, color: 'var(--danger)' });
        else if (op.type === 'deduction_livraison') events.push({ time: new Date(op.created_at), type: 'LIVRAISON DÉDUITE', desc: 'Frais sur colis payé', amount: -op.montant, color: 'var(--warning)' });
        else if (op.type === 'frais_divers') events.push({ time: new Date(op.created_at), type: 'FRAIS DIVERS', desc: op.commentaire || '', amount: -op.montant, color: 'var(--primary)' });
    });

    events.sort((a, b) => a.time - b.time).forEach(ev => {
        const div = document.createElement('div');
        div.className = 'timeline-item';
        const sign = ev.amount > 0 && ev.type !== 'DÉPART' ? '+' : '';
        div.innerHTML = `
            <div class="timeline-time">${ev.time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</div>
            <div class="flex justify-between items-center mt-1">
                <div><div class="timeline-content" style="color: ${ev.color};">${ev.type}</div><div class="text-sm text-muted">${ev.desc}</div></div>
                <div class="timeline-amount" style="color: ${ev.color};">${ev.amount === 0 ? '0 F' : `${sign}${ev.amount.toLocaleString('fr-FR')} F`}</div>
            </div>`;
        timelineContainer.appendChild(div);
    });
}

// --- ACTIONS ---

async function handleAddColis() {
    const rawFile = photoInput.files[0];
    const montant = montantInput.value.trim();
    if (!rawFile || montant === '') return alert("Photo et montant requis.");
    addColisBtn.disabled = true;
    addColisBtn.textContent = "TRAITEMENT...";

    try {
        const compressedFile = await compressImage(rawFile);
        const colisId = crypto.randomUUID();
        const photoPath = `sorties/${currentSortieId}/${colisId}.jpg`;
        const { error: uploadErr } = await supabase.storage.from('colis-photos').upload(photoPath, compressedFile);
        if (uploadErr) throw uploadErr;

        const { error: insertErr } = await supabase.from('colis').insert([{
            id: colisId, sortie_id: currentSortieId, photo_path: photoPath, valeur: Number(montant), commentaire: noteInput.value.trim(), statut_livreur: 'en_attente', source: 'ajout'
        }]);

        if (insertErr) {
            await supabase.storage.from('colis-photos').remove([photoPath]);
            throw insertErr;
        }

        photoInput.value = ''; cameraPreview.style.display = 'none'; photoPlaceholder.style.display = 'block';
        montantInput.value = ''; isPaidCheckbox.checked = false; montantInput.disabled = false; noteInput.value = '';
        await refreshPointData();
    } catch (err) {
        console.error(err); alert("Erreur lors de l'ajout.");
    } finally {
        addColisBtn.disabled = false; addColisBtn.textContent = "AJOUTER LE COLIS";
    }
}

async function handleConfirmRetours() {
    if (selectedForRetour.length === 0) return;
    confirmRetoursBtn.disabled = true;

    try {
        const newOps = [];
        for (const cId of selectedForRetour) {
            const colis = currentColis.find(c => c.id === cId);
            // Vérifier sécurité frontend
            if (colis && colis.sortie_id === currentSortieId && !currentOps.find(op => op.colis_id === cId && op.type === 'retour')) {
                newOps.push({ sortie_id: currentSortieId, colis_id: cId, type: 'retour', montant: colis.valeur, quantite: 1, commentaire: 'Retour confirmé' });
            }
        }
        
        if (newOps.length > 0) {
            const { error } = await supabase.from('sortie_operations').insert(newOps);
            if (error) {
                if (error.code === '23505') alert("Un ou plusieurs retours avaient déjà été confirmés. Les données ont été actualisées.");
                else throw error;
            }
        }
        await refreshPointData();
    } catch (err) {
        console.error(err); alert("Erreur d'enregistrement.");
    } finally {
        confirmRetoursBtn.disabled = false;
    }
}

async function handleDeduireLivraison(colisId, montantStr) {
    const montant = Number(montantStr);
    if (!montant || montant <= 0) return alert("Montant invalide.");
    
    // Vérif front-end de la double déduction
    if (currentOps.find(op => op.colis_id === colisId && op.type === 'deduction_livraison')) {
        return alert("Cette livraison a déjà été déduite.");
    }

    try {
        const { error } = await supabase.from('sortie_operations').insert([{
            sortie_id: currentSortieId, colis_id: colisId, type: 'deduction_livraison', montant, quantite: 1, commentaire: 'Frais sur colis payé'
        }]);
        if (error) {
            if (error.code === '23505') alert("Cette livraison a déjà été déduite."); // Unique violation catch
            else throw error;
        }
        await refreshPointData();
    } catch (err) {
        console.error(err); alert("Erreur d'enregistrement.");
    }
}

async function handleAddFrais() {
    const montant = Number(fraisMontant.value);
    const motif = fraisMotif.value.trim();
    if (!montant || montant <= 0 || !motif) return alert("Montant et motif requis.");
    try {
        const { error } = await supabase.from('sortie_operations').insert([{ sortie_id: currentSortieId, type: 'frais_divers', montant, quantite: 1, commentaire: motif }]);
        if (error) throw error;
        fraisMontant.value = ''; fraisMotif.value = '';
        await refreshPointData();
    } catch (err) {
        console.error(err); alert("Erreur d'enregistrement.");
    }
}

// Global handler pour annuler/supprimer une op
window.handleAnnulerOp = async function(opId) {
    if (currentResume.statut !== 'en_cours') return;
    try {
        const { error } = await supabase.from('sortie_operations').delete().eq('id', opId);
        if (error) throw error;
        await refreshPointData();
    } catch (err) {
        console.error(err); alert("Erreur lors de la suppression.");
    }
};

async function handleCloture() {
    if (!confirm("Clôturer la tournée ? Le net encaissé sera figé à " + currentResume.net_a_encaisser.toLocaleString('fr-FR') + " F.")) return;
    cloturerBtn.disabled = true;
    cloturerBtn.textContent = "CLÔTURE...";
    try {
        const { error } = await supabase.rpc('cloturer_sortie', { p_sortie_id: currentSortieId });
        if (error) throw error;
        alert(`TOURNÉE CLÔTURÉE\n${currentResume.net_a_encaisser.toLocaleString('fr-FR')} F encaissés`);
        window.location.reload();
    } catch (err) {
        console.error(err);
        if (err.message && err.message.includes('déjà clôturée')) alert("Cette tournée a déjà été clôturée par ailleurs.");
        else alert("Erreur lors de la clôture.");
        cloturerBtn.disabled = false;
        cloturerBtn.textContent = "VALIDER L'ENCAISSEMENT";
    }
}

document.addEventListener('DOMContentLoaded', init);
