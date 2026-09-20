// FilterStack — Broadcast's shared filter-stack shell (SP6 SF4).
//
// Two panes in an AppWindow: the source's filter chain on the left (drag to
// reorder, toggle to bypass, add/remove), the selected filter's properties on
// the right. Generic on purpose — SP7 renders video filters through this same
// shell by passing kind="video"; nothing here is audio-specific.
//
// THE CHAIN IS NOT LOCAL STATE. `filters` comes straight off the engine
// snapshot, and every mutating verb ends in a push_state, so add/remove/reorder
// land here as a new prop rather than something we have to mirror.
//
// PropertiesForm is reused UNMODIFIED via its fetch/commit injection props —
// a filter is an ordinary libobs source once resolved, so the same PropSpec
// marshaling drives it. It renders its own readouts; do not add a second.
//
// OCCLUSION LAW: the native preview is a real child HWND painting over the
// whole webview, so this window can never appear above it by z-index. The
// caller tears the display down while we are open (`alive={alive && !filters}`).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, OutlinedBtn } from '@host/components/ui';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { IconLayers } from '@host/components/icons.jsx';
import EnableToggle from '@host/components/ui/EnableToggle.jsx';
import ConfirmModal from '@host/components/ui/ConfirmModal.jsx';
import DraggableSidebarList from '@host/components/DraggableSidebarList.jsx';
import PropertiesForm from './PropertiesForm.jsx';
import { verb } from './broadcastStore.js';
import { pushUndo } from './broadcastUndo.js';

