// WebGL force-directed graph renderer (PixiJS v8 + d3-force), tuned for
// Obsidian-parity (reference: obsidian.asar v1.12.7).
//
// Behavior: nodes are draggable — grabbing a node pins it (fx/fy) and reheats
// the simulation so its linked neighbors follow via the link force; releasing
// unpins it (Obsidian-parity). Empty-canvas drag pans; wheel zooms to cursor.
//
// Look: flat folder-colored discs (one accent identity softened into a hue
// family per top-level folder) with a single accent glow that blooms under the
// focused node — our signature, kept restrained. Always-on labels under each
// node fade in/out with zoom (hubs label sooner), culled off-screen.
//
// Selection / local-mode / accent are applied imperatively via refs so they
// never re-run the heavy build effect (which owns the Pixi app + simulation).

import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Sprite, Texture, Text } from 'pixi.js';
import { forceSimulation, forceManyBody, forceLink, forceCollide, forceX, forceY } from 'd3-force';
import { orderedGroups, groupColor } from '../lib/linkGraph.js';


// Flat disc with a thin anti-aliased edge (the node body). Tinted per group.
function makeDiscTexture() {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.86, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  return Texture.from(c);
}

// Resolve a CSS color (hex / rgb() / oklch() / var()-bearing) to 0xRRGGBB. A
// live style probe resolves var() + serializes to rgb() in Chromium; a canvas
// fallback normalizes anything the probe leaves non-rgb (e.g. oklch()/color()).
function cssColorToInt(cssColor, fallback = 0x6aa3ff) {
  if (!cssColor) return fallback;
  try {
    const probe = document.createElement('span');
    probe.style.color = String(cssColor);
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const v = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    const m = v && v.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(',').map(s => parseFloat(s));
      return ((p[0] & 255) << 16) | ((p[1] & 255) << 8) | (p[2] & 255);
    }
    const ctx = cssColorToInt._c || (cssColorToInt._c = document.createElement('canvas').getContext('2d'));
    ctx.fillStyle = '#000000';
    ctx.fillStyle = v || String(cssColor);
    const h = ctx.fillStyle;
    if (h[0] === '#') return parseInt(h.slice(1, 7), 16);
    return fallback;
  } catch {
    return fallback;
  }
}

// Node radius from degree (matches the layout collision radius).
function nodeRadius(d) {
  return 3 + Math.min(11, Math.sqrt(d.degree || 0) * 1.7);
}

const DOT = 2.2;   // disc diameter gain (the disc texture is solid to ~0.86r)

