import { useMemo } from 'react';
import SidebarPill from '@host/components/SidebarPill.jsx';
import BoardPage from './BoardPage.jsx';
import PostDetail from './PostDetail.jsx';
import AccountSettingsTab from './AccountSettingsTab.jsx';
import { makeFeedbackApi } from './feedbackApi.js';
import './feedback.css';

// Public, Canny-style feedback board. The React chrome runs in the privileged
// `main` webview; all Supabase traffic routes through the Rust `feedback_*`
// commands (the webview never calls the internet directly). One route renders
// the board (/tools/feedback) or a single post (/tools/feedback/post/<id>).
// See Citadel Knowledge/Iskariel/Plans/Feedback Board.md.
function FeedbackRoot({ api, accent, rest }) {
  const fb = useMemo(() => makeFeedbackApi(api), [api]);
  if (rest.startsWith('post/')) {
    return <PostDetail api={api} fb={fb} accent={accent} postId={rest.slice('post/'.length)} />;
  }
  return <BoardPage api={api} fb={fb} accent={accent} />;
}

export default {
  register(api) {
    const { IconMessageSquare } = api.ui.icons;
    api.slots.registerLeftSidebar({
      id: 'feedback',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconMessageSquare}
          label="Feedback"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/tools/feedback')}
        />
      ),
      isActive: (route) => route.page === 'tools' && route.sub === 'feedback',
      order: 45,
    });
    api.slots.registerRoute({
      match: (r) =>
        r === '/tools/feedback' || r.startsWith('/tools/feedback/')
          ? { rest: r.slice('/tools/feedback'.length).replace(/^\//, '') }
          : false,
      render: ({ params, accent }) => (
        <FeedbackRoot api={api} accent={accent} rest={params.rest || ''} />
      ),
    });
    api.slots.registerSettingsTab({
      id: 'feedback-account',
      label: 'Feedback',
      render: (props) => <AccountSettingsTab api={api} {...props} />,
    });
  },
};
