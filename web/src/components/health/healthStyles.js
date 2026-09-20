// Shared inline styles for the health surfaces. `labelStyle` was declared
// byte-identically in seven files (CardioChooserPopover, CardioComboWindow,
// GoalsWindow, LogMealPopover, MealBuilderWindow, SplitChooserPopover,
// SplitEditorWindow); one copy now, spread at the call sites exactly as before.
//
// A style OBJECT rather than a component on purpose — every call site spreads
// it into a larger inline style, which a wrapper element would fight.
export const labelStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--text-faint)',
  letterSpacing: '0.05em',
};