export default function GraphCanvas({ nodes, links, accent, selectedId, localMode, onSelect, onOpen, actionsRef }) {
  const hostRef = useRef(null);
  const redrawRef = useRef(null);    // () => void — re-applies selection/local/hover view
  const stateRef = useRef({ selectedId, localMode, onSelect, onOpen });
  stateRef.current = { selectedId, localMode, onSelect, onOpen };

  // Build effect — owns the Pixi app + d3 simulation. Re-runs only on data change.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !nodes?.length) return undefined;

    let destroyed = false;
    let app = null;
    const domCleanup = [];

    (async () => {
      app = new Application();
      await app.init({
        resizeTo: host,
        backgroundAlpha: 0,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });
      if (destroyed) { try { app.destroy(true, { children: true }); } catch {} return; }
      host.appendChild(app.canvas);
      app.canvas.style.display = 'block';
      app.stage.eventMode = 'static';

      // Colors.
      let accentInt = cssColorToInt(accent);
      const edgeInt = cssColorToInt(getComputedStyle(document.body).getPropertyValue('--text-faint'), 0x888888);
      const textInt = cssColorToInt(getComputedStyle(document.body).getPropertyValue('--text'), 0x222222);
      const groups = orderedGroups(nodes);
      const groupInt = new Map();
      for (const g of groups) groupInt.set(g, cssColorToInt(groupColor(g, groups)));

      const discTex = makeDiscTexture();

      // Scene: world (pan/zoom target) → edges, focus glow, nodes, labels.
      const world = new Container();
      app.stage.addChild(world);
      world.position.set(app.screen.width / 2, app.screen.height / 2);

      const edgeG = new Graphics();
      world.addChild(edgeG);

      const nodeLayer = new Container();
      world.addChild(nodeLayer);
      const labelLayer = new Container();
      world.addChild(labelLayer);

      // Adjacency for highlight + local mode.
      const adj = new Map();
      for (const n of nodes) adj.set(n.id, new Set());
      for (const l of links) {
        const s = typeof l.source === 'object' ? l.source.id : l.source;
        const t = typeof l.target === 'object' ? l.target.id : l.target;
        adj.get(s)?.add(t);
        adj.get(t)?.add(s);
      }

      const spriteById = new Map();
      const nodeById = new Map();
      const labelById = new Map();   // lazily created Text per node
      let hoverId = null;
      let settled = false;
      let grab = null;               // { node, downGX, downGY, moved }
      let grabbing = false;          // suppresses canvas pan while a node is grabbed

      for (const n of nodes) {
        nodeById.set(n.id, n);
        const sp = new Sprite(discTex);
        sp.anchor.set(0.5);
        sp.tint = groupInt.get(n.group ?? '') ?? accentInt;
        const r = nodeRadius(n);
        sp._r = r;
        sp.width = sp.height = r * DOT;
        sp.eventMode = 'static';
        sp.cursor = 'pointer';
        sp.on('pointerover', () => { hoverId = n.id; redraw(); });
        sp.on('pointerout', () => { if (hoverId === n.id) { hoverId = null; redraw(); } });
        sp.on('pointerdown', (e) => {
          e.stopPropagation();
          grabbing = true;
          grab = { node: n, downGX: e.global.x, downGY: e.global.y, moved: false };
        });
        sp.on('pointertap', (e) => { e.stopPropagation(); if (!grab || !grab.moved) stateRef.current.onSelect?.(n); });
        nodeLayer.addChild(sp);
        spriteById.set(n.id, sp);
      }

      function ensureLabel(n) {
        let t = labelById.get(n.id);
        if (!t) {
          t = new Text({ text: n.title, style: { fill: textInt, fontFamily: 'DM Sans, sans-serif', fontSize: 12, fontWeight: '500' } });
          t.resolution = 2;
          t.anchor.set(0.5, 0);
          labelLayer.addChild(t);
          labelById.set(n.id, t);
        }
        return t;
      }

      function visibleSet() {
        const { selectedId: sel, localMode: local } = stateRef.current;
        if (local && sel && nodeById.has(sel)) {
          const set = new Set([sel]);
          for (const nb of adj.get(sel) || []) set.add(nb);
          return set;
        }
        return null; // null → all visible
      }

      function updatePositions() {
        for (const n of nodes) {
          const sp = spriteById.get(n.id);
          if (sp) { sp.x = n.x; sp.y = n.y; }
        }
      }

      // Always-on labels that fade with zoom (hubs label sooner); off-screen +
      // near-transparent labels are culled. Hidden entirely until the sim settles.
      function layoutLabels() {
        if (!settled) { for (const t of labelById.values()) t.visible = false; return; }
        const vis = visibleSet();
        const scale = world.scale.x;
        const m = 48;
        const wx0 = (-m - world.position.x) / scale, wx1 = (app.screen.width + m - world.position.x) / scale;
        const wy0 = (-m - world.position.y) / scale, wy1 = (app.screen.height + m - world.position.y) / scale;
        for (const n of nodes) {
          const hide = () => { const ex = labelById.get(n.id); if (ex) ex.visible = false; };
          if (vis && !vis.has(n.id)) { hide(); continue; }
          if (n.x < wx0 || n.x > wx1 || n.y < wy0 || n.y > wy1) { hide(); continue; }
          const sizeBoost = 1 + Math.min(1.6, (n.degree || 0) / 18);
          const a = Math.max(0, Math.min(1, (scale * sizeBoost - 0.9) / 0.6));
          if (a < 0.04) { hide(); continue; }
          const t = ensureLabel(n);
          t.visible = true;
          t.alpha = a;
          t.position.set(n.x, n.y + (spriteById.get(n.id)?._r || 4) + 3);
        }
      }

      // Edges: dim base pass + (after settle) a bright accent pass for the edges
      // incident to the hovered/selected node.
      function drawEdges() {
        const vis = visibleSet();
        const { selectedId: sel } = stateRef.current;
        const focus = hoverId || sel;
        const focusAdj = focus ? adj.get(focus) : null;
        edgeG.clear();
        let dimCount = 0;
        for (const l of links) {
          const s = typeof l.source === 'object' ? l.source : nodeById.get(l.source);
          const t = typeof l.target === 'object' ? l.target : nodeById.get(l.target);
          if (!s || !t) continue;
          if (vis && (!vis.has(s.id) || !vis.has(t.id))) continue;
          if (settled && focus && (s.id === focus || t.id === focus)) continue; // bright below
          edgeG.moveTo(s.x, s.y).lineTo(t.x, t.y);
          dimCount++;
        }
        if (dimCount) edgeG.stroke({ width: 1, color: edgeInt, alpha: focus ? 0.05 : 0.15 });
        if (settled && focus && focusAdj) {
          let n = 0;
          for (const l of links) {
            const s = typeof l.source === 'object' ? l.source : nodeById.get(l.source);
            const t = typeof l.target === 'object' ? l.target : nodeById.get(l.target);
            if (!s || !t) continue;
            if (vis && (!vis.has(s.id) || !vis.has(t.id))) continue;
            if (s.id === focus || t.id === focus) { edgeG.moveTo(s.x, s.y).lineTo(t.x, t.y); n++; }
          }
          if (n) edgeG.stroke({ width: 1.6, color: accentInt, alpha: 0.85 });
        }
      }

      function styleNodes() {
        const vis = visibleSet();
        const { selectedId: sel } = stateRef.current;
        const focus = hoverId || sel;
        const focusAdj = focus ? adj.get(focus) : null;
        for (const [id, sp] of spriteById) {
          sp.visible = !vis || vis.has(id);
          if (!sp.visible) continue;
          const inFocus = !focus || id === focus || (focusAdj && focusAdj.has(id));
          sp.alpha = inFocus ? 1 : 0.12;
          const bump = (id === focus) ? 1.5 : (id === sel ? 1.28 : 1);
          sp.width = sp.height = sp._r * DOT * bump;
        }
      }


      function redraw() {
        styleNodes();
        drawEdges();
        layoutLabels();
      }
      redrawRef.current = redraw;

      // Fit the view to a set of nodes (or all when ids is null).
      function fit(ids) {
        const pts = nodes.filter(n => !ids || ids.has(n.id));
        if (!pts.length) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of pts) {
          if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
          if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
        }
        const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
        const pad = 90;
        const scale = Math.min(5, Math.max(0.1, Math.min((app.screen.width - pad) / w, (app.screen.height - pad) / h)));
        world.scale.set(scale);
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        world.position.set(app.screen.width / 2 - cx * scale, app.screen.height / 2 - cy * scale);
        redraw();
      }
      if (actionsRef) {
        actionsRef.current = {
          reset: () => fit(null),
          fitSelection: () => { const v = visibleSet(); fit(v); },
        };
      }

      // Force layout — Obsidian-spacious, scaled to our node sizes (d3-default
      // alphaDecay / velocityDecay for a slow, smooth settle).
      const sim = forceSimulation(nodes)
        .force('charge', forceManyBody().strength(-180).distanceMax(800))
        .force('link', forceLink(links).id(d => d.id).distance(60).strength(0.4))
        .force('collide', forceCollide().radius(d => nodeRadius(d) + 6))
        .force('x', forceX(0).strength(0.07))
        .force('y', forceY(0).strength(0.07))
        .alpha(1);
      sim.on('tick', () => { updatePositions(); drawEdges(); layoutLabels(); });
      sim.on('end', () => { settled = true; redraw(); fit(null); });

      // Pan + zoom (cursor-anchored) + node drag, via DOM events on the canvas.
      const canvas = app.canvas;
      let dragging = false, lastX = 0, lastY = 0;
      const onWheel = (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const ns = Math.min(5, Math.max(0.1, world.scale.x * factor));
        const k = ns / world.scale.x;
        world.position.x = mx - (mx - world.position.x) * k;
        world.position.y = my - (my - world.position.y) * k;
        world.scale.set(ns);
        layoutLabels();
      };
      const onDown = (e) => {
        if (grabbing) return;            // a node grab is in progress → don't pan
        dragging = true; lastX = e.clientX; lastY = e.clientY;
      };
      const onMove = (e) => {
        if (grab) {                      // dragging a node
          const rect = canvas.getBoundingClientRect();
          const gx = e.clientX - rect.left, gy = e.clientY - rect.top;
          if (!grab.moved) {
            if (Math.hypot(gx - grab.downGX, gy - grab.downGY) < 4) return; // still a click
            grab.moved = true;
            sim.alphaTarget(0.3).restart();   // reheat → neighbors follow
          }
          grab.node.fx = (gx - world.position.x) / world.scale.x;
          grab.node.fy = (gy - world.position.y) / world.scale.y;
          return;
        }
        if (!dragging) return;           // panning
        world.position.x += e.clientX - lastX;
        world.position.y += e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        layoutLabels();
      };
      const onUp = () => {
        if (grab) {
          if (grab.moved) { sim.alphaTarget(0); grab.node.fx = null; grab.node.fy = null; } // unpin
          grab = null; grabbing = false;
        }
        dragging = false;
      };
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      domCleanup.push(() => {
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('pointerdown', onDown);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      });

      // Re-tint the accent layers on accent change without rebuilding the sim.
      redrawRef.current.__retint = (cssColor) => {
        accentInt = cssColorToInt(cssColor);
        redraw();
      };
    })();

    return () => {
      destroyed = true;
      domCleanup.forEach(fn => { try { fn(); } catch {} });
      redrawRef.current = null;
      if (actionsRef) actionsRef.current = null;
      if (app) { try { app.destroy(true, { children: true }); } catch {} }
    };
  }, [nodes, links]);

  // Selection / local-mode change → re-apply view (no rebuild).
  useEffect(() => { redrawRef.current?.(); }, [selectedId, localMode]);

  // Accent change → re-tint accent layers (no rebuild).
  useEffect(() => { redrawRef.current?.__retint?.(accent); }, [accent]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />;
}
