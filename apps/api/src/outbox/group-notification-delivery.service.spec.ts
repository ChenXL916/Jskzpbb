import { ConfigService } from '@nestjs/config';
import { FeishuClient } from '../feishu/feishu.client';
import {
  GroupNotificationDeliveryService,
  GroupTargetNotConfiguredError
} from './group-notification-delivery.service';

describe('GroupNotificationDeliveryService', () => {
  it('prefers a custom-bot webhook when both delivery modes are configured', async () => {
    const sendWebhookText = jest.fn().mockResolvedValue(undefined);
    const sendTextMessageToChat = jest.fn();
    const feishu = {
      isConfigured: jest.fn().mockReturnValue(true),
      sendWebhookText,
      sendTextMessageToChat
    } as unknown as FeishuClient;
    const service = new GroupNotificationDeliveryService(
      new ConfigService({
        FEISHU_MAKEUP_GROUP_WEBHOOK_URL:
          'https://open.feishu.cn/open-apis/bot/v2/hook/test',
        FEISHU_MAKEUP_GROUP_CHAT_ID: 'oc_makeup'
      }),
      feishu
    );

    await service.send('MAKEUP_GROUP', '预约成功');

    expect(sendWebhookText).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bot/v2/hook/test',
      '预约成功'
    );
    expect(sendTextMessageToChat).not.toHaveBeenCalled();
    expect(service.status('MAKEUP_GROUP')).toMatchObject({
      configured: true,
      deliveryMode: 'WEBHOOK'
    });
  });

  it('keeps messages waiting when no group target is configured', async () => {
    const service = new GroupNotificationDeliveryService(
      new ConfigService({}),
      {
        isConfigured: jest.fn().mockReturnValue(false)
      } as unknown as FeishuClient
    );

    await expect(
      service.send('SCHEDULING_GROUP', '开始排班')
    ).rejects.toBeInstanceOf(GroupTargetNotConfiguredError);
    expect(service.status('SCHEDULING_GROUP')).toMatchObject({
      configured: false,
      deliveryMode: 'NONE'
    });
  });
});
