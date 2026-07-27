export const WECHAT_STATUS_EMOTICONS = {
  done: "🎉",
  error: "😞",
  approval: "👀",
  approved: "👍",
  rejected: "👎",
  timeout: "⏰",
  warning: "⚠️",
  help: "💡",
} as const

export type WeChatStatus = keyof typeof WECHAT_STATUS_EMOTICONS

export function formatStatusMessage(status: string, message: string): string {
  const emoticon = WECHAT_STATUS_EMOTICONS[status as WeChatStatus] ?? WECHAT_STATUS_EMOTICONS.warning
  return `${emoticon} ${message}`
}
