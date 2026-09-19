# DK Boutique — Architecture métier cible

## 1. Principe central

DK Boutique reprend le flux opérationnel éprouvé d'ALC, mais avec une base de données normalisée :

**Gérant → Livreur → Zone → Tournée → Colis → Livraison / Retour → Le Point → Clôture → Archives**

Une tournée contient plusieurs colis. Un colis possède toujours un UUID stable. Les événements financiers sont séparés des statuts terrain.

## 2. Rôles

### Gérant
- crée les livreurs et leurs codes PIN ;
- gère les zones ;
- prépare les tournées ;
- ajoute des colis ;
- confirme les retours ;
- enregistre les déductions de livraison et frais ;
- clôture les tournées ;
- consulte ses archives, statistiques et bilans.

### Patronne
- supervision globale ;
- consultation de l'équipe ;
- consultation de tous les colis ;
- consultation des archives et bilans ;
- aucune écriture financière ou opérationnelle par défaut.

### Livreur
- connexion par PIN ;
- voit uniquement sa tournée active ;
- voit photo, montant, note et zone ;
- marque chaque colis LIVRÉ / RETOUR / EN ATTENTE ;
- ne peut jamais modifier montant, photo, source ou données financières.

## 3. Compte livreur

Créer un livreur crée immédiatement son compte métier :

1. le Gérant saisit nom, téléphone, zone et PIN 4 chiffres ;
2. `create_livreur_account()` vérifie le rôle du Gérant ;
3. vérification que le PIN n'est utilisé par aucun profil ou livreur actif ;
4. hash bcrypt du PIN ;
5. création de la ligne `livreurs` ;
6. le livreur peut se connecter immédiatement avec son PIN.

Il n'existe pas d'e-mail ou mot de passe visible pour le livreur. Supabase Anonymous Auth fournit seulement la session technique ; `app_sessions` lie cette session au compte métier.

## 4. Relations de données

```
zones
  └──< livreurs
        └──< sorties >── profiles (gerant_id)
              ├──< colis
              └──< sortie_operations
                    └── colis_id (optionnel selon opération)

auth.users
  └──< app_sessions
        ├── profile_id
        └── livreur_id
```

### zones
Une zone peut être affectée à plusieurs livreurs.

### livreurs
Un livreur appartient à une zone principale et possède un PIN hashé.

### sorties
Une tournée appartient à :
- un livreur ;
- un Gérant ;
- une zone figée au moment du départ.

Un livreur ne peut avoir qu'une seule tournée `en_cours`.

### colis
Chaque colis appartient à une tournée et porte :
- `source = initial | ajout` ;
- `valeur` ;
- `photo_path` ;
- `commentaire` ;
- `statut_livreur = en_attente | livre | retourne`.

Valeur 0 = colis déjà payé.

### sortie_operations
Écritures financières / audit :
- retour ;
- deduction_livraison ;
- frais_divers ;
- cloture.

Le statut `retourne` du livreur n'enlève jamais automatiquement de l'argent. Le retour devient financier uniquement lorsque le Gérant confirme une opération `retour`.

## 5. Calcul financier canonique

```
montant_chargement
- retours confirmés
- déductions livraison
- frais divers
= net_a_encaisser
```

Le calcul officiel vient de `v_sorties_resume`, jamais d'une formule différente recopiée dans chaque page.

À la clôture :
- `montant_final = net_a_encaisser` ;
- `nb_colis_final` est figé ;
- `closed_at` est enregistré ;
- une opération de clôture est ajoutée.

## 6. Pages cible

### Connexion
- `index.html`
- PIN 4 chiffres ;
- redirection serveur par rôle.

### Gérant
- `dispatch.html` — préparation / ajout de colis ;
- `point.html` — rapprochement financier et clôture ;
- `rapports.html` — archives ;
- `dossier-detail.html` — dossier complet d'une tournée ;
- `livreurs.html` — équipe ;
- `livreur-detail.html` — profil, historique, modification, reset PIN ;
- `zones.html` — zones ;
- `dashboard.html` — statistiques ;
- `bilan-journee.html` — bilan journalier ;
- `colis.html` — registre global des colis.

### Patronne
- `patronne.html` — supervision ;
- `rapports.html` — tous les dossiers ;
- `dossier-detail.html` — audit détaillé ;
- `livreurs.html` — équipe en lecture ;
- `colis.html` — registre ;
- `bilan-journee.html` — bilan.

### Livreur
- `livreur-app.html` — tournée active et actions terrain.

## 7. Navigation

### Gérant
Nouveau → Le Point → Archives → Équipe → Stats

### Patronne
Supervision → Archives → Équipe → Colis → Bilan

### Livreur
Interface volontairement minimale : sa tournée uniquement.

## 8. Cycle complet d'une tournée

1. Gérant choisit un livreur.
2. La zone du livreur est récupérée.
3. Il ajoute plusieurs colis dans un panier local.
4. Validation :
   - création de tournée si aucune active ;
   - sinon ajout à la tournée active.
5. Le livreur reçoit les colis en Realtime.
6. Il marque LIVRÉ ou RETOUR.
7. Gérant ouvre Le Point :
   - confirme retours ;
   - ajoute colis supplémentaires ;
   - déduit frais des colis payés ;
   - ajoute frais divers.
8. La vue calcule le net.
9. Gérant valide l'encaissement.
10. La tournée passe en archive.
11. Patronne peut auditer l'intégralité du dossier.

## 9. Règles d'intégrité

- une seule tournée active par livreur ;
- un retour financier maximum par colis ;
- une déduction livraison maximum par colis ;
- déduction livraison autorisée uniquement pour un colis de valeur 0 ;
- les opérations doivent appartenir à la même tournée que le colis ;
- le Livreur ne modifie que `statut_livreur` via RPC ;
- Patronne lecture seule ;
- PIN jamais stocké en clair ;
- les anciennes sessions livreur sont révoquées lorsqu'un PIN est réinitialisé ;
- un livreur en tournée ne peut pas être désactivé ;
- une zone utilisée par un livreur actif ne peut pas être désactivée.

## 10. Fichiers SQL

Ne jamais réexécuter `database.sql` sur une base contenant des données.

Évolutions :
- `supabase/migrations/20260919_core_hardening.sql`
- `supabase/migrations/20260919_operational_modules.sql`
- `supabase/migrations/20260919_reporting_scope.sql`

Les futures modifications doivent continuer sous forme de migrations non destructives.
