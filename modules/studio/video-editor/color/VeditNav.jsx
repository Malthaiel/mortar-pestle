// Secondary-sidebar nav for the Video Editor: Edit + Color rows directly
// under the brand button (SidebarNav recipe per LibraryNav). Color is a real
// route — /tools/video-editor/color — so reload lands back in Color mode and
// EditorPage derives its mode from the `rest` param (amended decision 1,
// 2026-06-10: no header Seg toggle).

import { SidebarNav } from '@host/components/SidebarBrowser.jsx';

const EDIT = '/tools/video-editor';
const COLOR = '/tools/video-editor/color';
const MIX = '/tools/video-editor/mix';

export default function VeditNav({ route, accent }) {
  const seg = (route?.rest || '').split('/')[0];
  const selected = seg === 'color' ? COLOR : seg === 'mix' ? MIX : EDIT;
  return (
    <SidebarNav
      groups={[{ items: [
        { path: EDIT, title: 'Edit' },
        { path: COLOR, title: 'Color' },
        { path: MIX, title: 'Mix' },
      ] }]}
      selectedPath={selected}
      accent={accent}
      onSelect={(item) => { window.location.hash = item.path; }}
    />
  );
}
