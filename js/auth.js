import { supabase } from './config.js';

const LOCAL_STORAGE_KEY = 'dk_boutique_ui_state';

export const auth = {
  getUIState() {
    try {
      const state = localStorage.getItem(LOCAL_STORAGE_KEY);
      return state ? JSON.parse(state) : null;
    } catch (e) {
      return null;
    }
  },

  async ensureAnonymousSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        const { error } = await supabase.auth.signInAnonymously();
        if (error) {
            console.error("Erreur création session anonyme:", error);
            throw new Error("Impossible d'initialiser la connexion sécurisée.");
        }
    }
  },

  async checkActiveSession() {
    await this.ensureAnonymousSession();
    
    // Vérifier s'il y a une app_session valide en appelant un helper ou en lisant une info
    try {
        const { data, error } = await supabase.rpc('has_valid_app_session');
        if (error) return false;
        return data; // true/false
    } catch(e) {
        return false;
    }
  },

  async loginWithPin(pin) {
    if (!pin || pin.length !== 4) throw new Error('Code PIN invalide.');

    await this.ensureAnonymousSession();

    const { data, error } = await supabase.rpc('login_with_pin', { p_pin: pin });
    
    // LOGS DE DEBUG OBLIGATOIRES
    console.log('PIN LENGTH:', pin.length);
    console.log('LOGIN RESULT:', data);
    console.log('LOGIN ERROR:', error);

    if (error) {
        console.error('Erreur RPC login:', error);
        // Supabase error objects often have the custom raised exception in error.message
        throw new Error(error.message || 'Code PIN incorrect.');
    }

    if (data && data.success) {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
            nom: data.nom,
            role: data.role,
            zone_id: data.zone_id,
            zone_nom: data.zone_nom
        }));
        return data.role;
    }
    
    throw new Error('Code PIN incorrect.');
  },

  async logout() {
    try {
        await supabase.rpc('logout_session');
    } catch(e) {
        console.error("Erreur invalidation app_session:", e);
    }
    await supabase.auth.signOut();
    localStorage.removeItem(LOCAL_STORAGE_KEY);
    window.location.href = 'index.html';
  },

  async requireRole(allowedRoles) {
    const hasSession = await this.checkActiveSession();
    if (!hasSession) {
      window.location.href = 'index.html';
      return null;
    }

    const { data: role, error } = await supabase.rpc('current_app_role');
    
    if (error || !role) {
      this.logout();
      return null;
    }

    if (allowedRoles && !allowedRoles.includes(role)) {
      alert("Accès non autorisé.");
      this.redirectByRole(role);
      return null;
    }

    const { data: { user } } = await supabase.auth.getUser();
    return user;
  },

  redirectByRole(role) {
    switch (role) {
      case 'gerant':
        window.location.replace('./dispatch.html');
        break;
      case 'patronne':
        window.location.replace('./patronne.html');
        break;
      case 'livreur':
        window.location.replace('./livreur-app.html');
        break;
      default:
        window.location.href = 'index.html';
    }
  }
};
