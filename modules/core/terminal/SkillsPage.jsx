// Single-pane Skills runner. The selectable-skills list now lives in the left
// sidebar (SkillsNav — the module's renderSecondary slot); this page is just
// the run surface: header → horizontal split
//       Top half: SkillArgsForm + Run + run error / interactive notice.
//       Bottom half: SkillOutput (or empty placeholder).
// Renders an empty state ("Select a skill from the sidebar") until a skill is
// selected.
//
// Selected slug is driven by the URL (/tools/skills/<slug>) — passed in
// as selectedSlug from the module's route slot render.

import { useEffect, useState } from 'react';
import { skillsApi } from './api.js';
import { useSkillsData, findSkillBySlug } from './SkillsProvider.jsx';
import SectionHeader, { EmptyState } from '@host/pages/pulse/SectionHeader.jsx';
import { PrimaryBtn } from '@host/components/ui/index.js';
import { IconChevronLeft } from '@host/components/icons.jsx';
import SkillArgsForm from './SkillArgsForm.jsx';
import SkillOutput from './SkillOutput.jsx';

export default function SkillsPage({ accent, selectedSlug, onBack }) {
  const { skills, runningJobs, setRunningJobForSlug, clearJobForSlug } = useSkillsData();
  const [argValues, setArgValues] = useState({});
  const [argsValid, setArgsValid] = useState(true);
  const [runError, setRunError] = useState(null);
  const [loadingRun, setLoadingRun] = useState(false);

  const accentColor = accent || 'var(--text)';
  const selected = findSkillBySlug(skills, selectedSlug);
  const activeJobId = selectedSlug ? runningJobs[selectedSlug] || null : null;

  useEffect(() => {
    setArgValues({});
    setRunError(null);
  }, [selectedSlug]);

  const triggerRun = async (skill) => {
    setRunError(null);
    setLoadingRun(true);
    try {
      const { jobId } = await skillsApi.runSkill(skill.slug, argValues);
      setRunningJobForSlug(skill.slug, jobId);
    } catch (err) {
      const payload = err.payload || {};
      if (payload.code === 'CONFLICT' && payload.activeJobId) {
        setRunningJobForSlug(skill.slug, payload.activeJobId);
        setRunError(`Already running — attached to existing job.`);
      } else {
        setRunError(payload.error || err.message);
      }
    } finally {
      setLoadingRun(false);
    }
  };

  const runDisabled =
    !selected ||
    selected.interactive ||
    !argsValid ||
    loadingRun ||
    !!activeJobId;

  return (
    <div style={{
      flex: 1, minWidth: 0, minHeight: 0,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
        {onBack && <BackBar onBack={onBack}/>}
        {selected ? (
          <>
            <SectionHeader
              title={selected.command}
              subtitle={selected.description}
              action={
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {selected.destructive && <Badge tone="danger">Destructive</Badge>}
                  {selected.interactive && <Badge tone="muted">Interactive</Badge>}
                </div>
              }
            />

            {/* Top half — args + run controls */}
            <div style={{
              flex: 1, minHeight: 0, overflow: 'auto',
              padding: '18px 24px',
              display: 'flex', flexDirection: 'column', gap: 18,
              borderBottom: '1px solid var(--border)',
            }}>
              <SkillArgsForm
                skill={selected}
                values={argValues}
                onChange={setArgValues}
                onValidity={setArgsValid}
                accent={accentColor}
              />

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <PrimaryBtn
                  disabled={runDisabled}
                  accent={accentColor}
                  title={selected.interactive
                    ? `Interactive skill — run from CLI: ${selected.command}`
                    : activeJobId ? 'Skill already running'
                    : !argsValid ? 'Fill in required arguments' : 'Run skill'}
                  onClick={() => triggerRun(selected)}
                >{loadingRun ? 'Starting…' : (activeJobId ? 'Running' : 'Run')}</PrimaryBtn>

                {selected.interactive && (
                  <span style={{
                    fontSize: 12, color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
                  }}>
                    Run from CLI: <code style={{
                      color: 'var(--text)',
                      background: 'var(--surface-3)',
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-sm)',
                    }}>{selected.command}</code>
                  </span>
                )}
              </div>

              {runError && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-md)',
                  background: 'color-mix(in oklch, #e07b7b 10%, transparent)',
                  border: '1px solid color-mix(in oklch, #e07b7b 28%, transparent)',
                  fontSize: 12, color: '#e07b7b',
                  fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: '#e07b7b', flexShrink: 0,
                  }}/>
                  {runError}
                </div>
              )}
            </div>

            {/* Bottom half — output */}
            <div style={{
              flex: 1, minHeight: 0, overflow: 'auto',
              padding: '18px 24px',
              display: 'flex', flexDirection: 'column',
            }}>
              {activeJobId ? (
                <SkillOutput
                  key={activeJobId}
                  jobId={activeJobId}
                  onCleared={() => clearJobForSlug(selectedSlug)}
                  accent={accentColor}
                />
              ) : (
                <div style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--text-faint)', fontSize: 12,
                  fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                }}>
                  No run yet
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 48,
          }}>
            <EmptyState message="Skill not found — go back to the launchpad." accent={accentColor}/>
          </div>
        )}
    </div>
  );
}

function BackBar({ onBack }) {
  return (
    <div style={{ flexShrink: 0, padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
      <button
        type="button"
        onClick={onBack}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 8px', background: 'transparent', border: 'none',
          borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)', cursor: 'pointer',
          fontSize: 11.5, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
      >
        <IconChevronLeft/> All skills
      </button>
    </div>
  );
}

export function Badge({ tone, children }) {
  const palette = tone === 'danger'
    ? { bg: 'color-mix(in oklch, #e07b7b 12%, transparent)', fg: '#e07b7b', border: 'color-mix(in oklch, #e07b7b 28%, transparent)' }
    : { bg: 'var(--surface-2)', fg: 'var(--text-muted)', border: 'var(--border)' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '4px 10px',
      background: palette.bg,
      color: palette.fg,
      border: `1px solid ${palette.border}`,
      borderRadius: 999,
      fontSize: 9, fontFamily: 'var(--font-mono)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      fontWeight: 700,
    }}>{children}</span>
  );
}
