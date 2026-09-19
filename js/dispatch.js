import { auth } from './auth.js';
import { supabase } from './config.js';
import { compressImage } from './colis-utils.js';

// Elements
const livreurSelect = document.getElementById('livreurSelect');
const zoneContainer = document.getElementById('zoneContainer');
const zoneDisplay = document.getElementById('zoneDisplay');
const emptyCart = document.getElementById('emptyCart');
const parcelScroll = document.getElementById('parcelScroll');
const menuBtn = document.getElementById('menuBtn');
const closeMenuBtn = document.getElementById('closeMenuBtn');
const drawerBackdrop = document.getElementById('dispatchDrawerBackdrop');
const refreshBtn = document.getElementById('refreshBtn');
const logoutBtn = document.getElementById('logoutBtn');
const tourneeStatus = document.getElementById('tourneeStatus');
const colisFormContainer = document.getElementById('colisFormContainer');

const photoInput = document.getElementById('photoInput');
const cameraPreview = document.getElementById('cameraPreview');
const photoPlaceholder = document.getElementById('photoPlaceholder');
const montantInput = document.getElementById('montantInput');
const isPaidCheckbox = document.getElementById('isPaidCheckbox');
const noteInput = document.getElementById('noteInput');
const addColisBtn = document.getElementById('addColisBtn');

const localColisGrid = document.getElementById('localColisGrid');
const localColisCount = document.getElementById('localColisCount');
const localTotal = document.getElementById('localTotal');
const validateAllBtn = document.getElementById('validateAllBtn');
const stickyFooter = document.getElementById('stickyFooter');
const gridTitle = document.getElementById('gridTitle');

const progressStatusContainer = document.getElementById('progressStatusContainer');
const progressText = document.getElementById('progressText');
const progressCount = document.getElementById('progressCount');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const parcelViewer = document.getElementById('parcelViewer');
const parcelViewerImage = document.getElementById('parcelViewerImage');
const parcelViewerTitle = document.getElementById('parcelViewerTitle');
const parcelViewerNote = document.getElementById('parcelViewerNote');
const closeViewerBtn = document.getElementById('closeViewerBtn');
const previewZoomBtn = document.getElementById('previewZoomBtn');
let lastViewerTrigger = null;

function openPhoto(url, label, note = '', trigger = null) {
    if (!url) return;
    lastViewerTrigger = trigger;
    parcelViewerImage.src = url;
    parcelViewerTitle.textContent = label;
    parcelViewerNote.textContent = note;
    parcelViewer.classList.add('open');
    parcelViewer.setAttribute('aria-hidden', 'false');
    closeViewerBtn.focus();
}

function closePhoto() {
    parcelViewer.classList.remove('open');
    parcelViewer.setAttribute('aria-hidden', 'true');
    parcelViewerImage.removeAttribute('src');
    lastViewerTrigger?.focus();
    lastViewerTrigger = null;
}

// State
let livreurs = [];
let selectedLivreur = null;
let pendingColis = [];
let activeTourneeId = null;
let previewObjectUrl = null;
let selectedLivreurRequest = 0;
let isValidating = false;
let formReady = false;
const STAGES = ['stage-select', 'stage-capture', 'stage-preview', 'stage-queue'];

function updateStage() {
    const hasPhoto = Boolean(photoInput.files?.length);
    const stage = !selectedLivreur ? 'stage-select'
        : hasPhoto ? 'stage-preview'
        : pendingColis.length ? 'stage-queue'
        : 'stage-capture';

    const body = document.body;
    if (!body.classList.contains(stage)) {
        body.classList.remove(...STAGES);
        body.classList.add(stage);
    }

    colisFormContainer.setAttribute('aria-busy', String(Boolean(selectedLivreur && !formReady)));
    previewZoomBtn.hidden = !hasPhoto;
    photoInput.disabled = !formReady || isValidating;
    addColisBtn.disabled = !formReady || !hasPhoto || isValidating;
    // La validation reste visible avec des colis enregistrés, mais attend l'ajout de la photo en cours.
    validateAllBtn.disabled = pendingColis.length === 0 || isValidating || hasPhoto;
}

