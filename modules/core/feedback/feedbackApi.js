// Thin typed wrapper over the Rust `feedback_*` Tauri commands. Centralizes the
// command names + normalizes the rejected `{code,message}` shape into an Error
// with a `.code` so callers can `catch (e) { e.code === 'AUTH' }`.
//
// Tauri auto-converts camelCase JS args → snake_case Rust params.

async function call(api, cmd, args) {
  try {
    return await api.invoke(cmd, args);
  } catch (e) {
    const err = new Error((e && (e.message || e.code)) || String(e));
    err.code = (e && e.code) || 'ERROR';
    throw err;
  }
}

export function makeFeedbackApi(api) {
  return {
    // auth + profile
    otpSend: (email) => call(api, 'feedback_otp_send', { email }),
    otpVerify: (email, token) => call(api, 'feedback_otp_verify', { email, token }),
    getSession: () => call(api, 'feedback_get_session', {}),
    signOut: () => call(api, 'feedback_sign_out', {}),
    profileGet: (userId) => call(api, 'feedback_profile_get', { userId }),
    profileUpsert: (handle, displayName) =>
      call(api, 'feedback_profile_upsert', { handle, displayName }),

    // posts
    postsList: (category, status, sort) =>
      call(api, 'feedback_posts_list', { category, status, sort }),
    postGet: (id) => call(api, 'feedback_post_get', { id }),
    postCreate: (category, title, body, attachLogs, logs) =>
      call(api, 'feedback_post_create', { category, title, body, attachLogs, logs }),
    postDeleteOwn: (id) => call(api, 'feedback_post_delete_own', { id }),

    // votes + comments
    voteToggle: (postId) => call(api, 'feedback_vote_toggle', { postId }),
    commentsList: (postId) => call(api, 'feedback_comments_list', { postId }),
    commentCreate: (postId, body) => call(api, 'feedback_comment_create', { postId, body }),
    commentDeleteOwn: (id) => call(api, 'feedback_comment_delete_own', { id }),
    myInteractions: () => call(api, 'feedback_my_interactions', {}),

    // follow + notifications
    followToggle: (postId) => call(api, 'feedback_follow_toggle', { postId }),
    notificationsPoll: () => call(api, 'feedback_notifications_poll', {}),
    notificationsMarkRead: (ids) => call(api, 'feedback_notifications_mark_read', { ids }),

    // dev powers
    postSetStatus: (id, status) => call(api, 'feedback_post_set_status', { id, status }),
    postPin: (id, pinned) => call(api, 'feedback_post_pin', { id, pinned }),
    postDeleteAny: (id, hide) => call(api, 'feedback_post_delete_any', { id, hide }),
    commentDeleteAny: (id) => call(api, 'feedback_comment_delete_any', { id }),
    commentOfficialReply: (postId, body) =>
      call(api, 'feedback_comment_official_reply', { postId, body }),

    // avatars
    avatarUpload: (bytes, contentType) =>
      call(api, 'feedback_avatar_upload', { bytes, contentType }),
  };
}
