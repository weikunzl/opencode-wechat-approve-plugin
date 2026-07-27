export const WECHAT_STATUS_EMOTICONS = {
  done: "[庆祝]",
  error: "[苦涩]",
  approval: "[让我看看]",
  approved: "[好的]",
  rejected: "[NO]",
  timeout: "[叹气]",
  warning: "[汗]",
  help: "[机智]",
} as const

export type WeChatStatus = keyof typeof WECHAT_STATUS_EMOTICONS

export function formatStatusMessage(status: string, message: string): string {
  const emoticon = WECHAT_STATUS_EMOTICONS[status as WeChatStatus] ?? WECHAT_STATUS_EMOTICONS.warning
  return `${emoticon} ${message}`
}
