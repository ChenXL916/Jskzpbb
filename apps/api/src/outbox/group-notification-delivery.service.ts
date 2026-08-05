import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeishuClient } from '../feishu/feishu.client';

export type GroupTargetKey =
  | 'SCHEDULING_GROUP'
  | 'ANCHOR_GROUP'
  | 'MAKEUP_GROUP';

export interface GroupTargetStatus {
  key: GroupTargetKey;
  label: string;
  configured: boolean;
  deliveryMode: 'WEBHOOK' | 'CHAT_ID' | 'NONE';
}

export class GroupTargetNotConfiguredError extends Error {
  constructor(readonly targetKey: GroupTargetKey) {
    super(`群通知目标 ${targetKey} 尚未配置机器人 Webhook 或 chat_id`);
  }
}

const targetConfig: Record<
  GroupTargetKey,
  {
    label: string;
    chatIdKey: string;
    webhookKey: string;
  }
> = {
  SCHEDULING_GROUP: {
    label: '排班负责人群',
    chatIdKey: 'FEISHU_SCHEDULING_GROUP_CHAT_ID',
    webhookKey: 'FEISHU_SCHEDULING_GROUP_WEBHOOK_URL'
  },
  ANCHOR_GROUP: {
    label: '主播群',
    chatIdKey: 'FEISHU_ANCHOR_GROUP_CHAT_ID',
    webhookKey: 'FEISHU_ANCHOR_GROUP_WEBHOOK_URL'
  },
  MAKEUP_GROUP: {
    label: '化妆师群',
    chatIdKey: 'FEISHU_MAKEUP_GROUP_CHAT_ID',
    webhookKey: 'FEISHU_MAKEUP_GROUP_WEBHOOK_URL'
  }
};

@Injectable()
export class GroupNotificationDeliveryService {
  constructor(
    private readonly config: ConfigService,
    private readonly feishu: FeishuClient
  ) {}

  status(key: string): GroupTargetStatus {
    const normalized = this.assertTargetKey(key);
    const definition = targetConfig[normalized];
    const webhookUrl = this.config.get<string>(definition.webhookKey) ?? '';
    const chatId = this.config.get<string>(definition.chatIdKey) ?? '';
    const chatConfigured = Boolean(chatId && this.feishu.isConfigured());
    return {
      key: normalized,
      label: definition.label,
      configured: Boolean(webhookUrl || chatConfigured),
      deliveryMode: webhookUrl
        ? 'WEBHOOK'
        : chatConfigured
          ? 'CHAT_ID'
          : 'NONE'
    };
  }

  statuses(): GroupTargetStatus[] {
    return (Object.keys(targetConfig) as GroupTargetKey[]).map((key) =>
      this.status(key)
    );
  }

  async send(key: string, text: string): Promise<void> {
    const normalized = this.assertTargetKey(key);
    const definition = targetConfig[normalized];
    const webhookUrl = this.config.get<string>(definition.webhookKey) ?? '';
    const chatId = this.config.get<string>(definition.chatIdKey) ?? '';
    if (webhookUrl) {
      await this.feishu.sendWebhookText(webhookUrl, text);
      return;
    }
    if (chatId) {
      if (!this.feishu.isConfigured()) {
        throw new GroupTargetNotConfiguredError(normalized);
      }
      await this.feishu.sendTextMessageToChat(chatId, text);
      return;
    }
    throw new GroupTargetNotConfiguredError(normalized);
  }

  private assertTargetKey(value: string): GroupTargetKey {
    if (!(value in targetConfig)) {
      throw new Error(`未知群通知目标：${value}`);
    }
    return value as GroupTargetKey;
  }
}
