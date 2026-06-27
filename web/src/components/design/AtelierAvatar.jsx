// SF6 of Design Mode plan — Atelier's avatar. A single colored dot that
// pulses gently while the assistant is taking its turn, then settles when
// streaming ends. The pulse is JS-gated rather than CSS-toggled so that
// disabling animations does not freeze a streaming indicator (we just stop
// emitting the pulsing class).

export default function AtelierAvatar({ accent, streaming = false, size = 10 }) {
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
          ? `0 0 0 2.5px ${color}`
          : `0 0 0 2.5px color-mix(in oklch, ${color} 24%, transparent)`,
        flexShrink: 0,
      }}
    />
  );
}
