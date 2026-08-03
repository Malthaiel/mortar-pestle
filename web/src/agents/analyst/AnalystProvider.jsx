// Always-mounted host for the Analyst floating window — a clone of
// ConciergeProvider (same ComposedProviders contract: must render `children`,
// settings from useSettings). Opens on 'analyst:open' (via openAnalyst), and
// carries an optional match pointer ({ scrimPath, matchN }) so any surface —
// the dock Agents popover, the report-window header — can summon the Analyst
// aimed at a specific match.
//
// Mutual exclusion (one agent surface at a time on the shared agent-chat
// stream): opening Analyst closes Concierge; the reverse guard listens for
// 'concierge:open' (Concierge predates the Analyst and doesn't know about it).

import { useEffect, useState } from 'react';
import { useSettings } from '../../hooks/useSettings.js';
import AnalystChatWindow from './AnalystChatWindow.jsx';

export default function AnalystProvider({ children }) {
  const { settings, setSetting } = useSettings();
  const accent = settings.accentColor;
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState({ text: '', nonce: 0 });
  const [recipeReq, setRecipeReq] = useState({ recipe: null, target: null, nonce: 0 });
  const [match, setMatch] = useState({ scrimPath: '', matchN: null });

  useEffect(() => {
    const onOpen = (e) => {
      window.dispatchEvent(new CustomEvent('concierge:close'));
      const d = (e && e.detail) || {};
      if (d.scrimPath !== undefined || d.matchN !== undefined) {
        setMatch({ scrimPath: d.scrimPath || '', matchN: d.matchN ?? null });
      }
      setSeed((s) => ({ text: d.prefill || '', nonce: s.nonce + 1 }));
      if (d.recipe) setRecipeReq((r) => ({ recipe: d.recipe, target: d.target || null, nonce: r.nonce + 1 }));
      setOpen(true);
    };
    const onClose = () => setOpen(false);
    const onToggle = () => setOpen((o) => !o);
    const onConciergeOpen = () => setOpen(false);
    window.addEventListener('analyst:open', onOpen);
    window.addEventListener('analyst:close', onClose);
    window.addEventListener('analyst:toggle', onToggle);
    window.addEventListener('concierge:open', onConciergeOpen);
    return () => {
      window.removeEventListener('analyst:open', onOpen);
      window.removeEventListener('analyst:close', onClose);
      window.removeEventListener('analyst:toggle', onToggle);
      window.removeEventListener('concierge:open', onConciergeOpen);
    };
  }, []);

  return (
    <>
      {children}
      {open && (
        <AnalystChatWindow
          settings={settings}
          setSetting={setSetting}
          accent={accent}
          match={match}
          seedText={seed.text}
          seedNonce={seed.nonce}
          onSeedConsumed={() => setSeed((s) => ({ text: '', nonce: s.nonce }))}
          recipe={recipeReq.recipe}
          target={recipeReq.target}
          recipeNonce={recipeReq.nonce}
          onRecipeConsumed={() => setRecipeReq((r) => ({ ...r, recipe: null, target: null }))}
          onClose={closeAnalyst}
        />
      )}
    </>
  );
}

// Imperative openers — any surface can summon the Analyst without holding a ref.
// opts: { scrimPath, matchN } (match pointer) and/or { prefill } and/or { recipe, target }.
export function openAnalyst(opts) { window.dispatchEvent(new CustomEvent('analyst:open', { detail: opts || {} })); }
export function closeAnalyst() { window.dispatchEvent(new CustomEvent('analyst:close')); }
export function toggleAnalyst() { window.dispatchEvent(new CustomEvent('analyst:toggle')); }
