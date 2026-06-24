const SVG_PROPS = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
};
function wrap(size, children) {
  return <svg width={size} height={size} {...SVG_PROPS}>{children}</svg>;
}

// ── Sidebar / chrome icons (sized via prop; default 18) ─────────────────────
export function IconTimer({ size = 18 })      { return wrap(size, <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>); }
export function IconChart({ size = 18 })      { return wrap(size, <><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></>); }
export function IconNotes({ size = 18 })      { return wrap(size, <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>); }
export function IconTerminal({ size = 18 })   { return wrap(size, <><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></>); }
export function IconBrush({ size = 18 })      { return wrap(size, <><path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></>); }
export function IconConsole({ size = 18 })    { return wrap(size, <><rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><polyline points="7 9 11 12 7 15"/><line x1="13" y1="15" x2="17" y2="15"/></>); }
export function IconBookOpen({ size = 18 })   { return wrap(size, <><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></>); }
export function IconLibrary({ size = 18 })    { return wrap(size, <><path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/></>); }
export function IconGraph({ size = 18 })       { return wrap(size, <><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><line x1="8.1" y1="10.8" x2="15.9" y2="6.2"/><line x1="8.1" y1="13.2" x2="15.9" y2="17.8"/></>); }
export function IconActivity({ size = 18 })   { return wrap(size, <><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></>); }
export function IconStar({ size = 18 })       { return wrap(size, <><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></>); }
export function IconCalendar({ size = 18 })   { return wrap(size, <><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></>); }
export function IconLayoutGrid({ size = 18 }) { return wrap(size, <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>); }
export function IconHome({ size = 18 })       { return wrap(size, <><path d="M3 9.5l9-7 9 7V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>); }
export function IconRotateCw({ size = 18 })   { return wrap(size, <><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></>); }
export function IconLayers({ size = 18 })     { return wrap(size, <><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></>); }
export function IconHardDrive({ size = 18 })  { return wrap(size, <><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></>); }
export function IconSettings({ size = 18 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>);
}

export function IconBell({ size = 18 })       { return wrap(size, <><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></>); }
export function IconTrash({ size = 18 })      { return wrap(size, <><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></>); }
export function IconDownload({ size = 18 })   { return wrap(size, <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></>); }
export function IconSearch({ size = 18 })     { return wrap(size, <><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>); }

// ── Non-sidebar icons (fixed sizes for inline UI) ───────────────────────────
export function IconReset() {
  return (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>);
}
export function IconSkip({ size = 15 }) { return wrap(size, <><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></>); }
// Media transport (video controls) — sized via prop, Feather line style.
export function IconSkipBack({ size = 15 })    { return wrap(size, <><polygon points="19 4 9 12 19 20 19 4"/><line x1="5" y1="5" x2="5" y2="19"/></>); }
export function IconRewind({ size = 15 })      { return wrap(size, <><polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/></>); }
export function IconFastForward({ size = 15 }) { return wrap(size, <><polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/></>); }
export function IconPause({ size = 15 })       { return wrap(size, <><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>); }
export function IconMaximize({ size = 15 })    { return wrap(size, <><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></>); }
export function IconX() {
  return (<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>);
}
export function IconCheck({ size = 14 }) { return wrap(size, <polyline points="20 6 9 17 4 12" />); }
export function IconChevronLeft() {
  return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>);
}
export function IconChevronRight() {
  return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>);
}
// Vault-tree toolbar glyphs. IconSort = arrow-up-narrow-wide; the chevron pair
// drives the Collapse/Expand-all toggle (down-up = collapse inward, up-down = expand out).
export function IconSort({ size = 18 })          { return wrap(size, <><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M11 12h4"/><path d="M11 16h7"/><path d="M11 20h10"/></>); }
export function IconChevronsDownUp({ size = 18 }) { return wrap(size, <><path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/></>); }
export function IconChevronsUpDown({ size = 18 }) { return wrap(size, <><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></>); }

// ── Knowledge area icons ────────────────────────────────────────────────────
export function IconCrosshair({ size = 18 })    { return wrap(size, <><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/></>); }
export function IconFilm({ size = 18 })         { return wrap(size, <><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></>); }
export function IconHeartPulse({ size = 18 })   { return wrap(size, <><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4 .5-2h6.78"/></>); }
export function IconCpu({ size = 18 })          { return wrap(size, <><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></>); }
export function IconDumbbell({ size = 18 })     { return wrap(size, <><path d="M6.5 6.5 17.5 17.5"/><path d="m21 21-1-1"/><path d="m3 3 1 1"/><path d="m18 22 4-4"/><path d="m2 6 4-4"/><path d="m3 10 7-7"/><path d="m14 21 7-7"/></>); }
export function IconCrown({ size = 18 })        { return wrap(size, <><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/></>); }
export function IconVideo({ size = 18 })        { return wrap(size, <><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></>); }
export function IconBook({ size = 18 })         { return wrap(size, <><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></>); }
export function IconClapperboard({ size = 18 }) { return wrap(size, <><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/><path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></>); }
export function IconMusic({ size = 18 })        { return wrap(size, <><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></>); }
export function IconVolume({ size = 18 })       { return wrap(size, <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></>); }
export function IconLeaf({ size = 18 })         { return wrap(size, <><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19.2 2.96a1 1 0 0 1 1.5.5c2.5 5.5-1.4 14.34-8.7 16.54"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></>); }
export function IconQuote({ size = 18 })        { return wrap(size, <><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></>); }
export function IconDroplet({ size = 18 })      { return wrap(size, <><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></>); }
export function IconTv({ size = 18 })           { return wrap(size, <><rect x="2" y="7" width="20" height="15" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/></>); }
export function IconGamepad({ size = 18 })      { return wrap(size, <><line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="18" y1="10" x2="18.01" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/></>); }

// ── Knowledge subfolder icons ───────────────────────────────────────────────
export function IconFolder({ size = 18 })       { return wrap(size, <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></>); }
export function IconDatabase({ size = 18 })     { return wrap(size, <><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></>); }
export function IconLock({ size = 18 })         { return wrap(size, <><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>); }
export function IconMessageSquare({ size = 18 }){ return wrap(size, <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></>); }
export function IconUser({ size = 18 })         { return wrap(size, <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></>); }
export function IconUsers({ size = 18 })        { return wrap(size, <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>); }
export function IconSparkles({ size = 18 })     { return wrap(size, <><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></>); }
export function IconPackage({ size = 18 })      { return wrap(size, <><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></>); }
export function IconZap({ size = 18 })          { return wrap(size, <><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></>); }
export function IconSword({ size = 18 })        { return wrap(size, <><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/></>); }
export function IconHeart({ size = 18 })        { return wrap(size, <><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></>); }
export function IconWrench({ size = 18 })       { return wrap(size, <><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></>); }
export function IconRepeat({ size = 18 })       { return wrap(size, <><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></>); }
export function IconMap({ size = 18 })          { return wrap(size, <><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></>); }
export function IconBuilding({ size = 18 })     { return wrap(size, <><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></>); }
export function IconCalculator({ size = 18 })   { return wrap(size, <><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/></>); }
export function IconMove({ size = 18 })         { return wrap(size, <><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></>); }
export function IconBrain({ size = 18 })        { return wrap(size, <><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></>); }
export function IconMousePointer({ size = 18 }) { return wrap(size, <><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/></>); }
export function IconClock({ size = 18 })        { return wrap(size, <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>); }
export function IconPlay({ size = 18 })         { return wrap(size, <><polygon points="5 3 19 12 5 21 5 3"/></>); }
export function IconFileText({ size = 18 })     { return wrap(size, <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></>); }
export function IconGlobe({ size = 18 })        { return wrap(size, <><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></>); }
export function IconMic({ size = 18 })          { return wrap(size, <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></>); }
export function IconLink({ size = 18 })         { return wrap(size, <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></>); }
export function IconLightbulb({ size = 18 })    { return wrap(size, <><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></>); }
export function IconTag({ size = 18 })          { return wrap(size, <><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></>); }
export function IconArchive({ size = 18 })      { return wrap(size, <><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></>); }
export function IconImage({ size = 18 })        { return wrap(size, <><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></>); }
export function IconCheckCircle({ size = 18 })  { return wrap(size, <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></>); }

// ── View-mode + file icons ──────────────────────────────────────────────────
export function IconCards({ size = 18 })        { return wrap(size, <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>); }
export function IconTable({ size = 18 })        { return wrap(size, <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></>); }
export function IconFile({ size = 18 })         { return wrap(size, <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>); }
export function IconExternal({ size = 14 })     { return wrap(size, <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></>); }
export function IconGrip({ size = 14 })         { return wrap(size, <><circle cx="9"  cy="5"  r="1"/><circle cx="9"  cy="12" r="1"/><circle cx="9"  cy="19" r="1"/><circle cx="15" cy="5"  r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></>); }
export function IconWand({ size = 18 })         { return wrap(size, <><path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8L19 13"/><path d="M15 9h.01"/><path d="M17.8 6.2L19 5"/><path d="m3 21 9-9"/><path d="M12.2 6.2 11 5"/></>); }
export function IconSpeaker({ size = 18 })      { return wrap(size, <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></>); }
export function IconPlayCircle({ size = 14 })   { return wrap(size, <><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></>); }

// ── Dock chrome icons ──────────────────────────────────────────────────────
export function IconDock({ size = 18 }) {
  return wrap(size, <><rect x="2" y="14" width="20" height="6" rx="2"/><circle cx="7" cy="17" r="1.2"/><circle cx="12" cy="17" r="1.2"/><circle cx="17" cy="17" r="1.2"/></>);
}
export function IconKeyboard({ size = 18 }) {
  return wrap(size, <><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6.01" y2="10"/><line x1="10" y1="10" x2="10.01" y2="10"/><line x1="14" y1="10" x2="14.01" y2="10"/><line x1="18" y1="10" x2="18.01" y2="10"/><line x1="6" y1="14" x2="6.01" y2="14"/><line x1="18" y1="14" x2="18.01" y2="14"/><line x1="9" y1="14" x2="15" y2="14"/></>);
}
export function IconPlus({ size = 18 }) {
  return wrap(size, <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>);
}
// Combined sun/moon glyph for theme toggle. Half-moon overlapping a sun's rays.
export function IconSunMoon({ size = 18 }) {
  return wrap(size, <><path d="M12 16a4 4 0 1 1 0-8 6 6 0 0 0 0 8z"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.93 19.07 1.41-1.41"/></>);
}

// Custom four-loop quadrilateral evoking the macOS ⌘ glyph but redrawn:
// four corner loops as small circles, four straight edges connecting them.
// Stroke 1.6 (lighter than the default 2) so it sits next to the chevron
// without dominating. Distinct from a literal cmd copy per PRODUCT.md's
// "creative reinterpretation of stock components".
export function IconCommand({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.6"
         strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6"  cy="6"  r="2"/>
      <circle cx="18" cy="6"  r="2"/>
      <circle cx="6"  cy="18" r="2"/>
      <circle cx="18" cy="18" r="2"/>
      <line x1="8"  y1="6"  x2="16" y2="6"/>
      <line x1="8"  y1="18" x2="16" y2="18"/>
      <line x1="6"  y1="8"  x2="6"  y2="16"/>
      <line x1="18" y1="8"  x2="18" y2="16"/>
    </svg>
  );
}
