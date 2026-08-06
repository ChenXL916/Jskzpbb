const feishuOpenIdPattern = /^ou_[A-Za-z0-9_-]+$/;

function escapeFeishuText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function feishuMention(
  openId: string | null | undefined,
  displayName: string
): string {
  const safeName = escapeFeishuText(displayName.trim() || '化妆师');
  if (!openId || !feishuOpenIdPattern.test(openId)) return safeName;
  return `<at user_id="${openId}">${safeName}</at>`;
}
