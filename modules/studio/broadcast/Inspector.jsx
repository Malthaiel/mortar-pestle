// SP3 inspector — the in-layout right pane (locked: flex sibling of the
// preview area; NO overlay may cover the native region). Header (glyph +
// name + close) + Properties section (bespoke panel switch, else the generic
// PropertiesForm) + Transform section (numeric commits). Tracks the shared
// selection while open.

import React from 'react';
import { IconBtn, SectionHeader } from '@host/components/ui';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { IconMove, IconMaximize, IconX } from '@host/components/icons.jsx';
import PropertiesForm, { NumField } from './PropertiesForm.jsx';
import BespokePanel, { hasBespokePanel } from './BespokePanels.jsx';
import { glyphFor } from './sourceGlyphs.jsx';
import { updateBroadcastUi, verb } from './broadcastStore.js';
import { pushUndo } from './broadcastUndo.js';
import { allItems } from './sceneOps.js';

const ALIGN_OPTIONS = [
  { value: 5, label: 'Top left' },
  { value: 4, label: 'Top center' },
  { value: 6, label: 'Top right' },
  { value: 1, label: 'Center left' },
  { value: 0, label: 'Center' },
  { value: 2, label: 'Center right' },
  { value: 9, label: 'Bottom left' },
  { value: 8, label: 'Bottom center' },
  { value: 10, label: 'Bottom right' },
];

const BOUNDS_OPTIONS = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Stretch' },
  { value: 2, label: 'Scale inner' },
  { value: 3, label: 'Scale outer' },
  { value: 4, label: 'Scale to width' },
  { value: 5, label: 'Scale to height' },
  { value: 6, label: 'Max size only' },
];

const GRID2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'center' };
const CELL = { display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between', minWidth: 0 };
const SMALL = { fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-faint)' };

function TransformSection({ api, sceneName, node, accent }) {
  const t = node.transform;
  const c = node.crop;

  const commit = (transform, crop, label) => {
    const beforeT = { ...t };
    const beforeC = { ...c };
    verb(api, 'transform_commit', { scene: sceneName, item: node.item_id, transform, crop })
      .then(() =>
        pushUndo({
          label: label || `Transform ${node.name}`,
          undo: [{ op: 'transform_commit', args: { scene: sceneName, item: node.item_id, transform: beforeT, crop: beforeC } }],
          redo: [{ op: 'transform_commit', args: { scene: sceneName, item: node.item_id, transform: transform || {}, crop: crop || {} } }],
        }))
      .catch((e) => console.warn('[broadcast] transform_commit', e));
  };

  const tf = (key) => (v) => commit({ [key]: v }, null);
  const cf = (key) => (v) => commit(null, { [key]: v });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader title="Transform" />
      <div style={GRID2}>
        <div style={CELL}><span style={SMALL}>Pos X</span><NumField value={Math.round(t.pos_x)} onCommit={tf('pos_x')} /></div>
        <div style={CELL}><span style={SMALL}>Pos Y</span><NumField value={Math.round(t.pos_y)} onCommit={tf('pos_y')} /></div>
        <div style={CELL}><span style={SMALL}>Rot °</span><NumField value={Math.round(t.rot * 10) / 10} float min={-360} max={360} onCommit={tf('rot')} /></div>
        <div style={CELL}><span style={SMALL}>Scale %</span><NumField value={Math.round(t.scale_x * 100)} min={1} max={2000} onCommit={(v) => commit({ scale_x: v / 100, scale_y: v / 100 }, null)} /></div>
        <div style={CELL}><span style={SMALL}>Scale X%</span><NumField value={Math.round(t.scale_x * 100)} min={1} max={2000} onCommit={(v) => tf('scale_x')(v / 100)} /></div>
        <div style={CELL}><span style={SMALL}>Scale Y%</span><NumField value={Math.round(t.scale_y * 100)} min={1} max={2000} onCommit={(v) => tf('scale_y')(v / 100)} /></div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={SMALL}>Alignment</span>
        <CandySelect icon={IconMove} value={t.alignment} options={ALIGN_OPTIONS} onChange={(v) => tf('alignment')(v)} compact />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={SMALL}>Bounds</span>
        <CandySelect icon={IconMaximize} value={t.bounds_type} options={BOUNDS_OPTIONS} onChange={(v) => tf('bounds_type')(v)} compact />
        {t.bounds_type !== 0 && (
          <div style={GRID2}>
            <div style={CELL}><span style={SMALL}>W</span><NumField value={Math.round(t.bounds_x)} min={1} onCommit={tf('bounds_x')} /></div>
            <div style={CELL}><span style={SMALL}>H</span><NumField value={Math.round(t.bounds_y)} min={1} onCommit={tf('bounds_y')} /></div>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={SMALL}>Crop</span>
        <div style={GRID2}>
          <div style={CELL}><span style={SMALL}>L</span><NumField value={c.left} min={0} onCommit={cf('left')} /></div>
          <div style={CELL}><span style={SMALL}>T</span><NumField value={c.top} min={0} onCommit={cf('top')} /></div>
          <div style={CELL}><span style={SMALL}>R</span><NumField value={c.right} min={0} onCommit={cf('right')} /></div>
          <div style={CELL}><span style={SMALL}>B</span><NumField value={c.bottom} min={0} onCommit={cf('bottom')} /></div>
        </div>
      </div>
    </div>
  );
}

export default function Inspector({ api, snapshot, selection, accent }) {
  const scene = (snapshot?.scenes || []).find((s) => s.name === selection?.scene);
  const node = scene ? allItems(scene).find((i) => i.item_id === selection.itemId) : null;

  return (
    <div className="bcast-inspector">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {node && glyphFor(node.id, 14)}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, fontSize: 13 }}>
          {node ? node.name : 'Inspector'}
        </span>
        <IconBtn title="Close" accent={accent} onClick={() => updateBroadcastUi({ inspectorOpen: false })}><IconX size="0.65em"/></IconBtn>
      </div>
      {!node ? (
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', paddingTop: 8 }}>
          Select a source to edit its properties.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto', minHeight: 0, paddingRight: 2 }}>
          {node.is_group || node.is_scene ? (
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
              {node.is_group ? 'Groups have no properties — transform below applies to the group.' : 'Nested scene — edit its sources under its own scene folder.'}
            </div>
          ) : hasBespokePanel(node.id) ? (
            <BespokePanel api={api} sceneName={scene.name} node={node} accent={accent} />
          ) : (
            <PropertiesForm api={api} sceneName={scene.name} node={node} accent={accent} />
          )}
          <TransformSection api={api} sceneName={scene.name} node={node} accent={accent} />
        </div>
      )}
    </div>
  );
}