function resetPhoto() {
    photoInput.value = '';
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
    cameraPreview.removeAttribute('src');
    cameraPreview.style.display = 'none';
    previewZoomBtn.hidden = true;
    photoPlaceholder.style.display = 'flex';
    montantInput.value = '';
    noteInput.value = '';
    isPaidCheckbox.checked = false;
    montantInput.disabled = false;
    updateStage();
}

function closeMenu() {
    drawerBackdrop.classList.remove('open');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.focus();
}

function confirmDiscardPending() {
    return (pendingColis.length === 0 && !photoInput.files?.length) ||
        window.confirm('Vous avez des colis non enregistrés. Les abandonner ?');
}

function refreshScreen() {
    if (!confirmDiscardPending()) return;
    window.location.reload();
}

function setFormAvailable(available) {
    formReady = Boolean(available);
    colisFormContainer.style.opacity = formReady ? '1' : '.63';
    colisFormContainer.style.pointerEvents = formReady ? 'auto' : 'none';
    updateStage();
}

async function init() {
    const user = await auth.requireRole(['gerant']);
    if (!user) return;

    menuBtn.addEventListener('click', () => {
        drawerBackdrop.classList.add('open');
        menuBtn.setAttribute('aria-expanded', 'true');
        closeMenuBtn.focus();
    });
    closeMenuBtn.addEventListener('click', closeMenu);
    drawerBackdrop.addEventListener('click', event => {
        if (event.target === drawerBackdrop) closeMenu();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && drawerBackdrop.classList.contains('open')) closeMenu();
    });
    refreshBtn.addEventListener('click', refreshScreen);
    logoutBtn.addEventListener('click', async () => {
        if (!confirmDiscardPending()) return;
        logoutBtn.disabled = true;
        await auth.logout();
    });

    livreurSelect.disabled = true;
    livreurSelect.addEventListener('change', handleLivreurChange);
    photoInput.addEventListener('change', handlePhotoChange);
    isPaidCheckbox.addEventListener('change', handlePaidToggle);
    addColisBtn.addEventListener('click', addLocalColis);
    validateAllBtn.addEventListener('click', validateAllColis);
    previewZoomBtn.addEventListener('click', () => {
        openPhoto(previewObjectUrl, 'PHOTO EN COURS', noteInput.value.trim(), previewZoomBtn);
    });
    closeViewerBtn.addEventListener('click', closePhoto);
    parcelViewer.addEventListener('click', event => {
        if (event.target === parcelViewer) closePhoto();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && parcelViewer.classList.contains('open')) closePhoto();
    });
    drawerBackdrop.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', event => {
            if (isValidating || !confirmDiscardPending()) event.preventDefault();
        });
    });
    await loadLivreurs();
    renderPendingColis();
    updateStage();
}

async function loadLivreurs() {
    try {
        const { data, error } = await supabase
            .from('livreurs')
            .select(`
                id, nom, zone_id, 
                zones ( nom )
            `)
            .eq('actif', true);

        if (error) throw error;
        livreurs = data || [];
        livreurSelect.replaceChildren();
        const prompt = document.createElement('option');
        prompt.value = '';
        prompt.textContent = livreurs.length ? 'Sélectionner un livreur…' : 'Aucun livreur disponible';
        livreurSelect.appendChild(prompt);

        livreurs.forEach(l => {
            const opt = document.createElement('option');
            opt.value = l.id;
            opt.textContent = l.nom;
            livreurSelect.appendChild(opt);
        });
        livreurSelect.disabled = livreurs.length === 0;
    } catch (err) {
        console.error('Erreur chargement livreurs:', err);
        livreurSelect.replaceChildren();
        const prompt = document.createElement('option');
        prompt.value = '';
        prompt.textContent = 'Erreur de chargement — actualisez';
        livreurSelect.appendChild(prompt);
        livreurSelect.disabled = true;
    }
}

