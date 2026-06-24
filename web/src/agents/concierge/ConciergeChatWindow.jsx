// Concierge's floating chat window — the app-wide helper surface. Composes the
// shared <AgentChatWindow> shell (frame + header + drag) with the reused
// MessageList + ChatInput, and its own Concierge system prompt via useAgentChat.
// No pointer modes / token tools (those are Atelier-specific).
//
// SF4/SF6 — the recipe engine lives here: a recipe round-trip runs `hidden`
// (tray-centric), and the RecipeTray (between MessageList and ChatInput) is where
// its proposal is reviewed and applied. Recipes trigger via openConcierge
// ({ recipe, target }) — from PageView's action OR the in-window file picker
// (header button) — threaded one-shot through `recipeNonce`.

import { useEffect, useMemo, useState } from 'react';
import { useAgentChat } from '../../components/design/useAgentChat.js';
import { makeConciergeSystem } from './concierge-system-prompt.js';
import { api } from '../../api.js';
import AgentChatWindow from '../../components/agents/AgentChatWindow.jsx';
import AgentAvatar from '../../components/agents/AgentAvatar.jsx';
import MessageList from '../../components/design/MessageList.jsx';
import ChatInput from '../../components/design/ChatInput.jsx';
import RecipeTray from '../../components/agents/RecipeTray.jsx';
import { getRecipe } from '../recipes/index.js';

const IDLE = { phase: 'idle', recipeId: null, ctx: null, proposal: null, error: null };

function normErr(e) {
  if (e && typeof e === 'object' && (e.code || e.message)) return e;
  return { code: 'RECIPE', message: String(e) };
}

function notify(message) {
  try {
    window.dispatchEvent(new CustomEvent('agentic:notify', { detail: { type: 'info', title: 'Concierge', message, duration: 4000 } }));
  } catch {}
}

// The OS file dialog returns an absolute path; organize-md needs a content-vault
// relative path. Strip the active vault root (case-insensitive, backslash-tolerant)
// and require a .md under it — else null (the pick was outside the vault).
function toVaultRel(abs, root) {
  if (!abs || !root) return null;
  const a = abs.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!a.toLowerCase().startsWith(r.toLowerCase() + '/')) return null;
  const rel = a.slice(r.length + 1);
  return /\.md$/i.test(rel) ? rel : null;
}

