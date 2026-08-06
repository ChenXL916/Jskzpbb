import { feishuMention } from './feishu-mention';

describe('feishuMention', () => {
  it('formats an application-bot mention from a bound Feishu open id', () => {
    expect(feishuMention('ou_artist123', '瞿敏')).toBe(
      '<at user_id="ou_artist123">瞿敏</at>'
    );
  });

  it('falls back to a safe plain name when no usable open id is bound', () => {
    expect(feishuMention(null, '瞿敏')).toBe('瞿敏');
    expect(feishuMention('invalid', '<化妆师>')).toBe('&lt;化妆师&gt;');
  });
});
