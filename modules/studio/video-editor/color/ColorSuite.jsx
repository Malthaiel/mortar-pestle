// ColorSuite — Color mode's footer suite: mini clip strip mirroring timeline
// order + the grading columns. Wheels (SF7) and Sat/Temp/LUT (SF7) are live;
// Curves (SF8) and Scopes (SF9) are placeholders until their controls land.
//
// The suite owns the GESTURE PROTOCOL for grade edits on the target clip:
// - draftPatch(patch): working+patch → React state (control positions) AND
//   the pipeline draft slot (live GL preview, zero React in the hot path).
// - gestureEnd(label): commits the accumulated draft as ONE undo op.
// - commitPatch(patch, label): one-shot commit (resets, LUT load/remove).
// A grade committed back to identity is stored as `undefined` so the clip
// serializes with no grade key (gradeOps schema rule).
//
// Auto-target = selected clip else clip under playhead (locked decision):
// selection anchor wins; otherwise the topmost-lane clip spanning the
// playhead frame at render time.

import { useEffect, useMemo, useRef, useState } from 'react';
import { WheelsColumn, SatLutColumn, CurvesColumn } from './GradeControls.jsx';
import ScopeView from './ScopeView.jsx';
import { DEFAULT_GRADE, normalizeGrade, isIdentityGrade } from './gradeOps.js';
import { setGradeDraft } from './gradePipeline.js';

const mono = { fontFamily: 'var(--font-mono), monospace' };

const paneLabel = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-faint)',
  padding: '10px 12px',
  userSelect: 'none',
  flexShrink: 0,
};

export default function ColorSuite({
  project, selection, playheadFrameRef, accent,
  api, projName, lutEpoch,
  onSelectClip, onSeekFrame, onCommitGrade, onNotice,
  bypass, onToggleBypass,
}) {
  const edge = accent || 'var(--accent)';

  // Timeline order: all lanes, sorted by start frame (lane index breaks ties).
  const rows = useMemo(() => {
    const all = [];
    (project?.tracks || []).forEach((t, laneIdx) => {
      for (const c of t.clips) all.push({ c, laneIdx });
    });
    all.sort((a, b) => a.c.start - b.c.start || a.laneIdx - b.laneIdx);
    return all;
  }, [project]);

  const nameOf = useMemo(() => {
    const m = new Map();
    for (const x of project?.media || []) m.set(x.id, (x.src || '').split('/').pop());
    return m;
  }, [project]);

  const target = useMemo(() => {
    if (selection.length) return selection[0];
    const f = playheadFrameRef?.current ?? 0;
    const hit = rows.find(({ c }) => f >= c.start && f < c.start + c.dur);
    return hit ? { laneIdx: hit.laneIdx, clipId: hit.c.id } : null;
  }, [selection, rows, playheadFrameRef]);

  const targetClip = target
    ? project?.tracks[target.laneIdx]?.clips.find((c) => c.id === target.clipId) || null
    : null;

  // ── gesture protocol ──────────────────────────────────────────────────
  const committed = useMemo(
    () => (targetClip?.grade ? normalizeGrade(targetClip.grade) : DEFAULT_GRADE),
    [targetClip?.grade],
  );
  const [draft, setDraft] = useState(null);
  // Ref mirror so a draft+end in ONE handler (e.g. curve-point removal)
  // commits the fresh draft instead of the render closure's stale one.
  const draftRef = useRef(null);
  useEffect(() => {
    setDraft(null);
    draftRef.current = null;
    setGradeDraft(null, null);
    return () => setGradeDraft(null, null); // suite unmount (mode switch) drops any live draft
  }, [target?.clipId]);
  const working = draft ?? committed;

  const commit = (grade, label) => {
    setDraft(null);
    draftRef.current = null;
    setGradeDraft(null, null);
    if (!target) return;
    onCommitGrade(target.laneIdx, target.clipId, grade && !isIdentityGrade(grade) ? grade : undefined, label);
  };
  const draftPatch = (patch) => {
    if (!target) return;
    const next = { ...(draftRef.current ?? committed), ...patch };
    setDraft(next);
    draftRef.current = next;
    setGradeDraft(target.clipId, next);
  };
  const gestureEnd = (label) => {
    if (draftRef.current) commit(draftRef.current, label);
  };
  const commitPatch = (patch, label) => commit({ ...(draftRef.current ?? committed), ...patch }, label);

  const disabledHint = (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ ...mono, fontSize: 10.5, color: 'var(--text-muted)' }}>select a clip</span>
    </div>
  );

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ width: 190, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ ...paneLabel, display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 8 }}>
          <span>Clips</span>
          <button
            type="button"
            title="Bypass all grades in the preview (d)"
            onClick={onToggleBypass}
            style={{
              ...mono,
              fontSize: 9,
              background: 'none',
              border: `1px solid ${bypass ? edge : 'var(--border)'}`,
              color: bypass ? edge : 'var(--text-faint)',
              borderRadius: 4,
              padding: '1px 6px',
              cursor: 'pointer',
              letterSpacing: '0.06em',
            }}
          >
            BYPASS
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rows.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 4px' }}>No clips</div>
          )}
          {rows.map(({ c, laneIdx }) => {
            const isTarget = target?.clipId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => { onSelectClip(laneIdx, c.id, false); onSeekFrame(c.start); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 8px',
                  background: 'var(--surface)',
                  border: `1px solid ${isTarget ? edge : 'var(--border)'}`,
                  boxShadow: isTarget ? `0 0 0 1px ${edge}` : 'none',
                  borderRadius: 7,
                  cursor: 'pointer',
                  textAlign: 'left',
                  flexShrink: 0,
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                  {nameOf.get(c.mediaId) || c.mediaId}
                </span>
                {c.grade && (
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: edge, flexShrink: 0 }} />
                )}
                <span style={{ ...mono, fontSize: 9.5, color: 'var(--text-faint)', flexShrink: 0 }}>
                  {c.start}f
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1.5, minWidth: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={paneLabel}>Wheels</div>
        {targetClip ? (
          <WheelsColumn
            working={working}
            accent={accent}
            draftPatch={draftPatch}
            gestureEnd={gestureEnd}
            commitPatch={commitPatch}
          />
        ) : disabledHint}
      </div>

      <div style={{ flex: 1, minWidth: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={paneLabel}>Sat · Temp · LUT</div>
        {targetClip ? (
          <SatLutColumn
            key={lutEpoch /* offline badges re-evaluate when prefetch lands */}
            working={working}
            accent={accent}
            api={api}
            projName={projName}
            draftPatch={draftPatch}
            gestureEnd={gestureEnd}
            commitPatch={commitPatch}
            commitGrade={commit}
            onNotice={onNotice}
          />
        ) : disabledHint}
      </div>

      <div style={{ flex: 1.2, minWidth: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={paneLabel}>Curves</div>
        {targetClip ? (
          <CurvesColumn
            working={working}
            accent={accent}
            draftPatch={draftPatch}
            gestureEnd={gestureEnd}
            commitPatch={commitPatch}
          />
        ) : disabledHint}
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={paneLabel}>Scopes</div>
        <ScopeView accent={accent} />
      </div>
    </div>
  );
}
