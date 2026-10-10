// Page-side constant, kept out of client.tsx so tests can read it without loading the page's modules.

/**
 * What makes the right-hand column read the open chat again: a chat that was summarized, and a chat opened
 * from somewhere else — a question annotation's "在侧边提问" opens one and then reports the annotation as changed.
 */
export const ACTIVE_CHAT_REFRESH_ON: readonly string[] = ['learning/sidechat-summarized', 'learning/annotation-changed']
