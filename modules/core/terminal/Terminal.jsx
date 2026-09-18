// One xterm.js instance bound to one TerminalProvider tab. Lifetime: from
// mount to unmount. The PTY session lives in the provider, so unmounting
// this component does NOT kill the shell — output keeps flowing into the
// provider's ring buffer until the user explicitly closes the tab.
//
// Appearance: Zed's terminal geometry (15px / weight 500 / 1.0 line-height,
// block cursor, hollow when unfocused) in DM Mono — one of the app's two fonts.
// Colours are NOT fixed: background + foreground track the app's --bg / --text
// tokens, measured live off this component's own container, and the ANSI set
// (Gruvbox Dark or Light) follows from that measured background. See themes.js.
// Uses xterm's DOM renderer (the WebGL addon deferred the final paint on
// WebKitGTK → typed input lagged one char behind). Authored truecolor is left
// untouched (minimumContrastRatio 1).

import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTerminal } from './TerminalProvider.jsx';
import { terminalTheme, TERMINAL_FONT_FAMILY } from './themes.js';

export default function Terminal({ tabId, visible }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const subRef = useRef(null);
  const { subscribe } = useTerminal();

  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return undefined;

    const term = new XTerm({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 15,            // Zed buffer_font_size (terminal inherits it)
      fontWeight: 500,         // measured: the webview rasterizes lighter than Zed's GPUI renderer — bump one step to match
      // fontWeightBold left at xterm's default ON PURPOSE. No 700 DM Mono face
      // is bundled, so bold is SMEARED by the browser — that fake-bold look is
      // wanted (Malthaiel, 2026-08-27), not a compromise. Do not "fix" it.
      lineHeight: 1.0,         // measured: matches Zed's ~19px row pitch (xterm's 1.3 rendered ~25px, much looser than Zed's "1.3")
      cursorBlink: false,      // Zed default — terminal-controlled, off unless the program asks
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',   // Zed draws a hollow block when unfocused
      drawBoldTextInBrightColors: false, // match Zed: bold text keeps the NORMAL ANSI color — "bypass permissions on" stays muted #cc241d, not bright #fb4934
      minimumContrastRatio: 1,          // faithful: never remap a program's authored colors
      convertEol: false,
      scrollback: 5000,
      allowProposedApi: false,
      theme: terminalTheme(containerEl),
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

  // Re-measure the app's colours whenever the theme could have moved. xterm
  // accepts a new theme object without a remount, so the PTY keeps running.
  // Two signals, because a theme change can arrive either way: the <html>
  // data-theme-preset attribute, and useSettings' global settings
  // broadcast (an accent or preset commit that repaints tokens in place).
  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return undefined;
    const repaint = () => {
      const term = termRef.current;
      if (!term) return;
      try { term.options.theme = terminalTheme(containerEl); } catch {}
    };
    const mo = new MutationObserver(repaint);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme-preset'],
    });
    window.addEventListener('focus-global-settings-changed', repaint);
    return () => {
      mo.disconnect();
      window.removeEventListener('focus-global-settings-changed', repaint);
    };
  }, []);

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
