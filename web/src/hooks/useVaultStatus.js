import { useCallback, useEffect, useState } from 'react';
import { api, subscribeEvents } from '../api.js';
import { useVaults } from './useVaults.jsx';

// Minimal host-side vault connectivity hook. Used by SettingsDrawer's Vault
// tab to render a status dot + reload button without depending on the
// Planner module's heavier useVault.
export function useVaultStatus() {
  const [vaultStatus, setVaultStatus] = useState('loading'); // loading|connected|no-note|error
  const { activeVault } = useVaults();
  const vaultName = activeVault?.name || 'Citadel';

  const loadVault = useCallback(async () => {
    setVaultStatus('loading');
    try {
      const today = await api.today();
      setVaultStatus(today.exists ? 'connected' : 'no-note');
    } catch {
      setVaultStatus('error');
    }
  }, []);

  useEffect(() => { loadVault(); }, [loadVault]);

  useEffect(() => {
    return subscribeEvents((name) => {
      if (name === 'today') loadVault();
    });
  }, [loadVault]);

  return { vaultStatus, vaultName, loadVault };
}
