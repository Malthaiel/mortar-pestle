import AccountSettingsTab from './AccountSettingsTab.jsx';
import FeedbackWindow from './FeedbackWindow.jsx';
import './feedback.css';

// Public, Canny-style feedback board. The React chrome runs in the privileged
// `main` webview; all Supabase traffic routes through the Rust `feedback_*`
// commands (the webview never calls the internet directly). It is a POP-UP
// window (FeedbackWindow.jsx), not a page: no route and no sidebar slot — the
// titlebar chip emits `feedback:open` and the overlay does the rest.
// See Citadel Knowledge/Mortar & Pestle/Plans/Feedback Board.md.
export default {
  register(api) {
    api.slots.registerOverlay(() => <FeedbackWindow api={api} />);
    api.slots.registerSettingsTab({
      id: 'feedback-account',
      label: 'Feedback',
      render: (props) => <AccountSettingsTab api={api} {...props} />,
    });
  },
};