async function handleLivreurChange(event) {
    const nextId = event.target.value;
    if (isValidating) {
        livreurSelect.value = selectedLivreur?.id || '';
        return;
    }

    const changing = nextId !== (selectedLivreur?.id || '');
    const unsaved = pendingColis.length > 0 || Boolean(photoInput.files?.length);
    if (changing && unsaved && !confirmDiscardPending()) {
        livreurSelect.value = selectedLivreur?.id || '';
        return;
    }

    if (changing) {
        pendingColis.forEach(colis => URL.revokeObjectURL(colis.previewUrl));
        pendingColis = [];
        resetPhoto();
    }

    const request = ++selectedLivreurRequest;
    activeTourneeId = null;
    selectedLivreur = livreurs.find(livreur => livreur.id === nextId) || null;
    setFormAvailable(false);
    tourneeStatus.textContent = '';
    zoneDisplay.textContent = selectedLivreur?.zones?.nom || (selectedLivreur ? 'Zone absente' : 'Zone automatique');
    renderPendingColis();

    if (!selectedLivreur) return;

    if (!selectedLivreur.zone_id) {
        tourneeStatus.textContent = 'Ce livreur n’a pas de zone. Attribuez-lui une zone dans Équipe.';
        tourneeStatus.style.color = 'var(--danger)';
        return;
    }

    tourneeStatus.textContent = 'Vérification de la tournée…';
    tourneeStatus.style.color = 'var(--text-muted)';
    try {
        const { data, error } = await supabase
            .from('sorties')
            .select('id')
            .eq('livreur_id', selectedLivreur.id)
            .eq('statut', 'en_cours')
            .maybeSingle();

        if (request !== selectedLivreurRequest) return;
        if (error) throw error;

        activeTourneeId = data?.id || null;
        tourneeStatus.textContent = data
            ? 'Tournée active : vos colis seront ajoutés à cette tournée.'
            : 'Nouvelle tournée prête à être créée.';
        tourneeStatus.style.color = data ? 'var(--primary)' : 'var(--text-muted)';
        setFormAvailable(true);
    } catch (err) {
        if (request !== selectedLivreurRequest) return;
        console.error('Vérification tournée:', err);
        tourneeStatus.textContent = 'Impossible de vérifier la tournée. Choisissez à nouveau le livreur.';
        tourneeStatus.style.color = 'var(--danger)';
        setFormAvailable(false);
    }
}

function handlePaidToggle() {
    if (isPaidCheckbox.checked) {
        montantInput.value = '0';
        montantInput.disabled = true;
    } else {
        montantInput.value = '';
        montantInput.disabled = false;
        montantInput.focus();
    }
}

// Compression d'image côté client (déplacée vers colis-utils.js)

async function handlePhotoChange(event) {
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
    const file = event.target.files?.[0];
    if (!file) {
        cameraPreview.removeAttribute('src');
        cameraPreview.style.display = 'none';
        previewZoomBtn.hidden = true;
        photoPlaceholder.style.display = 'flex';
        updateStage();
        return;
    }
    previewObjectUrl = URL.createObjectURL(file);
    cameraPreview.src = previewObjectUrl;
    cameraPreview.style.display = 'block';
    previewZoomBtn.hidden = false;
    photoPlaceholder.style.display = 'none';
    updateStage();
    // Le clavier reste fermé pour laisser voir la transition vers la saisie compacte.
}

async function addLocalColis() {
    if (!selectedLivreur || !formReady || isValidating || addColisBtn.disabled) return;
    const rawFile = photoInput.files[0];
    const montant = montantInput.value.trim();
    const note = noteInput.value.trim();

    if (!rawFile) {
        alert("La photo est obligatoire.");
        return;
    }
    if (montant === '') {
        alert("Veuillez saisir un montant, ou cocher 'Colis déjà payé'.");
        return;
    }

    const valeur = Number(montant);
    if (!Number.isFinite(valeur) || valeur < 0) {
        alert("Le montant doit être un nombre positif ou 0 pour un colis payé.");
        return;
    }

    addColisBtn.disabled = true;
    addColisBtn.textContent = "COMPRESSION...";

    try {
        const compressedFile = await compressImage(rawFile);
        
        const colis = {
            id: crypto.randomUUID(), // UUID définitif généré côté client
            file: compressedFile,
            previewUrl: URL.createObjectURL(compressedFile),
            valeur,
            commentaire: note,
            status: 'pending',
            source: null
        };

        pendingColis.push(colis);
        renderPendingColis(true); // true = animate last added
        
        // Garder le formulaire compact après le premier colis pour laisser la place à la liste.
        resetPhoto();
        
    } catch (err) {
        console.error(err);
        alert("Erreur lors du traitement de la photo.");
    } finally {
        addColisBtn.textContent = "AJOUTER +";
        updateStage();
    }
}

