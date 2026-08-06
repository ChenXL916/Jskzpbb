import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeishuUserTokenService } from './feishu-user-token.service';

interface FeishuEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

interface FeishuWebhookResponse {
  code?: number;
  msg?: string;
  StatusCode?: number;
  StatusMessage?: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  scope?: string;
}

export interface FeishuUserInfo {
  name: string;
  avatar_url?: string;
  open_id: string;
  union_id?: string;
  user_id?: string;
  email?: string;
  enterprise_email?: string;
  mobile?: string;
  employee_no?: string;
}

export interface FeishuTable {
  table_id: string;
  name: string;
  revision?: number;
}

export interface FeishuField {
  field_id: string;
  field_name: string;
  type: number;
  ui_type?: string;
  property?: Record<string, unknown>;
  is_primary?: boolean;
}

export interface FeishuView {
  view_id: string;
  view_name: string;
  view_type: string;
}

export interface FeishuRecord {
  record_id: string;
  fields: Record<string, unknown>;
  created_time?: number;
  last_modified_time?: number;
}

interface Page<T> {
  items: T[];
  has_more?: boolean;
  page_token?: string;
  total?: number;
}

@Injectable()
export class FeishuClient {
  private readonly origin = 'https://open.feishu.cn/open-apis';
  private tenantToken: { value: string; expiresAt: number } | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly userTokens: FeishuUserTokenService
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('FEISHU_APP_ID') &&
        this.config.get<string>('FEISHU_APP_SECRET')
    );
  }

  async exchangeAuthorizationCode(code: string): Promise<OAuthTokenResponse> {
    const body = {
      grant_type: 'authorization_code',
      client_id: this.config.getOrThrow<string>('FEISHU_APP_ID'),
      client_secret: this.config.getOrThrow<string>('FEISHU_APP_SECRET'),
      code,
      redirect_uri: this.config.getOrThrow<string>('FEISHU_REDIRECT_URI')
    };
    const response = await this.fetchJson<
      OAuthTokenResponse | FeishuEnvelope<OAuthTokenResponse>
    >(`${this.origin}/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body)
    });
    if ('data' in response) {
      if (response.code !== 0) throw new BadGatewayException(response.msg);
      return response.data;
    }
    return response;
  }

  async getUserInfo(accessToken: string): Promise<FeishuUserInfo> {
    const response = await this.fetchJson<FeishuEnvelope<FeishuUserInfo>>(
      `${this.origin}/authen/v1/user_info`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json; charset=utf-8'
        }
      }
    );
    this.assertSuccess(response);
    return response.data;
  }

  async listTables(appToken: string): Promise<FeishuTable[]> {
    return this.collectPages<FeishuTable>(
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
      'GET'
    );
  }

  async listFields(appToken: string, tableId: string): Promise<FeishuField[]> {
    return this.collectPages<FeishuField>(
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
      'GET'
    );
  }

  async listViews(appToken: string, tableId: string): Promise<FeishuView[]> {
    return this.collectPages<FeishuView>(
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/views`,
      'GET'
    );
  }

  async searchRecords(
    appToken: string,
    tableId: string,
    options: {
      viewId?: string;
      pageToken?: string;
      pageSize?: number;
      automaticFields?: boolean;
    } = {}
  ): Promise<Page<FeishuRecord>> {
    const params = new URLSearchParams({
      page_size: String(options.pageSize ?? 500)
    });
    if (options.pageToken) params.set('page_token', options.pageToken);
    if (options.viewId) params.set('view_id', options.viewId);
    const response = await this.baseRequest<Page<FeishuRecord>>(
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search?${params.toString()}`,
      {
        method: 'POST',
        body: JSON.stringify({
          automatic_fields: options.automaticFields ?? true
        })
      }
    );
    return response;
  }

  async createRecord(
    appToken: string,
    tableId: string,
    fields: Record<string, unknown>,
    clientToken: string
  ): Promise<FeishuRecord> {
    const params = new URLSearchParams({
      client_token: clientToken,
      user_id_type: 'open_id'
    });
    const result = await this.baseRequest<{ record: FeishuRecord }>(
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records?${params.toString()}`,
      { method: 'POST', body: JSON.stringify({ fields }) }
    );
    return result.record;
  }

  async updateRecord(
    appToken: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>
  ): Promise<FeishuRecord> {
    const result = await this.baseRequest<{ record: FeishuRecord }>(
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}?user_id_type=open_id`,
      { method: 'PUT', body: JSON.stringify({ fields }) }
    );
    return result.record;
  }

  async sendTextMessage(openId: string, text: string): Promise<string> {
    const result = await this.tenantRequest<{ message_id: string }>(
      '/im/v1/messages?receive_id_type=open_id',
      {
        method: 'POST',
        body: JSON.stringify({
          receive_id: openId,
          msg_type: 'text',
          content: JSON.stringify({ text })
        })
      }
    );
    return result.message_id;
  }

  async sendTextMessageToChat(chatId: string, text: string): Promise<string> {
    const result = await this.tenantRequest<{ message_id: string }>(
      '/im/v1/messages?receive_id_type=chat_id',
      {
        method: 'POST',
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text })
        })
      }
    );
    return result.message_id;
  }

  async sendWebhookText(webhookUrl: string, text: string): Promise<void> {
    const url = new URL(webhookUrl);
    const supportedHost = ['open.feishu.cn', 'open.larksuite.com'].includes(
      url.hostname
    );
    const supportedPath = url.pathname.startsWith('/open-apis/bot/v2/hook/');
    if (!supportedHost || !supportedPath) {
      throw new ServiceUnavailableException('群机器人 Webhook 地址格式不正确');
    }
    const response = await this.fetchJson<FeishuWebhookResponse>(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        msg_type: 'text',
        content: { text }
      })
    });
    const code = response.code ?? response.StatusCode ?? 0;
    if (code !== 0) {
      throw new BadGatewayException(
        `飞书群机器人返回错误 ${code}: ${
          response.msg ?? response.StatusMessage ?? 'unknown error'
        }`
      );
    }
  }

  private async collectPages<T>(path: string, method: 'GET' | 'POST'): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    do {
      const separator = path.includes('?') ? '&' : '?';
      const query = `${path}${separator}page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
      const page = await this.baseRequest<Page<T>>(query, { method });
      items.push(...(page.items ?? []));
      pageToken = page.has_more ? page.page_token : undefined;
    } while (pageToken);
    return items;
  }

  private async tenantRequest<T>(
    path: string,
    init: RequestInit,
    tokenRetry = true
  ): Promise<T> {
    const token = await this.getTenantToken();
    const response = await this.fetchJson<FeishuEnvelope<T>>(
      `${this.origin}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
          ...(init.headers ?? {})
        }
      }
    );
    if (response.code === 99991663 && tokenRetry) {
      this.tenantToken = undefined;
      return this.tenantRequest(path, init, false);
    }
    this.assertSuccess(response);
    return response.data;
  }

  private async baseRequest<T>(
    path: string,
    init: RequestInit,
    tokenRetry = true
  ): Promise<T> {
    const userToken = await this.userTokens.validAccessToken(!tokenRetry);
    if (!userToken) {
      return this.tenantRequest(path, init, tokenRetry);
    }
    const response = await this.fetchJson<FeishuEnvelope<T>>(
      `${this.origin}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${userToken}`,
          'content-type': 'application/json; charset=utf-8',
          ...(init.headers ?? {})
        }
      }
    );
    if (response.code === 99991663 && tokenRetry) {
      return this.baseRequest(path, init, false);
    }
    this.assertSuccess(response);
    return response.data;
  }

  private async getTenantToken(): Promise<string> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('飞书 App ID 或 App Secret 尚未配置');
    }
    if (this.tenantToken && this.tenantToken.expiresAt > Date.now() + 5 * 60_000) {
      return this.tenantToken.value;
    }
    const response = await this.fetchJson<TenantTokenResponse>(
      `${this.origin}/auth/v3/tenant_access_token/internal/`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          app_id: this.config.getOrThrow<string>('FEISHU_APP_ID'),
          app_secret: this.config.getOrThrow<string>('FEISHU_APP_SECRET')
        })
      }
    );
    if (response.code !== 0) {
      throw new BadGatewayException(`飞书令牌获取失败：${response.msg}`);
    }
    this.tenantToken = {
      value: response.tenant_access_token,
      expiresAt: Date.now() + response.expire * 1000
    };
    return response.tenant_access_token;
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(10_000)
        });
        if (response.status === 429 || response.status >= 500) {
          if (attempt === 2) {
            throw new Error(`飞书接口返回 HTTP ${response.status}`);
          }
          const retryAfter = Number(response.headers.get('retry-after') ?? 0);
          await this.sleep(
            retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt + Math.random() * 250
          );
          continue;
        }
        if (!response.ok) {
          const text = await response.text();
          throw new BadGatewayException(
            `飞书接口返回 HTTP ${response.status}: ${text.slice(0, 300)}`
          );
        }
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (attempt < 2 && !(error instanceof BadGatewayException)) {
          await this.sleep(500 * 2 ** attempt + Math.random() * 250);
          continue;
        }
        throw error;
      }
    }
    throw new BadGatewayException(
      lastError instanceof Error ? lastError.message : '飞书请求失败'
    );
  }

  private assertSuccess<T>(response: FeishuEnvelope<T>): void {
    if (response.code !== 0) {
      throw new BadGatewayException(`飞书接口错误 ${response.code}: ${response.msg}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
