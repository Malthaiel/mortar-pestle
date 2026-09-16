import { useEffect, useState } from 'react';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { sharedEvents } from '@host/module-sdk/index.js';
import BoardPage from './BoardPage.jsx';
import PostDetail from './PostDetail.jsx';
import { makeFeedbackApi } from './feedbackApi.js';

// The feedback board is a POP-UP, not a route (user-directed 2026-09-15): one
// `AppWindow` over whatever page is open, launched from the titlebar chip. Board
// vs. post is local state here — there is no `/tools/feedback` URL any more.
//
// Two shared events wire it up: `feedback:open` (optional `{ postId }`) opens it,
// and it echoes `feedback:state` `{ open }` back so the titlebar chip can light.
export const OPEN_EVENT = 'feedback:open';
export const STATE_EVENT = 'feedback:state';

export default function FeedbackWindow({ api }) {
  const [fb] = useState(() => makeFeedbackApi(api));
  const [open, setOpen] = useState(false);
  const [postId, setPostId] = useState(null);

  useEffect(() => sharedEvents.on(OPEN_EVENT, (p) => {
    setPostId(p?.postId ?? null);
    setOpen(true);
  }), []);

  useEffect(() => { sharedEvents.emit(STATE_EVENT, { open }); }, [open]);

  const close = () => { setOpen(false); setPostId(null); };

  return (
    <AppWindow open={open} onClose={close} title="Feedback" width={800} height="88vh"
      bodyStyle={{ padding: 0 }}>
      {postId
        ? <PostDetail fb={fb} postId={postId} onBack={() => setPostId(null)} />
        : <BoardPage fb={fb} onOpen={setPostId} />}
    </AppWindow>
  );
}