export default function FilterStack({ api, source, filters = [], kind = 'audio', accent, onClose }) {
  const [types, setTypes] = useState([]);
  const [selected, setSelected] = useState(null);
  const [pendingRemove, setPendingRemove] = useState(null);
  // The settings PropertiesForm last fetched. The injected commit path bypasses
  // the form's own undo bookkeeping, so we keep the before-image ourselves
  // rather than losing undo for filter edits.
  const lastSettingsRef = useRef({});

  const names = useMemo(() => filters.map((f) => f.name), [filters]);

  // The add picker's menu. Registered types are fixed for the process life.
  useEffect(() => {
    let alive = true;
    verb(api, 'list_filter_types', { kind })
      .then((r) => { if (alive) setTypes(r?.types || []); })
      .catch((e) => console.warn('[broadcast] list_filter_types', e));
    return () => { alive = false; };
  }, [api, kind]);

  // Keep the selection pointing at something real as the chain changes under us.
  useEffect(() => {
    if (selected && names.includes(selected)) return;
    setSelected(names[0] ?? null);
  }, [names, selected]);

  const addOptions = useMemo(
    () => [
      { value: '', label: 'Add filter' },
      ...types.map((t) => ({ value: t.id, label: t.display_name })),
    ],
    [types],
  );

  // Names we have asked the engine for but not yet seen come back in `filters`.
  // The chain is snapshot-driven, so two adds of the same type inside one
  // round-trip both derive the SAME name off a stale `names` and the second is
  // rejected ("filter already exists: Limiter", observed 2026-08-28).
  const pendingRef = useRef(new Set());
  useEffect(() => {
    for (const n of pendingRef.current) if (names.includes(n)) pendingRef.current.delete(n);
  }, [names]);

  // libobs addresses a filter BY NAME, so it must be unique on this source (the
  // engine rejects a duplicate). Derive one from the display name instead of
  // prompting — OBS asks, but a dialog buys nothing when a sensible unique name
  // always exists and the row is renameable later.
  const uniqueName = useCallback((base) => {
    const taken = (n) => names.includes(n) || pendingRef.current.has(n);
    if (!taken(base)) return base;
    for (let i = 2; ; i += 1) {
      const candidate = `${base} ${i}`;
      if (!taken(candidate)) return candidate;
    }
  }, [names]);

  const add = useCallback((id) => {
    if (!id) return;
    const type = types.find((t) => t.id === id);
    const name = uniqueName(type?.display_name || id);
    pendingRef.current.add(name);
    verb(api, 'add_filter', { source, id, name })
      .then(() => setSelected(name))
      .catch((e) => {
        pendingRef.current.delete(name);
        console.warn('[broadcast] add_filter', e);
      });
  }, [api, source, types, uniqueName]);

  const remove = useCallback((name) => {
    setPendingRemove(null);
    verb(api, 'remove_filter', { source, name })
      .catch((e) => console.warn('[broadcast] remove_filter', e));
  }, [api, source]);

  const toggle = useCallback((name, on) => {
    verb(api, 'set_filter_enabled', { source, name, on })
      .catch((e) => console.warn('[broadcast] set_filter_enabled', e));
  }, [api, source]);

  // DraggableSidebarList hands back original-array indices; the engine takes an
  // absolute target index and walks libobs's one-step movement enum to reach it.
  const reorder = useCallback((from, to) => {
    const name = names[from];
    if (!name || from === to) return;
    verb(api, 'reorder_filter', { source, name, index: to })
      .catch((e) => console.warn('[broadcast] reorder_filter', e));
  }, [api, source, names]);

  const fetchProps = useCallback(
    () => verb(api, 'get_filter_properties', { source, name: selected }).then((r) => {
      lastSettingsRef.current = r?.settings || {};
      return r;
    }),
    [api, source, selected],
  );

  const commitProp = useCallback((key, val) => {
    const before = { ...lastSettingsRef.current };
    const args = { source, name: selected, settings: { [key]: val } };
    return verb(api, 'set_filter_settings', args).then((r) => {
      pushUndo({
        label: `${selected}: ${key}`,
        // Replace, not merge — a merge would leave ghost keys from the undone
        // edit behind (same contract as the source-settings undo path).
        undo: [{ op: 'set_filter_settings', args: { source, name: selected, settings: before, replace: true } }],
        redo: [{ op: 'set_filter_settings', args }],
      });
      return r;
    });
  }, [api, source, selected]);

  return (
    <>
      <AppWindow
        open
        onClose={onClose}
        title={`Filters — ${source}`}
        accent={accent}
        width={880}
      >
        <div className="bcast-filters">
          <div className="bcast-filters-pane">
            {filters.length === 0 ? (
              <div className="bcast-filters-empty">No filters on this source.</div>
            ) : (
              <DraggableSidebarList
                items={filters}
                keyExtractor={(f) => f.name}
                onReorder={reorder}
                renderItem={(f) => (
                  <div
                    className={`bcast-filter-row${f.name === selected ? ' is-sel' : ''}${f.enabled ? '' : ' is-off'}`}
                    onClick={() => setSelected(f.name)}
                  >
                    <span className="bcast-filter-name" title={f.name}>{f.name}</span>
                    <EnableToggle
                      enabled={f.enabled}
                      accent={accent}
                      onChange={(v) => toggle(f.name, v)}
                      title={f.enabled ? 'Bypass this filter' : 'Enable this filter'}
                    />
                  </div>
                )}
              />
            )}
            <div className="bcast-filters-actions">
              <CandySelect icon={IconLayers}
                value=""
                options={addOptions}
                onChange={add}
                title="Add a filter to this source"
              />
              <OutlinedBtn
                disabled={!selected}
                onClick={() => setPendingRemove(selected)}
              >
                Remove
              </OutlinedBtn>
            </div>
          </div>
          <div className="bcast-filters-props">
            {selected ? (
              <PropertiesForm
                api={api}
                accent={accent}
                // PropertiesForm keys its refetch off sceneName + node.item_id.
                // With fetch/commit injected those are pure identity, so the
                // source and filter names ARE the identity of what is edited.
                sceneName={source}
                node={{ item_id: selected, name: selected }}
                fetch={fetchProps}
                commit={commitProp}
              />
            ) : (
              <div className="bcast-filters-empty">Select a filter to edit it.</div>
            )}
          </div>
        </div>
      </AppWindow>
      <ConfirmModal
        open={!!pendingRemove}
        title="Remove filter"
        message={`Remove "${pendingRemove}" from ${source}? Its settings are not recoverable.`}
        confirmLabel="Remove"
        danger
        onConfirm={() => remove(pendingRemove)}
        onCancel={() => setPendingRemove(null)}
      />
    </>
  );
}