function renderPendingColis(animateLast = false) {
    localColisGrid.replaceChildren();
    let total = 0;
    const hasCart = pendingColis.length > 0;

    gridTitle.style.display = hasCart ? 'block' : 'none';
    gridTitle.textContent = hasCart ? `COLIS · ${pendingColis.length}` : '';
    emptyCart.classList.toggle('hidden', hasCart);
    stickyFooter.style.display = hasCart ? 'flex' : 'none';
    parcelScroll.classList.toggle('has-cart', hasCart);

    pendingColis.forEach((colis, index) => {
        total += colis.valeur;
        const card = document.createElement('div');
        card.className = 'photo-card';
        card.id = `colisCard-${colis.id}`;
        if (animateLast && index === pendingColis.length - 1) {
            card.style.animation = 'dispatch-add .24s ease-out both';
        }

        const thumbButton = document.createElement('button');
        thumbButton.type = 'button';
        thumbButton.className = 'preview-card-btn';
        thumbButton.setAttribute('aria-label', `Agrandir la photo du colis ${index + 1}`);
        thumbButton.addEventListener('click', () => {
            openPhoto(colis.previewUrl, `COLIS ${index + 1}`, `${colis.valeur.toLocaleString('fr-FR')} F${colis.commentaire ? ' · ' + colis.commentaire : ''}`, thumbButton);
        });
        const img = document.createElement('img');
        img.src = colis.previewUrl;
        img.alt = `Colis ${index + 1}`;
        img.loading = 'lazy';
        thumbButton.appendChild(img);

        const overlay = document.createElement('div');
        overlay.className = 'photo-overlay flex justify-between items-center';

        const price = document.createElement('span');
        price.textContent = colis.valeur === 0 ? 'PAYÉ' : colis.valeur.toLocaleString('fr-FR') + ' F';
        if (colis.valeur === 0) price.style.color = '#86EFAC';

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.textContent = '×';
        delBtn.setAttribute('aria-label', `Retirer le colis ${index + 1}`);
        delBtn.style.background = 'var(--danger)';
        delBtn.style.border = 'none';
        delBtn.style.color = 'white';
        delBtn.style.borderRadius = '5px';
        delBtn.style.cursor = 'pointer';
        delBtn.addEventListener('click', () => {
            if (isValidating) return;
            pendingColis = pendingColis.filter(item => item.id !== colis.id);
            URL.revokeObjectURL(colis.previewUrl);
            renderPendingColis();
        });

        overlay.append(price, delBtn);
        card.append(thumbButton, overlay);
        localColisGrid.appendChild(card);
    });

    localColisCount.textContent = String(pendingColis.length);
    localTotal.textContent = total.toLocaleString('fr-FR') + ' F';
    validateAllBtn.disabled = !hasCart || isValidating;
    updateStage();
}

