// aiRetry.js — the one place that decides when a coaching_classify_match / coaching_agent_run
// call is worth repeating. Pure ESM (no React, no @host) so the Node selftests exercise it.
//
// The rule: a PARSE failure is worth one reprompt (the model answered, just not in the contract).
// A TRANSPORT failure — timeout/kill, spawn error, auth, upstream HTTP — is not. Reprompting a
// timeout resends an even longer prompt into the same wall, guaranteeing a second kill and
// double-billing the run for nothing. Transport errors propagate to the caller, which owns the
// degrade decision (throw, or ship the pass un-run with a warning).
//
// Born from a VOD report that burned ~20 minutes and a quarter of a Claude Pro session window on
// two draft attempts, both killed at the 5-minute CLI wall, with zero output saved.

// A user cancel (Rust `DeadlockError::Canceled`) is not a bad pass — it is a stop. Every degrade
// path that swallows a failed pass and rolls on MUST rethrow it, or the stop button just skips one
// pass and the pipeline spends money on the next one. Lives here because this module already owns
// "which failures mean what" for the whole coaching pipeline.
export const isCancel = (err) => err?.code === 'CANCELED';

// `call(userPrompt) => Promise<string>` (the raw model text), `parse(raw) => T` (throws on
// contract violation), `hint` = the format nudge appended to the reprompt.
// `onRaw(raw)` (optional) sees every raw response before parsing — used to persist an expensive
// generation so a double parse failure is recoverable by hand instead of thrown away.
export async function parseOrRetry(call, user, parse, hint, onRaw) {
  const once = async (prompt) => {
    const raw = await call(prompt); // transport error → propagates, never retried
    if (onRaw) { try { await onRaw(raw); } catch { /* persistence is best-effort, never blocks */ } }
    return raw;
  };
  const raw = await once(user);
  try {
    return parse(raw);
  } catch (err) {
    return parse(await once(`${user}\n\nYour previous response failed to parse (${err.message}). ${hint}`));
  }
}
