// Renders the currently-active subtitle cues on top of the <video>, styled
// per the user's saved subSettings + per-episode sync offset. The provider
// keeps the <track> in mode='hidden' so we own all visual rendering here.

import { useMemo } from 'react';
import { useVideoPlayer } from './VideoPlayerProvider.jsx';

const FAMILY_MAP = {
  sans:  'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono:  'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

// Strip non-style VTT tags, keep <b>/<i>/<u>, convert newlines to <br>.
// Cue text comes from the local file; risk of injection is minimal but the
// allowlist keeps it tight.
function cueToHTML(text) {
  return text
    .replace(/<v[^>]*>/gi, '')
    .replace(/<\/v>/gi, '')
    .replace(/<c[^>]*>/gi, '')
    .replace(/<\/c>/gi, '')
    .replace(/<lang[^>]*>/gi, '')
    .replace(/<\/lang>/gi, '')
    .replace(/<\d{2}:\d{2}[:.]\d{2,3}(?:[.:]\d{1,3})?>/g, '')
    .replace(/\n/g, '<br>');
}

export default function SubtitleOverlay() {
  const v = useVideoPlayer();
  const { subSettings: s, subSync, cues, videoTime, subIdx } = v;

  const active = useMemo(() => {
    if (!cues || cues.length === 0 || subIdx < 0) return [];
    const t = videoTime;
    const out = [];
    for (const c of cues) {
      if (c.startTime + subSync <= t && t < c.endTime + subSync) {
        out.push(c);
      }
    }
    return out;
  }, [cues, videoTime, subSync, subIdx]);

  if (active.length === 0) return null;

  const fontFamily = FAMILY_MAP[s.fontFamily] || FAMILY_MAP.sans;
  const cueStyle = {
    color: '#ffffff',
    fontSize: s.size,
    fontFamily,
    fontWeight: s.fontWeight,
    letterSpacing: `${s.letterSpacing}px`,
    lineHeight: s.lineHeight,
    padding: s.bgStyle === 'box' ? '3px 10px' : '0',
    margin: 0,
    display: 'inline-block',
    maxWidth: '90%',
    whiteSpace: 'pre-wrap',
    textAlign: 'center',
  };
  if (s.bgStyle === 'box') {
    cueStyle.backgroundColor = `rgba(0,0,0,${s.bgOpacity})`;
    cueStyle.borderRadius = 4;
  } else if (s.bgStyle === 'shadow') {
    const sz = Number(s.shadowSize) || 4;
    cueStyle.textShadow =
      `0 0 ${sz}px rgba(0,0,0,0.95), 0 0 ${sz * 2}px rgba(0,0,0,0.75), 1px 1px ${Math.max(1, sz / 2)}px rgba(0,0,0,0.9)`;
  } else if (s.bgStyle === 'outline') {
    const ol = Number(s.outlineSize);
    const px = Number.isFinite(ol) ? ol : 2;
    cueStyle.WebkitTextStroke = `${px}px #000`;
    cueStyle.paintOrder = 'stroke fill';
    cueStyle.textShadow = '0 0 4px rgba(0,0,0,0.7)';
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: `${s.position * 100}%`,
        left: 0, right: 0,
        transform: 'translateY(-100%)',
        pointerEvents: 'none',
        zIndex: 2,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
        paddingLeft: 16, paddingRight: 16,
      }}
    >
      {active.map((c, i) => (
        <div
          key={i + ':' + c.startTime}
          style={cueStyle}
          dangerouslySetInnerHTML={{ __html: cueToHTML(c.text) }}
        />
      ))}
    </div>
  );
}