async function validateAllColis() {
    if (!selectedLivreur || pendingColis.length === 0 || isValidating) return;
    if (photoInput.files?.length) {
        alert('Une photo est encore en préparation. Ajoutez ce colis avant de valider la tournée, ou choisissez une autre photo.');
        return;
    }
    isValidating = true;
    livreurSelect.disabled = true;
    updateStage();
    validateAllBtn.disabled = true;
    validateAllBtn.textContent = "ENREGISTREMENT EN COURS…";
    
    progressStatusContainer.classList.remove('hidden');
    progressContainer.style.display = 'block';
    let successCount = 0;
    const pendingToProcess = pendingColis.filter(c => c.status !== 'saved');
    const totalCount = pendingToProcess.length;
    progressCount.textContent = `0 / ${totalCount}`;
    progressBar.style.width = '0%';

    try {
        const gerantId = await auth.getCurrentProfileId();
        if (!gerantId) {
            throw new Error("Profil Gérant introuvable.");
        }

        let currentSortieId = activeTourneeId;
        let createdNewSortie = false;

        // Etape 1: Gérer la création de la sortie avec gestion de concurrence
        if (!currentSortieId) {
            const { data: newSortie, error: sortieError } = await supabase
                .from('sorties')
                .insert([{
                    livreur_id: selectedLivreur.id,
                    gerant_id: gerantId,
                    zone_id: selectedLivreur.zone_id,
                    statut: 'en_cours'
                }])
                .select()
                .maybeSingle();
            
            if (sortieError) {
                // Possible conflit d'unicité. On essaie de récupérer celle qui vient d'être créée.
                const { data: existingSortie, error: fetchErr } = await supabase
                    .from('sorties')
                    .select('id')
                    .eq('livreur_id', selectedLivreur.id)
                    .eq('statut', 'en_cours')
                    .maybeSingle();
                
                if (existingSortie) {
                    currentSortieId = existingSortie.id;
                    createdNewSortie = false;
                } else {
                    throw sortieError; // Vraie erreur
                }
            } else {
                currentSortieId = newSortie.id;
                createdNewSortie = true;
            }
        }

        activeTourneeId = currentSortieId;

        const defaultSource = createdNewSortie ? 'initial' : 'ajout';
        pendingToProcess.forEach(colis => {
            if (!colis.source) colis.source = defaultSource;
        });

        // Etape 2: Stratégie de compensation pour chaque colis
        for (const colis of pendingToProcess) {
            const photoPath = `sorties/${currentSortieId}/${colis.id}.jpg`;
            
            // A. Upload Storage
            const { error: uploadError } = await supabase.storage
                .from('colis-photos')
                .upload(photoPath, colis.file);
                
            if (uploadError) throw uploadError;

            // B. Insertion BDD
            const { error: insertError } = await supabase
                .from('colis')
                .insert([{
                    id: colis.id,
                    sortie_id: currentSortieId,
                    photo_path: photoPath,
                    valeur: colis.valeur,
                    commentaire: colis.commentaire,
                    statut_livreur: 'en_attente',
                    source: colis.source
                }]);
                
            if (insertError) {
                // COMPENSATION : Suppression de la photo orpheline
                await supabase.storage.from('colis-photos').remove([photoPath]);
                throw insertError;
            }

            colis.status = 'saved';

            // Mise à jour de la progression
            successCount++;
            progressCount.textContent = `${successCount} / ${totalCount}`;
            progressBar.style.width = `${(successCount / totalCount) * 100}%`;
        }

        // Succès complet
        progressText.textContent = "Terminé !";
        progressText.style.color = "var(--success)";
        
        setTimeout(() => {
            alert(createdNewSortie ? "Tournée enregistrée." : "Colis enregistrés.");
            
            // Reset UX (garder le même livreur pour une saisie en chaîne)
            pendingColis.forEach(colis => URL.revokeObjectURL(colis.previewUrl));
            pendingColis = [];
            isValidating = false;
            livreurSelect.disabled = false;
            addColisBtn.disabled = false;
            renderPendingColis();
            progressStatusContainer.classList.add('hidden');
            progressContainer.style.display = 'none';
            validateAllBtn.disabled = true;
            validateAllBtn.textContent = "VALIDER LA TOURNÉE";
            
            // Mettre à jour l'état de la tournée affichée
            handleLivreurChange({ target: { value: selectedLivreur.id } });
            
        }, 500);

    } catch (err) {
        console.error("Erreur lors de la validation:", err);
        alert("Une erreur est survenue lors de l'enregistrement. Les colis non confirmés sont restés dans votre panier.");
        
        // Garder uniquement les colis qui n'ont pas encore été confirmés.
        // Ainsi RÉESSAYER ne renvoie jamais une photo/UUID déjà enregistré.
        pendingColis.filter(c => c.status === 'saved').forEach(c => URL.revokeObjectURL(c.previewUrl));
        pendingColis = pendingColis.filter(c => c.status !== 'saved');
        isValidating = false;
        livreurSelect.disabled = false;
        addColisBtn.disabled = false;
        renderPendingColis();

        // Reset bouton mais garde uniquement les colis non confirmés
        validateAllBtn.disabled = pendingColis.length === 0;
        validateAllBtn.textContent = "RÉESSAYER LA VALIDATION";
        progressText.textContent = "Erreur...";
        progressText.style.color = "var(--danger)";
    }
}

document.addEventListener('DOMContentLoaded', init);
