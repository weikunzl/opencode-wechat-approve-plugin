import { SharedMailbox } from "./shared-mailbox.js"

export interface PluginEventInput {
  eventID: string
  eventType: string
  payload: Record<string, unknown>
}

export interface RoutedPluginEvent extends PluginEventInput {
  sourceInstanceID: string
}

interface PluginEventRouterOptions {
  mailbox: SharedMailbox
  instanceID: string
}

export class PluginEventRouter {
  constructor(private readonly options: PluginEventRouterOptions) {}

  publish(input: PluginEventInput): void {
    // 次实例只发布可脱敏事件，Leader 负责最终顺序和业务处理。
    this.options.mailbox.publishEvent({
      messageID: input.eventID,
      textDigest: input.eventType,
      receivedAt: Date.now(),
      sourceInstanceID: this.options.instanceID,
      eventType: input.eventType,
      payload: input.payload,
    })
  }

  async drain(handler: (event: RoutedPluginEvent) => Promise<void>): Promise<void> {
    // 逐条处理并确认，崩溃时未确认事件会在下一轮重放。
    for (const record of this.options.mailbox.readEvents()) {
      if (!record.eventType || !record.payload) continue
      await handler({
        eventID: record.messageID,
        sourceInstanceID: record.sourceInstanceID ?? "unknown",
        eventType: record.eventType,
        payload: record.payload,
      })
      this.options.mailbox.acknowledgeEvent(record.messageID)
    }
  }
}
