import type { OpenCodeClient } from "./plugin-types.js"

export interface PermissionReplyInput {
  sessionID: string
  requestID: string
  decision: "once" | "always" | "reject"
}

export class OpenCodePermissionAdapter {
  constructor(private readonly client: OpenCodeClient) {}

  async reply(input: PermissionReplyInput): Promise<boolean> {
    // 通过官方注入客户端回写权限，避免插件自行拼接 HTTP 鉴权。
    const response = await this.client.postSessionIdPermissionsPermissionId({
      path: { id: input.sessionID, permissionID: input.requestID },
      body: { response: input.decision },
    })
    return response.data === true
  }
}
