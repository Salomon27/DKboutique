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

// State
let livreurs = [];
let selectedLivreur = null;
let pendingColis = [];
let activeTourneeId = null;
let previewObjectUrl = null;
let selectedLivreurRequest = 0;
let isValidating = false;

function closeMenu() {
    drawerBackdrop.classList.remove('open');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.focus();
}

function confirmDiscardPending() {
    return pendingColis.length === 0 ||
        window.confirm('Vous avez des colis non enregistrés. Les abandonner ?');
}

function refreshScreen() {
    if (!confirmDiscardPending()) return;
    window.location.reload();
}

function setFormAvailable(available) {
    colisFormContainer.style.opacity = available ? '1' : '.5';
    colisFormContainer.style.pointerEvents = available ? 'auto' : 'none';
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

    livreurSelect.addEventListener('change', handleLivreurChange);
    photoInput.addEventListener('change', handlePhotoChange);
    isPaidCheckbox.addEventListener('change', handlePaidToggle);
    addColisBtn.addEventListener('click', addLocalColis);
    validateAllBtn.addEventListener('click', validateAllColis);
    await loadLivreurs();
    renderPendingColis();
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
        livreurs = data;

        data.forEach(l => {
            const opt = document.createElement('option');
            opt.value = l.id;
            opt.textContent = l.nom;
            livreurSelect.appendChild(opt);
        });
    } catch (err) {
        console.error('Erreur chargement livreurs:', err);
    }
}

async function handleLivreurChange(e) {
    const lId = e.target.value;
    if (pendingColis.length && selectedLivreur && lId !== selectedLivreur.id) {
        if (!confirmDiscardPending()) {
            livreurSelect.value = selectedLivreur.id;
            return;
        }
        pendingColis.forEach(colis => URL.revokeObjectURL(colis.previewUrl));
        pendingColis = [];
        renderPendingColis();
    }

    const request = ++selectedLivreurRequest;
    activeTourneeId = null;
    setFormAvailable(false);
    tourneeStatus.textContent = '';
    if (!lId) {
        selectedLivreur = null;
        zoneDisplay.value = '';
        return;
    }

    selectedLivreur = livreurs.find(l => l.id === lId) || null;
    if (!selectedLivreur) {
        zoneDisplay.value = '';
        return;
    }

    zoneDisplay.value = selectedLivreur.zones?.nom || 'Sans zone';
    tourneeStatus.textContent = 'Vérification de la tournée…';
    try {
        const { data, error } = await supabase
            .from('sorties')
            .select('id')
            .eq('livreur_id', selectedLivreur.id)
            .eq('statut', 'en_cours')
            .maybeSingle();
            
        if (request !== selectedLivreurRequest) return;
        if (error) throw error;

        if (data) {
            activeTourneeId = data.id;
            tourneeStatus.textContent = 'Tournée active : les prochains colis seront ajoutés à cette tournée.';
            tourneeStatus.style.color = 'var(--warning)';
        } else {
            activeTourneeId = null;
            tourneeStatus.textContent = 'Nouvelle tournée : prête à être créée.';
            tourneeStatus.style.color = 'var(--text-muted)';
        }

        setFormAvailable(true);

    } catch (err) {
        if (request !== selectedLivreurRequest) return;
        console.error(err);
        tourneeStatus.textContent = 'Erreur lors de la vérification. Sélectionnez à nouveau le livreur.';
        tourneeStatus.style.color = 'var(--danger)';
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
        photoPlaceholder.style.display = 'grid';
        return;
    }
    previewObjectUrl = URL.createObjectURL(file);
    cameraPreview.src = previewObjectUrl;
    cameraPreview.style.display = 'block';
    photoPlaceholder.style.display = 'none';
}

async function addLocalColis() {
    if (!selectedLivreur || isValidating) return;
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
        
        // Reset Form
        photoInput.value = '';
        if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
        previewObjectUrl = null;
        cameraPreview.removeAttribute('src');
        cameraPreview.style.display = 'none';
        photoPlaceholder.style.display = 'grid';
        montantInput.value = '';
        noteInput.value = '';
        isPaidCheckbox.checked = false;
        montantInput.disabled = false;
        
    } catch (err) {
        console.error(err);
        alert("Erreur lors du traitement de la photo.");
    } finally {
        addColisBtn.disabled = false;
        addColisBtn.textContent = "AJOUTER";
    }
}

function renderPendingColis(animateLast = false) {
    localColisGrid.replaceChildren();
    let total = 0;
    const hasCart = pendingColis.length > 0;

    gridTitle.style.display = hasCart ? 'block' : 'none';
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

        const img = document.createElement('img');
        img.src = colis.previewUrl;
        img.alt = `Colis ${index + 1}`;
        img.loading = 'lazy';

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
        card.append(img, overlay);
        localColisGrid.appendChild(card);
    });

    localColisCount.textContent = String(pendingColis.length);
    localTotal.textContent = total.toLocaleString('fr-FR') + ' F';
    validateAllBtn.disabled = !hasCart || isValidating;
}

async function validateAllColis() {
    if (!selectedLivreur || pendingColis.length === 0 || isValidating) return;
    isValidating = true;
    livreurSelect.disabled = true;
    addColisBtn.disabled = true;
    validateAllBtn.disabled = true;
    validateAllBtn.textContent = "VALIDATION EN COURS...";
    
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
            alert(createdNewSortie ? "Nouvelle tournée créée avec succès !" : "Colis ajoutés à la tournée avec succès !");
            
            // Reset UX (garder le même livreur pour une saisie en chaîne)
            pendingColis.forEach(colis => URL.revokeObjectURL(colis.previewUrl));
            pendingColis = [];
            isValidating = false;
            livreurSelect.disabled = false;
            addColisBtn.disabled = false;
            renderPendingColis();
            progressStatusContainer.classList.add('hidden');
            progressContainer.style.display = 'none';
            validateAllBtn.disabled = false;
            validateAllBtn.textContent = "VALIDER TOUT";
            
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
        validateAllBtn.textContent = "RÉESSAYER";
        progressText.textContent = "Erreur...";
        progressText.style.color = "var(--danger)";
    }
}

document.addEventListener('DOMContentLoaded', init);
