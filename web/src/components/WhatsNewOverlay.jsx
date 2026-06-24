import { useEffect, useState } from 'react';
import { useReleases } from '../hooks/useReleases.js';
import { getCurrentVersion, getLastSeenVersion, setLastSeenVersion } from '../hooks/useLastSeenVersion.js';
import { navigate } from '../router.js';
import { renderInline } from './ui/inlineMarkdown.jsx';

export default function WhatsNewOverlay() {
  const { releases } = useReleases();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!releases.length) return;
    const last = getLastSeenVersion();
    const current = getCurrentVersion();
    if (last !== current) {
      // Small delay so the user sees the app boot first
      const t = setTimeout(() => setOpen(true), 900);
      return () => clearTimeout(t);
    }
  }, [releases.length]);

  const handleClose = () => {
    setOpen(false);
    setLastSeenVersion(getCurrentVersion());
  };

  const handleOpenReleases = () => {
    setOpen(false);
    setLastSeenVersion(getCurrentVersion());
    navigate('/docs/releases');
  };

  const current = releases.find(r => r.version === getCurrentVersion());
  if (!open || !current) return null;

  const accentColor = 'var(--accent)';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1300,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div
        onClick={handleClose}
        className="candy-backdrop"
        style={{ '--candy-backdrop-alpha': '0.48' }}
      />
      <div role="dialog" aria-label={`What's new in ${current.versionLabel || current.version}`} className="candy-modal" style={{
        position: 'relative',
        width: 520, maxWidth: '92vw', maxHeight: '80vh',
        overflow: 'hidden',
        animation: 'fadeIn 0.24s ease',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          padding: '18px 22px 14px',
          borderBottom: '1px solid var(--border-soft)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 10,
            marginBottom: 4,
          }}>
            <span style={{
              fontSize: 13, fontWeight: 600, color: 'var(--text)',
            }}>Iskariel</span>
            <span style={{
              fontSize: 11, fontFamily: 'var(--font-mono)',
              color: accentColor, fontWeight: 600,
              border: `1px solid color-mix(in oklch, ${accentColor} 30%, transparent)`,
              borderRadius: 4, padding: '1px 7px',
            }}>{current.versionLabel || current.version}</span>
            <span style={{
              fontSize: 11, color: 'var(--text-muted)',
              marginLeft: 'auto',
            }}>{current.tag}</span>
          </div>
          <div style={{
            fontSize: 17, fontWeight: 600, color: 'var(--text)',
            letterSpacing: '-0.01em',
          }}>
            {current.title}
          </div>
        </div>

        {/* Body */}
        <div style={{
          flex: 1, overflowY: 'auto',
          padding: '16px 22px 18px',
        }}>
          {(current.summary || current.narrative) && (
            <p style={{
              fontSize: 13, lineHeight: 1.55, color: 'var(--text)',
              margin: '0 0 14px',
              fontStyle: 'italic',
            }}>{renderInline(current.summary || current.narrative)}</p>
          )}

          {current.features.length > 0 && (
            <>
              <div style={{
                fontSize: 9, fontFamily: 'var(--font-mono)',
                letterSpacing: '0.08em', textTransform: 'uppercase',
                color: accentColor, fontWeight: 600,
                marginBottom: 8,
              }}>New in this release</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {current.features.slice(0, 6).map((f, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8,
                  }}>
                    <span style={{
                      width: 5, height: 5, borderRadius: '50%',
                      background: accentColor, marginTop: 6,
                      flexShrink: 0,
                    }}
                    />
                    <span style={{
                      fontSize: 12.5, color: 'var(--text)',
                      lineHeight: 1.45,
                    }}>{renderInline(f)}</span>
                  </div>
                ))}
                {current.features.length > 6 && (
                  <div style={{
                    fontSize: 11, color: 'var(--text-muted)',
                    paddingLeft: 13,
                  }}>+ {current.features.length - 6} more</div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 22px 14px',
          borderTop: '1px solid var(--border-soft)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <button
            onClick={handleOpenReleases}
            style={{
              fontSize: 12, fontWeight: 600, color: accentColor,
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: '4px 0',
              fontFamily: 'var(--font-body)',
            }}
          >
            See full release history →
          </button>
          <button
            onClick={handleClose}
            style={{
              fontSize: 12, fontWeight: 600, color: 'var(--text)',
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '5px 14px', cursor: 'pointer',
              fontFamily: 'var(--font-body)',
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
