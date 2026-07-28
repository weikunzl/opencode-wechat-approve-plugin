import type { PendingApproval } from "./domain.js"
import type { OpenCodePermissionAdapter } from "./opencode-adapter.js"
import type { PermissionAPI } from "./opencode-permissions.js"
import { WeChatStore } from "./store.js"

export class SdkPermissionAPI implements PermissionAPI {
  constructor(
    private readonly store: WeChatStore,
    private readonly adapter: Pick<OpenCodePermissionAdapter, "reply">,
  ) {}

  async list(): Promise<PendingApproval[]> {
    // 原生插件从共享 pending 索引读取，审批事件负责保持索引最新。
    return this.store.loadPendingApprovals()
  }

  async reply(requestID: string, decision: "once" | "always" | "reject"): Promise<boolean> {
    // 只有索引中存在的请求才能通过注入 client 回写 OpenCode。
    const pending = this.store.loadPendingApprovals().find((item) => item.requestID === requestID)
    if (!pending) return false
    return this.adapter.reply({ sessionID: pending.sessionID, requestID, decision })
  }
}
