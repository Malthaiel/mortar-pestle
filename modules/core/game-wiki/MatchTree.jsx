// MatchTree — the Match View popup's left rail, rebuilt as a folding file-tree-style sidebar
// from the shared treeKit candy primitives (pixel-identical to the Game Wiki sidebar) in place
// of the old flat candy-row rail. A HAND-BUILT (non-hook) fixed tree: two leaf sections
// (Scoreboard, Map), a leaf Match Analysis, and three folders (Player Stats, Lanes, Graphs).
// Folder click expands AND selects its first child (the GameWikiTree toggle-and-navigate
// precedent). Player Stats + Graphs leaves show a hero portrait + the player's name (Steam
// persona when resolved via `personas`, hero name as the fallback until then). Resize lives in
// the parent (ResizeSeam); this only renders + reports selection.

import { useEffect, useState } from 'react';
import { useSettings } from '@host/hooks/useSettings.js';
import {
  AnimCtx, SuffixCtx, REVEAL, GAP,
  CandyHeader, TreeRow, TreeChildren, Collapsible, StaggerChild,
} from '@host/components/vault-tree/treeKit.jsx';
import HeroPortrait from './HeroPortrait.jsx';

// Stable order for the two player folders: Amber (team 0) then Sapphire (team 1), by slot.
const byTeamSlot = (a, b) => (a.team - b.team) || (a.slot - b.slot);
const identityLabel = (p, personas) => (personas && personas.get(p.accountId)) || p.hero;

function PlayerLeaves({ players, personas, section, sel, onSel, accent, open }) {
  const n = players.length;
  return players.map((p, i) => (
    <StaggerChild key={p.slot} index={i} count={n} open={open}>
      <TreeRow
        label={identityLabel(p, personas)}
        leadIcon={<HeroPortrait heroId={p.heroId} size={18} />}
        selected={sel.section === section && sel.slot === p.slot}
        accent={accent}
        onClick={() => onSel({ section, slot: p.slot })}
      />
    </StaggerChild>
  ));
}

function Folder({ label, open, onToggle, accent, count, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <CandyHeader label={label} open={open} onToggle={onToggle} accent={accent} />
      <Collapsible open={open} count={count}>{children}</Collapsible>
    </div>
  );
}

export default function MatchTree({ players, lanes, sel, onSel, accent, personas, onController }) {
  const { settings } = useSettings();
  const anim = REVEAL[settings.vaultTreeReveal] || REVEAL.normal;
  const ps = [...players].sort(byTeamSlot);

  // Folder open state. Default: open the folder that holds the current selection.
  const [open, setOpen] = useState(() => ({
    players: sel.section === 'players',
    lanes: sel.section === 'lanes',
    graphs: sel.section === 'graphs',
  }));
  // Toggle a folder AND select its first child (expand-and-navigate) when opening.
  const toggle = (key, firstSel) => setOpen((o) => {
    const next = !o[key];
    if (next && firstSel) onSel(firstSel);
    return { ...o, [key]: next };
  });

  // Expose a controller so a parent TreeToolbar can drive collapse/expand-all (tweak 1).
  // anyExpanded reflects the 3 folders; expand/collapse set all three together. The internal
  // toggle expand-and-navigate logic stays intact — the toolbar only flips the open map.
  useEffect(() => {
    if (!onController) return;
    onController({
      anyExpanded: Object.values(open).some(Boolean),
      expandAll: () => setOpen({ players: true, lanes: true, graphs: true }),
      collapseAll: () => setOpen({ players: false, lanes: false, graphs: false }),
    });
  }, [open, onController]);

  const leaf = (section, label) => (
    <TreeRow label={label} accent={accent}
      selected={sel.section === section}
      onClick={() => onSel({ section })} />
  );

  return (
    <AnimCtx.Provider value={anim}>
      <SuffixCtx.Provider value={false}>
        <div style={{
          display: 'flex', flexDirection: 'column', gap: GAP,
          '--candy-depth-nav': 'calc(var(--candy-depth) * 0.85)',
        }}>
          {leaf('scoreboard', 'Scoreboard')}

          <Folder label="Player Stats" accent={accent} count={ps.length}
            open={open.players}
            onToggle={() => toggle('players', ps[0] && { section: 'players', slot: ps[0].slot })}>
            <TreeChildren>
              <PlayerLeaves players={ps} personas={personas} section="players"
                sel={sel} onSel={onSel} accent={accent} open={open.players} />
            </TreeChildren>
          </Folder>

          <Folder label="Lanes" accent={accent} count={lanes.length}
            open={open.lanes}
            onToggle={() => toggle('lanes', lanes[0] != null && { section: 'lanes', lane: lanes[0] })}>
            <TreeChildren>
              {lanes.map((laneId, i) => (
                <StaggerChild key={laneId} index={i} count={lanes.length} open={open.lanes}>
                  <TreeRow label={`Lane ${laneId}`} accent={accent}
                    selected={sel.section === 'lanes' && sel.lane === laneId}
                    onClick={() => onSel({ section: 'lanes', lane: laneId })} />
                </StaggerChild>
              ))}
            </TreeChildren>
          </Folder>

          <Folder label="Graphs" accent={accent} count={ps.length}
            open={open.graphs}
            onToggle={() => toggle('graphs', ps[0] && { section: 'graphs', slot: ps[0].slot })}>
            <TreeChildren>
              <PlayerLeaves players={ps} personas={personas} section="graphs"
                sel={sel} onSel={onSel} accent={accent} open={open.graphs} />
            </TreeChildren>
          </Folder>

          {leaf('map', 'Map')}
          {leaf('analysis', 'Match Analysis')}
        </div>
      </SuffixCtx.Provider>
    </AnimCtx.Provider>
  );
}
