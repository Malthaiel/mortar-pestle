// One xterm.js instance bound to one TerminalProvider tab. Lifetime: from
// mount to unmount. The PTY session lives in the provider, so unmounting
// this component does NOT kill the shell — output keeps flowing into the
// provider's ring buffer until the user explicitly closes the tab.
//
// Appearance is a single fixed look: Zed's terminal — Gruvbox Dark palette
// (themes.js, with a user-chosen darker #151411 bg + softened red), Lilex Nerd
// Font Mono at 15px / weight 500 / 1.0 line-height, block cursor (hollow when
// unfocused). Uses xterm's DOM renderer (the WebGL addon deferred the final
// paint on WebKitGTK → typed input lagged one char behind). Authored truecolor
// is left untouched (minimumContrastRatio 1).

import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useModuleSettings } from '@host/hooks/useSettings.js';
import { useTerminal } from './TerminalProvider.jsx';
import { GRUVBOX_THEME, fontFamilyFor, DEFAULT_TERMINAL_FONT } from './themes.js';

export default function Terminal({ tabId, visible }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const subRef = useRef(null);
  const { subscribe } = useTerminal();
  const { settings } = useModuleSettings('terminal');
  const font = settings.font ?? DEFAULT_TERMINAL_FONT;
  const fontRef = useRef(font);
  fontRef.current = font;

  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return undefined;

    const term = new XTerm({
      fontFamily: fontFamilyFor(fontRef.current),
      fontSize: 15,            // Zed buffer_font_size (terminal inherits it)
      fontWeight: 500,         // measured: WebKitGTK rasterizes Lilex lighter than Zed's GPUI renderer — bump one step to match
      lineHeight: 1.0,         // measured: matches Zed's ~19px row pitch (xterm's 1.3 rendered ~25px, much looser than Zed's "1.3")
      cursorBlink: false,      // Zed default — terminal-controlled, off unless the program asks
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',   // Zed draws a hollow block when unfocused
      drawBoldTextInBrightColors: false, // match Zed: bold text keeps the NORMAL ANSI color — "bypass permissions on" stays muted #cc241d, not bright #fb4934
      minimumContrastRatio: 1,          // faithful: never remap a program's authored colors
      convertEol: false,
      scrollback: 5000,
      allowProposedApi: false,
      theme: GRUVBOX_THEME,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerEl);

    // DOM renderer (xterm default) — deliberately NOT @xterm/addon-webgl: on the
    // Tauri WebKitGTK webview the WebGL renderer deferred its final paint until
    // the next event, so typed input rendered one character behind. The DOM
    // renderer repaints synchronously and draws Lilex + box-drawing cleanly.

    termRef.current = term;
    fitRef.current = fit;

    // Initial fit AFTER xterm has painted at least once — fit reads computed
    // metrics, and a 0-tick delay sidesteps the case where the container has
    // no layout yet.
    const fitNow = () => {
      try {
        fit.fit();
        const { cols, rows } = term;
        subRef.current?.resize(cols, rows);
      } catch {}
    };
    requestAnimationFrame(fitNow);

    const ro = new ResizeObserver(() => fitNow());
    ro.observe(containerEl);

    // Subscribe to provider's tab. Replays ring synchronously, then registers
    // for live updates.
    const sub = subscribe(tabId, (chunk) => {
      try { term.write(chunk); } catch {}
    });
    subRef.current = sub;

    const disposeInput = term.onData((data) => sub.send(data));

    return () => {
      try { ro.disconnect(); } catch {}
      try { disposeInput.dispose(); } catch {}
      try { sub.unsubscribe(); } catch {}
      try { term.dispose(); } catch {}
      termRef.current = null;
      fitRef.current = null;
      subRef.current = null;
    };
  }, [tabId, subscribe]);

  // Live font swap when the setting changes. xterm 6 accepts a new fontFamily
  // without a remount, so the PTY session keeps running.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;
    term.options.fontFamily = fontFamilyFor(font);
    requestAnimationFrame(() => {
      try {
        fit?.fit();
        subRef.current?.resize(term.cols, term.rows);
      } catch {}
    });
  }, [font]);

  // When a hidden tab becomes visible, xterm hasn't been measuring layout, so
  // refit + resend dimensions to the PTY.
  useEffect(() => {
    if (!visible) return;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    requestAnimationFrame(() => {
      try {
        fit.fit();
        subRef.current?.resize(term.cols, term.rows);
        term.focus();
      } catch {}
    });
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className="term-surface"
      data-skin="zed"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    />
  );
}
