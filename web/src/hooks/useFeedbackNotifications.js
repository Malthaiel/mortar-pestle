import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';

// Bridges the Rust feedback notification poll onto the app-wide bell/toast. The
// Rust task (commands/feedback.rs spawn_poll) emits `feedback:notify` once per new
// inbox item ({ kind, post:{id,title}, actor:{handle,display_name} }); we re-dispatch
// it as the standard `agentic:notify` CustomEvent the NotificationProvider listens
// for. Mount once in App (beside useEventReminders).
const TITLE = {
  status_change: 'Roadmap status updated',
  new_comment: 'New comment',
  official_reply: 'Official reply',
};

export function useFeedbackNotifications() {
  useEffect(() => {
    const p = listen('feedback:notify', ({ payload }) => {
      if (!payload) return;
      const post = payload.post?.title || 'a post';
      const who = payload.actor?.handle ? `@${payload.actor.handle}` : '';
      const message =
        payload.kind === 'new_comment' && who ? `${who} · ${post}` : post;
      window.dispatchEvent(
        new CustomEvent('agentic:notify', {
          detail: {
            type: 'feedback',
            title: TITLE[payload.kind] || 'Feedback',
            message,
            iconKey: 'bell',
            duration: 9000,
          },
        }),
      );
    });
    return () => { p.then((un) => un && un()); };
  }, []);
}