export default function ConciergeChatWindow({ settings, setSetting, accent, onClose, seedText, seedNonce, onSeedConsumed, recipe, target, recipeNonce, onRecipeConsumed }) {
  const buildSystem = useMemo(() => makeConciergeSystem(), []);
  const { messages, streaming, error, send } = useAgentChat({ buildSystem });
  const [recipeState, setRecipeState] = useState(IDLE);

  // SF6 — kick a recipe when triggered. Nonce-keyed + one-shot (consume on entry)
  // mirroring the SF5 seed, so a later reopen without a recipe never re-fires.
  useEffect(() => {
    if (!recipe) return;
    const def = getRecipe(recipe);
    onRecipeConsumed && onRecipeConsumed();
    if (!def) return;
    let cancelled = false;
    setRecipeState({ phase: 'loading', recipeId: def.id, ctx: null, proposal: null, error: null });
    (async () => {
      try {
        const ctx = await def.loadContext(target);
        if (cancelled) return;
        setRecipeState({ phase: 'running', recipeId: def.id, ctx, proposal: null, error: null });
        send(def.buildPrompt(ctx), { hidden: true, history: false });
      } catch (e) {
        if (!cancelled) setRecipeState((s) => ({ ...s, phase: 'error', error: normErr(e) }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipeNonce]);

  // SF4 — detect the hidden recipe turn completing. Only one turn is ever in
  // flight (ChatInput gates on !streaming), so a running-phase streaming flip is
  // unambiguously this recipe's response.
  useEffect(() => {
    if (recipeState.phase !== 'running' || streaming) return;
    if (error) { setRecipeState((s) => ({ ...s, phase: 'error', error })); return; }
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const def = getRecipe(recipeState.recipeId);
    try {
      const proposal = def.parse(last.content, recipeState.ctx);
      setRecipeState((s) => ({ ...s, phase: 'confirm', proposal }));
    } catch (e) {
      setRecipeState((s) => ({ ...s, phase: 'error', error: normErr(e) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, error]);

  const applyRecipe = async () => {
    const def = getRecipe(recipeState.recipeId);
    if (!def || !recipeState.proposal) return;
    setRecipeState((s) => ({ ...s, phase: 'applying' }));
    try {
      await def.apply(recipeState.proposal);
      setRecipeState((s) => ({ ...s, phase: 'done' }));
    } catch (e) {
      setRecipeState((s) => ({ ...s, phase: 'error', error: normErr(e) }));
    }
  };
  const closeRecipe = () => setRecipeState(IDLE);

  // SF6 — in-chat file picker (decision #7's 2nd half): pick any vault .md via the
  // OS dialog, convert to a content-vault-relative path, and kick organize-md
  // through the same provider event the viewer action uses (bumps recipeNonce).
  const pickAndOrganize = async () => {
    try {
      const [{ open }, listed] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        api.vaults.list().catch(() => null),
      ]);
      const vaults = listed?.vaults || [];
      const active = vaults.find((v) => v.id === listed?.activeId)
        || vaults.find((v) => (v.role || 'content') === 'content');
      const root = active?.path;
      const picked = await open({
        directory: false, multiple: false,
        title: 'Pick a Markdown note to organize',
        defaultPath: root || undefined,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      const abs = typeof picked === 'string' ? picked : (picked && picked.path) || null;
      if (!abs) return; // cancelled
      const rel = toVaultRel(abs, root);
      if (!rel) { notify('Pick a note inside the active vault.'); return; }
      window.dispatchEvent(new CustomEvent('concierge:open', { detail: { recipe: 'organize-md', target: rel } }));
    } catch {
      notify('Could not open the file picker.');
    }
  };

  return (
    <AgentChatWindow
      settings={settings}
      setSetting={setSetting}
      posKey="concierge"
      avatar={<AgentAvatar accent={accent} streaming={streaming}/>}
      title="Concierge"
      subtitle="helper"
      closeTitle="Close (Esc)"
      onClose={onClose}
      headerControls={
        <button
          type="button"
          onClick={pickAndOrganize}
          title="Organize a note… (pick a file)"
          style={{
            width: 24, height: 24,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none',
            color: 'var(--text-muted)', cursor: 'pointer', borderRadius: 6,
            transition: 'background 100ms ease, color 100ms ease', flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--hover)'; e.currentTarget.style.color = 'var(--text)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>
            <path d="M14 3v5h5"/>
            <line x1="9" y1="13" x2="15" y2="13"/>
            <line x1="9" y1="17" x2="13" y2="17"/>
          </svg>
        </button>
      }
    >
      <MessageList
        messages={messages}
        streaming={streaming}
        accent={accent}
        error={error}
        emptyName="Concierge"
        emptyTagline="app-wide helper"
        emptyBlurb="Ask me anything, or organize a note — from its page, or the file button up top."
      />
      {recipeState.phase !== 'idle' && (
        <RecipeTray
          recipeState={recipeState}
          def={getRecipe(recipeState.recipeId)}
          accent={accent}
          onApply={applyRecipe}
          onDiscard={closeRecipe}
          onClose={closeRecipe}
        />
      )}
      <ChatInput
        onSend={send}
        streaming={streaming}
        accent={accent}
        seedText={seedText}
        seedNonce={seedNonce}
        onSeedConsumed={onSeedConsumed}
        placeholder="Ask Concierge"
        busyPlaceholder="Concierge is thinking…"
      />
    </AgentChatWindow>
  );
}
