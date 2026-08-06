import { ConfigService } from '@nestjs/config';
import { FeishuUserTokenService } from './feishu-user-token.service';
import { FeishuClient } from './feishu.client';

describe('FeishuClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses an authorized user token for Bitable reads', async () => {
    const validAccessToken = jest.fn().mockResolvedValue('u-user-token');
    const userTokens = {
      validAccessToken
    } as unknown as FeishuUserTokenService;
    const client = new FeishuClient(
      new ConfigService({
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret'
      }),
      userTokens
    );
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            items: [{ table_id: 'tbl1', name: '直播部门排班表' }],
            has_more: false
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    await expect(client.listTables('base-token')).resolves.toEqual([
      { table_id: 'tbl1', name: '直播部门排班表' }
    ]);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(
      (init?.headers as Record<string, string>).authorization
    ).toBe('Bearer u-user-token');
    expect(validAccessToken).toHaveBeenCalledWith(false);
  });

  it('keeps bot messages on the tenant token path', async () => {
    const validAccessToken = jest.fn();
    const userTokens = {
      validAccessToken
    } as unknown as FeishuUserTokenService;
    const client = new FeishuClient(
      new ConfigService({
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret'
      }),
      userTokens
    );
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: 'success',
            tenant_access_token: 't-tenant-token',
            expire: 7200
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: 'success',
            data: { message_id: 'om_1' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    await expect(
      client.sendTextMessage('ou_1', '测试消息')
    ).resolves.toBe('om_1');

    const [, messageInit] = fetchMock.mock.calls[1]!;
    expect(
      (messageInit?.headers as Record<string, string>).authorization
    ).toBe('Bearer t-tenant-token');
    expect(validAccessToken).not.toHaveBeenCalled();
  });

  it('sends application-bot messages to a group chat by chat_id', async () => {
    const client = new FeishuClient(
      new ConfigService({
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret'
      }),
      { validAccessToken: jest.fn() } as unknown as FeishuUserTokenService
    );
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: 'success',
            tenant_access_token: 't-tenant-token',
            expire: 7200
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: 'success',
            data: { message_id: 'om_group_1' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    await expect(
      client.sendTextMessageToChat('oc_group_1', '排班通知')
    ).resolves.toBe('om_group_1');

    const [messageUrl, messageInit] = fetchMock.mock.calls[1]!;
    expect(messageUrl as string).toContain('receive_id_type=chat_id');
    expect(JSON.parse(messageInit?.body as string)).toMatchObject({
      receive_id: 'oc_group_1',
      msg_type: 'text'
    });
  });

  it('sends text through an official custom-bot webhook', async () => {
    const client = new FeishuClient(
      new ConfigService({}),
      { validAccessToken: jest.fn() } as unknown as FeishuUserTokenService
    );
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0, msg: 'success' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    await expect(
      client.sendWebhookText(
        'https://open.feishu.cn/open-apis/bot/v2/hook/test-hook',
        '预约成功'
      )
    ).resolves.toBeUndefined();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      msg_type: 'text',
      content: { text: '预约成功' }
    });
  });
});
