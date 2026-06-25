// Skills launchpad — the in-pane gallery that replaced the old left-sidebar
// TreeSidebar picker (the sidebar is now module nav). A filterable, sortable
// grid of skill cards grouped by category; a card opens the run detail
// (SkillsPage) at /tools/terminal/skills/<slug>. Modeled on library/BrowseGrid.

import { useMemo, useState } from 'react';
import { navigate } from '@host/router.js';
import { TextInput, Select } from '@host/components/ui/index.js';
import { useSkillsData } from './SkillsProvider.jsx';
import { Badge } from './SkillsPage.jsx';

const CATEGORY_LABELS = { slash: 'SLASH', ingest: 'INGEST', transcripts: 'TRANSCRIPTS' };
const CATEGORY_ORDER = ['slash', 'ingest', 'transcripts'];
const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 };
const SORT_OPTIONS = [{ value: 'name-asc', label: 'Name (A → Z)' }, { value: 'name-desc', label: 'Name (Z → A)' }];

function RunningDot() {
  return <span aria-label="running" style={{
    width: 6, height: 6, borderRadius: 999, flexShrink: 0, background: 'var(--accent)',
    boxShadow: '0 0 0 2px color-mix(in oklch, var(--accent) 28%, transparent), 0 0 5px var(--accent)',
  }}/>;
}

function SkillCard({ skill, accent, running, onOpen }) {
  const accentColor = accent || 'var(--text)';
  return (
    <button
      type="button"
      onClick={onOpen}
      title={skill.command}
      style={{
        textAlign: 'left', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 8,
        padding: '12px 14px', minHeight: 98,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text)',
        transition: 'border-color 120ms ease, background 120ms ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = `color-mix(in oklch, ${accentColor} 50%, var(--border))`; e.currentTarget.style.background = 'var(--surface-3)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--surface-2)'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: accentColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{skill.command}</span>
        {running && <RunningDot/>}
      </div>
      <div style={{
        flex: 1, fontSize: 11.5, lineHeight: 1.4, color: 'var(--text-muted)',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>{skill.description}</div>
      {(skill.destructive || skill.interactive) && (
        <div style={{ display: 'flex', gap: 6 }}>
          {skill.destructive && <Badge tone="danger">Destructive</Badge>}
          {skill.interactive && <Badge tone="muted">Interactive</Badge>}
        </div>
      )}
    </button>
  );
}

export default function SkillsLaunchpad({ accent }) {
  const { skills, runningJobs } = useSkillsData();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('name-asc');
  const accentColor = accent || 'var(--text)';

  const sections = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const dir = sort === 'name-desc' ? -1 : 1;
    return CATEGORY_ORDER
      .map((cat) => ({
        cat,
        list: (skills[cat] || [])
          .filter((s) => !needle || `${s.command} ${s.description || ''}`.toLowerCase().includes(needle))
          .slice()
          .sort((a, b) => dir * (a.command || a.slug).localeCompare(b.command || b.slug)),
      }))
      .filter((sec) => sec.list.length > 0);
  }, [skills, q, sort]);

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '12px 18px 10px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
          <TextInput value={q} onChange={setQ} placeholder="Filter skills…" accent={accentColor} style={{ width: '100%', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)' }} />
        </div>
        <div style={{ width: 150, flexShrink: 0 }}>
          <Select value={sort} onChange={setSort} options={SORT_OPTIONS} accent={accentColor} style={{ borderRadius: 'var(--radius-md)', background: 'var(--surface-2)' }} />
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {sections.length === 0 ? (
          <div style={{ color: 'var(--text-faint)', fontSize: 12, textAlign: 'center', padding: 32 }}>
            {q ? 'No skills match the filter.' : 'No skills found.'}
          </div>
        ) : sections.map((sec) => (
          <div key={sec.cat} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{CATEGORY_LABELS[sec.cat]}</div>
            <div style={GRID}>
              {sec.list.map((s) => (
                <SkillCard
                  key={s.slug}
                  skill={s}
                  accent={accentColor}
                  running={!!runningJobs[s.slug]}
                  onOpen={() => navigate('/tools/terminal/skills/' + encodeURIComponent(s.slug))}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
