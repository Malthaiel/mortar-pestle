// Analyst's floating chat window — a clone of ConciergeChatWindow on the same
// shared primitives (AgentChatWindow shell + MessageList + ChatInput +
// RecipeTray + useAgentChat), with two Analyst-specific twists:
//   1. the system prompt carries the Analyst brain + an optional match pointer
//      (the `match` prop — { scrimPath, matchN } — re-keys buildSystem);
//   2. a "teach: …" message routes into the analyst-teach recipe (reviewed in
//      the tray) instead of a free-text turn — the chat never free-writes the
//      brain. The recipe engine below is copied verbatim from Concierge.

import { useEffect, useMemo, useState } from 'react';
import { useAgentChat } from '../../components/agent-chat/useAgentChat.js';
import { makeAnalystSystem } from './analyst-system-prompt.js';
import AgentChatWindow from '../../components/agents/AgentChatWindow.jsx';
import AgentAvatar from '../../components/agents/AgentAvatar.jsx';
import MessageList from '../../components/agent-chat/MessageList.jsx';
import ChatInput from '../../components/agent-chat/ChatInput.jsx';
import RecipeTray from '../../components/agents/RecipeTray.jsx';
import { getRecipe } from '../recipes/index.js';

const IDLE = { phase: 'idle', recipeId: null, ctx: null, proposal: null, error: null };

function normErr(e) {
  if (e && typeof e === 'object' && (e.code || e.message)) return e;
  return { code: 'RECIPE', message: String(e) };
}

export default function AnalystChatWindow({ settings, setSetting, accent, onClose, match, seedText, seedNonce, onSeedConsumed, recipe, target, recipeNonce, onRecipeConsumed }) {
  const matchKey = `${match?.scrimPath || ''}::${match?.matchN ?? ''}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const buildSystem = useMemo(() => makeAnalystSystem(match || {}), [matchKey]);
  const { messages, streaming, error, send } = useAgentChat({ buildSystem });
  const [recipeState, setRecipeState] = useState(IDLE);

  // Recipe kick — nonce-keyed one-shot, copied verbatim from ConciergeChatWindow.
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

  // Hidden recipe turn completing → parse into the confirm phase (verbatim clone).
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

  // Recipe-prefix routing via the provider event (same dispatch pattern as Concierge's in-window
  // file picker): "teach: <fact>" distills into the brain; "correct: <optional note>" regenerates
  // the pointed report with recorded corrections authoritative; "learn" distills the recorded
  // corrections into the brain. correct/learn need the match pointer — unpointed, the recipe
  // surfaces a tray error telling the user to open via Ask Analyst.
  const handleSend = (text, opts) => {
    const t = String(text || '');
    const teach = t.match(/^teach\b[:,]?\s*([\s\S]+)/i);
    if (teach) {
      window.dispatchEvent(new CustomEvent('analyst:open', { detail: { recipe: 'analyst-teach', target: { text: teach[1].trim() } } }));
      return;
    }
    const correct = t.match(/^correct\b[:,]?\s*([\s\S]*)/i);
    if (correct) {
      window.dispatchEvent(new CustomEvent('analyst:open', { detail: { recipe: 'correct-report', target: { scrimPath: match?.scrimPath || '', note: correct[1].trim() } } }));
      return;
    }
    if (/^learn\b[.!]?\s*$/i.test(t.trim())) {
      window.dispatchEvent(new CustomEvent('analyst:open', { detail: { recipe: 'analyst-learn', target: { scrimPath: match?.scrimPath || '' } } }));
      return;
    }
    send(text, opts);
  };

  const scrimName = match?.scrimPath ? String(match.scrimPath).replace(/\.md$/, '').split('/').pop() : '';

  return (
    <AgentChatWindow
      settings={settings}
      setSetting={setSetting}
      posKey="analyst"
      avatar={<AgentAvatar accent={accent} streaming={streaming}/>}
      title="Analyst"
      subtitle={scrimName ? `${scrimName}${match?.matchN != null ? ` — Match ${match.matchN}` : ''}` : 'Deadlock coach-analyst'}
      closeTitle="Close (Esc)"
      onClose={onClose}
    >
      <MessageList
        messages={messages}
        streaming={streaming}
        accent={accent}
        error={error}
        emptyName="Analyst"
        emptyTagline="Deadlock coach-analyst"
        emptyBlurb={'Ask about a match, a player, or the meta. "teach: <fact>" adds durable knowledge to the brain. From a report window (Ask Analyst): "correct: <note>" regenerates the report obeying your recorded corrections, and "learn" distills those corrections into the brain. Every write is previewed first.'}
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
        onSend={handleSend}
        streaming={streaming}
        accent={accent}
        seedText={seedText}
        seedNonce={seedNonce}
        onSeedConsumed={onSeedConsumed}
        placeholder="Ask the Analyst"
        busyPlaceholder="Analyst is thinking…"
      />
    </AgentChatWindow>
  );
}
