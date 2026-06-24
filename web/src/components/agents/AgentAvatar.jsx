// Generic agent avatar — a colored dot that pulses gently while the agent is
// streaming, then settles. Extracted from AtelierAvatar so every agent (Atelier,
// Concierge, …) shares one indicator. Reuses the existing `atelierAvatarPulse`
// keyframes (no new CSS). The pulse is JS-gated so disabling animations just
// stops emitting the class rather than freezing a streaming indicator.

export default function AgentAvatar({ accent, streaming = false, size = 11 }) {
  const color = accent || 'var(--text)';
  return (
    <span
      data-aos-no-mark
      style={{
        display: 'inline-block',
        width: size, height: size,
        borderRadius: '50%',
        background: color,
        boxShadow: streaming
          ? `0 0 0 0 ${color}`
          : `0 0 0 2.5px color-mix(in oklch, ${color} 24%, transparent)`,
        animation: streaming ? 'atelierAvatarPulse 1.4s ease-in-out infinite' : undefined,
        flexShrink: 0,
      }}
    />
  );
}
