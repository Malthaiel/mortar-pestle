import { useState } from 'react';
import { FilterChip, PrimaryBtn, OutlinedBtn } from '@host/components/ui/index.js';

export default function NotesPanel({
  sessionActive, activeTaskName, activeNote, onNoteChange,
  recentNotes, onUpdateNote, onRefresh, vaultConnected, accent,
  onFreeformNote,
}) {
  const [filterByTask, setFilterByTask] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [editText, setEditText] = useState('');
  const [freeformText, setFreeformText] = useState('');
  const [showFreeform, setShowFreeform] = useState(false);

  let filtered = recentNotes.filter(n => n.type !== 'break');
  if (filterByTask && activeTaskName) {
    filtered = filtered.filter(n => n.task === activeTaskName);
  }

  function startEdit(note) {
    setExpandedId(note.id);
    setEditText(note.notes || '');
  }
  function saveEdit(note) {
    onUpdateNote?.(note.dateStr, note.idx ?? 0, editText);
    setExpandedId(null);
    setEditText('');
  }

  function submitFreeform() {
    if (!freeformText.trim()) return;
    onFreeformNote?.(freeformText.trim());
    setFreeformText('');
    setShowFreeform(false);
  }

  function relTime(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const now = new Date();
    const days = Math.floor((now - d) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  return (
    <div className="flex-col" style={{
      height: '100%', background: 'var(--surface)',
      borderLeft: '1px solid var(--border)',
    }}>
      {/* Composer header */}
      <div style={{
        padding: '14px 20px 14px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
        }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%',
            background: sessionActive ? accent : 'var(--text-faint)',
            boxShadow: sessionActive
              ? `0 0 0 3px color-mix(in oklch, ${accent} 22%, transparent)`
              : 'none',
            flexShrink: 0,
          }}/>
          <span style={{
            fontSize: 9, fontFamily: 'var(--font-mono)',
            color: 'var(--text-faint)',
            letterSpacing: '0.08em', textTransform: 'uppercase',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
          }}>
            {sessionActive ? `SESSION · ${activeTaskName}` : 'NO ACTIVE SESSION'}
          </span>
        </div>
        <textarea
          value={activeNote} onChange={e => onNoteChange(e.target.value)}
          disabled={!sessionActive}
          placeholder={sessionActive ? 'Session notes…' : 'Start a focus session to take notes'}
          style={{
            width: '100%', minHeight: 76, resize: 'vertical',
            padding: '10px 12px', borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
            background: sessionActive ? 'var(--surface)' : 'var(--surface-2)',
            fontSize: 12, lineHeight: 1.5, outline: 'none',
            color: sessionActive ? 'var(--text)' : 'var(--text-faint)',
            fontFamily: 'var(--font-body)',
            opacity: sessionActive ? 1 : 0.65,
            transition: 'border-color 120ms ease',
          }}
        />
      </div>

      {/* Filter chips row */}
      <div style={{
        padding: '10px 20px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {activeTaskName && (
          <FilterChip
            active={filterByTask}
            accent={accent}
            onClick={() => setFilterByTask(f => !f)}
          >{activeTaskName}</FilterChip>
        )}
        <div style={{ flex: 1 }}/>
        <FilterChip
          active={showFreeform}
          accent={accent}
          onClick={() => setShowFreeform(f => !f)}
        >+ Note</FilterChip>
      </div>

      {showFreeform && (
        <div style={{
          padding: '0 20px 12px', borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={freeformText}
              onChange={e => setFreeformText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitFreeform();
                if (e.key === 'Escape') setShowFreeform(false);
              }}
              placeholder="Quick note…"
              autoFocus
              style={{
                flex: 1, padding: '7px 11px', borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)', background: 'var(--surface)',
                fontSize: 12, outline: 'none', color: 'var(--text)',
              }}
            />
            <PrimaryBtn onClick={submitFreeform} accent={accent}>Post</PrimaryBtn>
          </div>
        </div>
      )}

      {/* Note list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 14, padding: '48px 24px',
            color: 'var(--text-faint)',
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: 'var(--text-faint)', opacity: 0.5,
            }}/>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
              {vaultConnected
                ? 'No notes in recent sessions.'
                : 'Backend offline — no session notes available.'}
            </div>
          </div>
        ) : (
          filtered.map(note => (
            <NoteRow
              key={`${note.dateStr}-${note.idx}`}
              note={note}
              accent={accent}
              expanded={expandedId === note.id}
              editText={editText}
              onChangeEdit={setEditText}
              onStartEdit={() => startEdit(note)}
              onSaveEdit={() => saveEdit(note)}
              onCancelEdit={() => { setExpandedId(null); setEditText(''); }}
              relTime={relTime}
            />
          ))
        )}
      </div>
    </div>
  );
}

function NoteRow({
  note, accent, expanded, editText, onChangeEdit,
  onStartEdit, onSaveEdit, onCancelEdit, relTime,
}) {
  return (
    <div style={{
      borderBottom: '1px solid var(--border)',
      padding: '10px 20px',
      background: expanded ? `color-mix(in oklch, ${accent} 6%, transparent)` : 'transparent',
      transition: 'background 120ms ease',
    }}
    onMouseEnter={e => { if (!expanded) e.currentTarget.style.background = 'var(--hover)'; }}
    onMouseLeave={e => { if (!expanded) e.currentTarget.style.background = 'transparent'; }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{
          fontSize: 9, fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--text-muted)',
          letterSpacing: '0.04em',
        }}>{relTime(note.dateStr)}</span>
        <span style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text)',
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{note.task}</span>
        <span style={{
          fontSize: 9, fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--text-faint)',
          letterSpacing: '0.04em',
        }}>{note.start} · {Math.round(note.durMin || 25)}m</span>
      </div>

      {expanded ? (
        <div>
          <textarea
            value={editText}
            onChange={e => onChangeEdit(e.target.value)}
            autoFocus
            style={{
              width: '100%', minHeight: 60,
              padding: '8px 10px', borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)', background: 'var(--surface)',
              fontSize: 11, lineHeight: 1.5, outline: 'none',
              color: 'var(--text)', resize: 'vertical', marginTop: 4,
              fontFamily: 'var(--font-body)',
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <PrimaryBtn onClick={onSaveEdit} accent={accent} small>Save</PrimaryBtn>
            <OutlinedBtn onClick={onCancelEdit} small>Cancel</OutlinedBtn>
          </div>
        </div>
      ) : (
        <div
          onClick={onStartEdit}
          style={{
            fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5,
            whiteSpace: 'pre-wrap', cursor: 'pointer',
            padding: '2px 0',
          }}
        >{note.notes || <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>(empty)</span>}</div>
      )}
    </div>
  );
}

