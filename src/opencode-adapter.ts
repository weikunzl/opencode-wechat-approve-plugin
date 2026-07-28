import type { PendingApproval } from "./domain.js"
import type { OpenCodeClient } from "./plugin-types.js"

export interface PermissionReplyInput {
  sessionID: string
  requestID: string
  decision: "once" | "always" | "reject"
}

export interface PermissionListSource {
  list(): Promise<PendingApproval[]>
}

export class OpenCodePermissionAdapter {
  constructor(
    private readonly client: OpenCodeClient,
    private readonly source?: PermissionListSource,
  ) {}

  async list(): Promise<PendingApproval[]> {
    // 仅接受显式注入的权威快照，缺失时不能把本地索引误当真实状态。
    if (!this.source) throw new Error("OpenCode permission snapshot is unavailable")
    return this.source.list()
  }

  async reply(input: PermissionReplyInput): Promise<boolean> {
    // 通过官方注入客户端回写权限，避免插件自行拼接 HTTP 鉴权。
    const response = await this.client.postSessionIdPermissionsPermissionId({
      path: { id: input.sessionID, permissionID: input.requestID },
      body: { response: input.decision },
    })
    return response.data === true
  }
}
