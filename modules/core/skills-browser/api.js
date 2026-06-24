// Skills Browser module's API helpers. Closure-captures the SDK api at
// register-time so the React tab can install / uninstall demo skills
// without prop-drilling the api object.

const INSTALL_DIR = 'Infrastructure/Skills/Slash';

export function bindSkillsBrowserApi(api) {
  return {
    async isInstalled(id) {
      try {
        await api.invoke('vault_read_file', { path: `${INSTALL_DIR}/${id}.md` });
        return true;
      } catch (e) {
        // Tauri VaultError shape: { code: 'NOT_FOUND' }. HTTP fallback shape: { status: 404 }.
        if (e?.code === 'NOT_FOUND' || e?.status === 404 || /not found|enoent/i.test(String(e?.message))) {
          return false;
        }
        throw e;
      }
    },
    async install(id, content) {
      return api.invoke('vault_write_file', { path: `${INSTALL_DIR}/${id}.md`, content });
    },
    async uninstall(id) {
      return api.invoke('vault_delete_file', { path: `${INSTALL_DIR}/${id}.md` });
    },
  };
}

export { INSTALL_DIR };
