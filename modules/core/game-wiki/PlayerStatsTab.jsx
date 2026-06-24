// PlayerStatsTab — Player Stats tab of the Match View popup (Full Match Data Extraction,
// SF-B). A 12-hero sub-tab strip (grouped Amber | Sapphire); the selected player's panel
// shows basic stats, curated Combat/Economy/Accuracy/Sustain groups, the shop-item build
// (by slot), abilities, a chronological buy/level timeline, the per-enemy focus-fire damage
// breakdown (gross), every decoded custom stat, accolades and powerups. Reads extractPlayers.

import { useState, Fragment } from 'react';
import { extractPlayers, sideName, clock } from './matchData.js';

const muted = { color: 'var(--text-muted)' };
const teamColor = (team) => (team === 0 ? 'var(--team-amber)' : 'var(--team-sapphire)');
const SLOT_COLOR = {
  weapon: 'oklch(0.72 0.14 60)',   // orange
  vitality: 'oklch(0.66 0.13 150)', // green
  spirit: 'oklch(0.62 0.16 300)',   // purple
};

const fmt = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(Number(n)).toLocaleString());
const pct = (num, den) => (den ? `${((num / den) * 100).toFixed(1)}%` : '—');
const humanizePowerup = (t) => String(t || '').replace(/_pickup/g, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

function HeroStrip({ players, sel, onSel }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 16 }}>
      {[0, 1].map((team) => (
        <div key={team} style={{
          display: 'flex', flexWrap: 'wrap', gap: 5,
          paddingRight: team === 0 ? 8 : 0, marginRight: team === 0 ? 4 : 0,
          borderRight: team === 0 ? '1px solid var(--border)' : undefined,
        }}>
          {players.filter((p) => p.team === team).map((p) => {
            const active = p.slot === sel;
            const col = teamColor(team);
            return (
              <button key={p.slot} type="button" onClick={() => onSel(p.slot)} title={`${sideName(team)} · ${p.hero}`}
                style={{
                  appearance: 'none', cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: 600,
                  padding: '5px 10px', borderRadius: 7, whiteSpace: 'nowrap',
                  border: `1px solid ${active ? col : 'var(--border)'}`,
                  background: active ? `color-mix(in oklch, ${col} 20%, transparent)` : 'transparent',
                  color: active ? 'var(--text)' : 'var(--text-muted)',
                }}>{p.hero}</button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const sectionTitle = { fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-muted)', margin: '0 0 6px' };

function StatGroup({ title, rows }) {
  const real = rows.filter((r) => r[1] != null && r[1] !== '—');
  if (!real.length) return null;
  return (
    <div style={{ minWidth: 200, flex: '1 1 220px' }}>
      <div style={sectionTitle}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 12px', fontSize: 12.5 }}>
        {real.map(([label, val], i) => (
          <Fragment key={i}>
            <div style={muted}>{label}</div>
            <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{val}</div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function ItemChip({ it }) {
  const col = SLOT_COLOR[it.slot] || 'var(--border-2)';
  const sold = it.soldT != null;
  return (
    <span title={`${it.name}${it.tier ? ` · T${it.tier}` : ''} · bought ${clock(it.t)}${sold ? ` · sold ${clock(it.soldT)}` : ''}${it.imbued ? ' · imbued' : ''}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5,
        padding: '3px 8px', borderRadius: 6, whiteSpace: 'nowrap',
        border: `1px solid color-mix(in oklch, ${col} 55%, transparent)`,
        background: `color-mix(in oklch, ${col} 14%, transparent)`,
        color: sold ? 'var(--text-muted)' : 'var(--text)',
        textDecoration: sold ? 'line-through' : 'none', opacity: sold ? 0.7 : 1,
      }}>
      {it.tier ? <b style={{ color: col, fontVariantNumeric: 'tabular-nums' }}>{it.tier}</b> : null}
      {it.name}
      {it.imbued ? <span style={{ color: col }}>✦</span> : null}
      <span style={{ ...muted, fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{clock(it.t)}</span>
    </span>
  );
}

function Bars({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.dmg));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '3px 8px', alignItems: 'center', fontSize: 12 }}>
      {rows.map((r, i) => (
        <Fragment key={i}>
          <div style={{ ...muted, whiteSpace: 'nowrap' }}>{r.hero}</div>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-3)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(r.dmg / max) * 100}%`, background: 'var(--accent)', borderRadius: 4 }} />
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{fmt(r.dmg)}</div>
        </Fragment>
      ))}
    </div>
  );
}

function Panel({ p }) {
  const s = p.stats || {};
  const shots = (s.shots_hit || 0) + (s.shots_missed || 0);
  // grouped item build
  const slots = ['weapon', 'vitality', 'spirit'];
  // chronological buy/level timeline
  const events = [
    ...p.build.map((b) => ({ t: b.t, kind: 'buy', label: b.name, col: SLOT_COLOR[b.slot] })),
    ...p.abilities.map((a) => ({ t: a.t, kind: 'ability', label: a.name })),
  ].sort((a, b) => a.t - b.t);
  // abilities grouped by name → level count
  const abilLevels = {};
  for (const a of p.abilities) abilLevels[a.name] = (abilLevels[a.name] || 0) + 1;

  return (
    <div>
      {/* identity line */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: teamColor(p.team) }}>{p.hero}</span>
        <span style={muted}>{p.side}{p.assignedLane != null ? ` · lane ${p.assignedLane}` : ''}{p.mvpRank != null ? ` · MVP ${p.mvpRank}` : ''}</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
          {p.kills}/{p.deaths}/{p.assists} · {fmt(p.netWorth)} souls · lvl {p.level} · {p.abilityPoints} AP
        </span>
      </div>

      {/* curated stat groups */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 22, marginTop: 16 }}>
        <StatGroup title="Combat" rows={[
          ['Hero damage (net)', fmt(s.player_damage)],
          ['Damage taken', fmt(s.player_damage_taken)],
          ['Damage mitigated', fmt(s.damage_mitigated)],
          ['Damage absorbed', fmt(s.damage_absorbed)],
          ['Boss damage', fmt(s.boss_damage)],
          ['Kills B/A/M', `${s.bullet_kills ?? 0}/${s.ability_kills ?? 0}/${s.melee_kills ?? 0}`],
          ['Headshot kills', fmt(s.headshot_kills)],
          ['Weapon / Tech power', `${fmt(s.weapon_power)} / ${fmt(s.tech_power)}`],
        ]} />
        <StatGroup title="Economy" rows={[
          ['Net worth', fmt(p.netWorth)],
          ['Gold · players', fmt(s.gold_player)],
          ['Gold · lane creeps', fmt(s.gold_lane_creep)],
          ['Gold · neutrals', fmt(s.gold_neutral_creep)],
          ['Gold · boss', fmt(s.gold_boss)],
          ['Gold denied', fmt(s.gold_denied)],
          ['Gold lost (deaths)', fmt(s.gold_death_loss)],
          ['Lane CS', s.possible_creeps ? `${s.creep_kills ?? 0}/${s.possible_creeps}` : fmt(s.creep_kills)],
          ['Neutrals · denies', `${fmt(s.neutral_kills)} · ${fmt(s.denies)}`],
        ]} />
        <StatGroup title="Accuracy" rows={[
          ['Shot accuracy', pct(s.shots_hit, shots)],
          ['Shots hit / missed', `${fmt(s.shots_hit)} / ${fmt(s.shots_missed)}`],
          ['Crit rate', pct(s.hero_bullets_hit_crit, s.hero_bullets_hit)],
          ['Hero bullets hit', fmt(s.hero_bullets_hit)],
        ]} />
        <StatGroup title="Sustain" rows={[
          ['Healing (total)', fmt(s.player_healing)],
          ['Self / teammate heal', `${fmt(s.self_healing)} / ${fmt(s.teammate_healing)}`],
          ['Barrier self / team', `${fmt(s.player_barriering)} / ${fmt(s.teammate_barriering)}`],
          ['Max health', fmt(s.max_health)],
          ['Heal prevented / lost', `${fmt(s.heal_prevented)} / ${fmt(s.heal_lost)}`],
        ]} />
      </div>

      {/* item build by slot */}
      <div style={{ marginTop: 20 }}>
        <div style={sectionTitle}>Items</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
          {slots.map((slot) => {
            const items = p.build.filter((b) => b.slot === slot);
            if (!items.length) return null;
            return (
              <div key={slot} style={{ flex: '1 1 240px', minWidth: 220 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'capitalize', color: SLOT_COLOR[slot], marginBottom: 5 }}>{slot}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {items.map((it, i) => <ItemChip key={i} it={it} />)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* focus-fire damage */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 26, marginTop: 20 }}>
        <div style={{ flex: '1 1 280px', minWidth: 260 }}>
          <div style={sectionTitle}>Damage dealt to enemies <span style={{ ...muted, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· gross, all sources</span></div>
          <Bars rows={p.dmgDealt} />
        </div>
        <div style={{ flex: '1 1 280px', minWidth: 260 }}>
          <div style={sectionTitle}>Damage taken from enemies <span style={{ ...muted, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· gross</span></div>
          <Bars rows={p.dmgTaken} />
        </div>
      </div>

      {/* abilities + timeline */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 26, marginTop: 20 }}>
        <div style={{ flex: '1 1 240px', minWidth: 220 }}>
          <div style={sectionTitle}>Abilities</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {Object.entries(abilLevels).map(([name, lv], i) => (
              <span key={i} style={{ fontSize: 11.5, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border)', color: 'var(--text)' }}>
                {name}{lv > 1 ? <b style={{ ...muted }}> ×{lv}</b> : null}
              </span>
            ))}
            {!p.abilities.length && <span style={muted}>—</span>}
          </div>
        </div>
        <div style={{ flex: '1 1 320px', minWidth: 280 }}>
          <div style={sectionTitle}>Timeline</div>
          <div style={{ maxHeight: 220, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'auto auto 1fr', gap: '2px 8px', fontSize: 12 }}>
            {events.map((e, i) => (
              <Fragment key={i}>
                <span style={{ ...muted, fontFamily: 'var(--font-mono)' }}>{clock(e.t)}</span>
                <span style={{ color: e.kind === 'buy' ? (e.col || 'var(--text)') : 'var(--text-muted)' }}>{e.kind === 'buy' ? 'buy' : 'lvl'}</span>
                <span style={{ color: 'var(--text)' }}>{e.label}</span>
              </Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* all decoded custom stats */}
      {p.customGroups.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={sectionTitle}>Advanced (custom stats)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 22 }}>
            {p.customGroups.map((g, i) => (
              <div key={i} style={{ flex: '1 1 220px', minWidth: 200 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>{g.group}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', fontSize: 12 }}>
                  {g.items.map((it, j) => (
                    <Fragment key={j}>
                      <div style={muted}>{it.metric}</div>
                      <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{fmt(it.value)}</div>
                    </Fragment>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* accolades + powerups */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 26, marginTop: 20 }}>
        {p.powerups.length > 0 && (
          <div style={{ flex: '1 1 240px', minWidth: 220 }}>
            <div style={sectionTitle}>Power-ups</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {p.powerups.map((b, i) => (
                <span key={i} title={b.type} style={{ fontSize: 11.5, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border)', color: 'var(--text)' }}>
                  {humanizePowerup(b.type)}{b.value ? ` ·${b.value}` : ''}{b.permanent ? ' ✓' : ''}
                </span>
              ))}
            </div>
          </div>
        )}
        {p.accolades.length > 0 && (
          <div style={{ flex: '1 1 240px', minWidth: 220 }}>
            <div style={sectionTitle}>Accolades <span style={{ ...muted, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· names not in payload</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', fontSize: 12 }}>
              {p.accolades.map((a, i) => (
                <Fragment key={i}>
                  <div style={muted}>#{a.id}{a.tier ? ` (t${a.tier})` : ''}</div>
                  <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{fmt(a.value)}</div>
                </Fragment>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function PlayerStatsTab({ raw }) {
  const players = extractPlayers(raw);
  const [sel, setSel] = useState(players[0] ? players[0].slot : null);
  const p = players.find((x) => x.slot === sel) || players[0];
  if (!p) return <div style={{ ...muted, fontSize: 13 }}>No players in this match.</div>;
  return (
    <div>
      <HeroStrip players={players} sel={p.slot} onSel={setSel} />
      <Panel p={p} />
    </div>
  );
}
