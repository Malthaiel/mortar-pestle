// Secondary-sidebar nav for the Overlay hub: Browser · Capture · STT · Scrim
// (SidebarNav recipe per VeditNav). Capture = /tools/overlay (the default page);
// the others are real sub-routes so reload lands back on the right page. Browser
// + Scrim render placeholder pages until their panels land (Overlay sub-plans 4–5).

import { SidebarNav } from '@host/components/SidebarBrowser.jsx';

const BROWSER = '/tools/overlay/browser';
const CAPTURE = '/tools/overlay';
const STT = '/tools/overlay/transcription';
const SCRIM = '/tools/overlay/scrim';

export default function OverlayNav({ route, accent }) {
  const seg = (route?.rest || '').split('/')[0];
  const selected = seg === 'browser' ? BROWSER
    : seg === 'transcription' ? STT
    : seg === 'scrim' ? SCRIM
    : CAPTURE;
  return (
    <SidebarNav
      groups={[{ items: [
        { path: BROWSER, title: 'Browser' },
        { path: CAPTURE, title: 'Capture' },
        { path: STT, title: 'STT' },
        { path: SCRIM, title: 'Scrim' },
      ] }]}
      selectedPath={selected}
      accent={accent}
      onSelect={(item) => { window.location.hash = item.path; }}
    />
  );
}
