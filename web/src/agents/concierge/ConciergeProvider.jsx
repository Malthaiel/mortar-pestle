// Always-mounted host for the Concierge floating window, registered as the
// Agents module's provider. Module providers mount via ComposedProviders, which
// wraps the app — so this MUST render `children` — and pass no props, so settings
// are sourced from the host useSettings hook. Opens on the
// 'concierge:open' window event (dispatched via openConcierge), so any surface —
// the dock Agents popover, the context-menu "Ask AI" (SF5) — can summon Concierge
// without prop-drilling.

import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../../hooks/useSettings.js';
import ConciergeChatWindow from './ConciergeChatWindow.jsx';

export default function ConciergeProvider({ children }) {
  const { settings, setSetting } = useSettings();
  const accent = settings.accentColor;
  const [open, setOpen] = useState(false);
  // SF5 — prefill seed for "Ask Concierge" on a selection. The nonce bumps on
  // every open so re-asking re-seeds even with identical text; it's one-shot —
  // ChatInput clears it via onSeedConsumed so a later reopen never re-injects.
  const [seed, setSeed] = useState({ text: '', nonce: 0 });
  // SF6 — one-shot recipe trigger (e.g. organize-md from the .md viewer). The
  // nonce bumps only when an open carries a recipe; ConciergeChatWindow consumes
  // it on entry so a later reopen without a recipe never re-fires the last one.
  const [recipeReq, setRecipeReq] = useState({ recipe: null, target: null, nonce: 0 });

  // Ref so the once-registered window listeners read the LIVE designMode +
  // setSetting (mutual exclusion below), not a mount-time closure.
  const muteRef = useRef(null);
  muteRef.current = { designMode: !!settings?.agents?.mode, setSetting };

  useEffect(() => {
    const onOpen = (e) => {
      // Mutual exclusion centralized here: opening Concierge exits Design Mode
      // (Atelier) — one agent surface at a time on the shared agent-chat stream,
      // so every caller (dock, context-menu "Ask Concierge") gets it for free.
      const m = muteRef.current;
      if (m.designMode) m.setSetting('agents', { mode: false });
      const prefill = (e && e.detail && e.detail.prefill) || '';
      setSeed((s) => ({ text: prefill, nonce: s.nonce + 1 }));
      const recipe = (e && e.detail && e.detail.recipe) || null;
      if (recipe) {
        const target = (e && e.detail && e.detail.target) || null;
        setRecipeReq((r) => ({ recipe, target, nonce: r.nonce + 1 }));
      }
      setOpen(true);
    };
    const onClose = () => setOpen(false);
    const onToggle = () => setOpen((o) => !o);
    window.addEventListener('concierge:open', onOpen);
    window.addEventListener('concierge:close', onClose);
    window.addEventListener('concierge:toggle', onToggle);
    return () => {
      window.removeEventListener('concierge:open', onOpen);
      window.removeEventListener('concierge:close', onClose);
      window.removeEventListener('concierge:toggle', onToggle);
    };
  }, []);

  // Belt-and-suspenders for the reverse direction: if Design Mode turns on by any
  // other path, Concierge closes (it can't share the agent-chat stream with Atelier).
  const designMode = !!settings?.agents?.mode;
  useEffect(() => { if (designMode) setOpen(false); }, [designMode]);

  return (
    <>
      {children}
      {open && (
        <ConciergeChatWindow
          settings={settings}
          setSetting={setSetting}
          accent={accent}
          seedText={seed.text}
          seedNonce={seed.nonce}
          onSeedConsumed={() => setSeed((s) => ({ text: '', nonce: s.nonce }))}
          recipe={recipeReq.recipe}
          target={recipeReq.target}
          recipeNonce={recipeReq.nonce}
          onRecipeConsumed={() => setRecipeReq((r) => ({ ...r, recipe: null, target: null }))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// Imperative openers — any surface can summon Concierge without holding a ref.
// openConcierge accepts an optional { prefill } (Ask-Concierge-on-selection seed)
// and/or { recipe, target } (SF6 — kick a recipe like organize-md), delivered to
// the provider via the CustomEvent detail.
export function openConcierge(opts) { window.dispatchEvent(new CustomEvent('concierge:open', { detail: opts || {} })); }
export function closeConcierge() { window.dispatchEvent(new CustomEvent('concierge:close')); }
export function toggleConcierge() { window.dispatchEvent(new CustomEvent('concierge:toggle')); }
