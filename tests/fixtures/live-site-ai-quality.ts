import { createHash } from 'node:crypto'
import type { AiInputBundle, AiLinkInput, AiVerdict } from '../../shared/types/ai'

export interface LiveSiteQualityExpectation {
  itemId: string
  caseName: string
  expectedVerdict: AiVerdict
  requiredReasonTerms: string[]
  origin: 'copied_live_data' | 'modified_mismatch' | 'modified_insufficient'
}

type Source = AiLinkInput['source']
type Target = AiLinkInput['target']

const masking: AiLinkInput['masking'] = {
  ruleVersion: '1.0.0',
  maskedCount: 0,
  maskedCategories: [],
  notice: '自動マスキングは、すべての個人情報や秘密情報の検出を保証しません。',
}

const copied = {
  shedding: {
    source: { pageUrl: 'https://inu-jinsei.jp/dog-shedding-care/', linkText: '換毛期の抜け毛対策', beforeText: '自宅でできる犬の抜け毛ケアや換毛期の対策、室内の掃除方法について紹介します。', afterText: '換毛期はブラッシングの回数を増やす' },
    target: { normalizedUrl: 'https://inu-jinsei.jp/dog-shedding-care/', finalUrl: 'https://inu-jinsei.jp/dog-shedding-care/', title: '犬の抜け毛対策は自宅でできる？換毛期のケアと掃除のコツ | 犬と人生設計', headings: [{ level: 1 as const, text: '犬の抜け毛対策は自宅でできる？換毛期のケアと掃除のコツ' }, { level: 2 as const, text: '換毛期の抜け毛対策' }], bodyExcerpt: '犬の抜け毛が特に増えやすいのが換毛期です。換毛期には普段よりこまめにブラッシングを行うとよいでしょう。', fetchStatus: 'available' as const },
  },
  goods: {
    source: { pageUrl: 'https://inu-jinsei.jp/', linkText: '犬用品・グッズ', beforeText: '犬とお出かけ', afterText: 'イベント情報' },
    target: { normalizedUrl: 'https://inu-jinsei.jp/category/goods/', finalUrl: 'https://inu-jinsei.jp/category/goods/', title: '犬用品・グッズ | 犬と人生設計', headings: [{ level: 1 as const, text: '犬用品・グッズ' }, { level: 2 as const, text: '犬用スリッカーブラシおすすめ5選！用途別の選び方と正しい使い方' }], bodyExcerpt: '犬用品・グッズのカテゴリです。犬用ブラシや犬用レインコートの記事を掲載しています。', fetchStatus: 'available' as const },
  },
  event: {
    source: { pageUrl: 'https://inu-jinsei.jp/', linkText: 'イベント情報', beforeText: '犬用品・グッズ', afterText: '記事一覧' },
    target: { normalizedUrl: 'https://inu-jinsei.jp/event/', finalUrl: 'https://inu-jinsei.jp/event/', title: 'イベント | 犬と人生設計', headings: [{ level: 1 as const, text: 'イベント' }, { level: 2 as const, text: '2026年10月｜千葉県の犬イベント情報まとめ【ドッグイベント・マルシェ】' }], bodyExcerpt: '千葉県で開催される犬イベント、ドッグイベント、マルシェの情報を掲載しています。', fetchStatus: 'available' as const },
  },
  xShare: {
    source: { pageUrl: 'https://inu-jinsei.jp/dog-shedding-care/', linkText: 'X', beforeText: 'シェアする', afterText: 'Facebook コピー' },
    target: { normalizedUrl: 'https://x.com/intent/tweet?url=https%3A%2F%2Finu-jinsei.jp%2Fdog-shedding-care%2F', finalUrl: 'https://x.com/i/jf/onboarding/web?redirect_after_login=%2Fintent%2Ftweet', title: 'X - The Everything App / X', headings: [], bodyExcerpt: '', fetchStatus: 'available' as const },
  },
  facebookShare: {
    source: { pageUrl: 'https://inu-jinsei.jp/dog-shedding-care/', linkText: 'Facebook', beforeText: 'シェアする X', afterText: 'コピー' },
    target: { normalizedUrl: 'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Finu-jinsei.jp%2Fdog-shedding-care%2F', finalUrl: 'https://www.facebook.com/share_channel/?type=reshare&link=https%3A%2F%2Finu-jinsei.jp%2Fdog-shedding-care%2F', title: 'Facebook', headings: [], bodyExcerpt: '', fetchStatus: 'available' as const },
  },
  profile: {
    source: { pageUrl: 'https://inu-jinsei.jp/privacy-policy/', linkText: '運営者プロフィール', beforeText: 'カテゴリー', afterText: 'プライバシーポリシー・免責事項 お問い合わせ' },
    target: { normalizedUrl: 'https://inu-jinsei.jp/%e9%81%8b%e5%96%b6%e8%80%85%e3%83%97%e3%83%ad%e3%83%95%e3%82%a3%e3%83%bc%e3%83%ab/', finalUrl: 'https://inu-jinsei.jp/%e9%81%8b%e5%96%b6%e8%80%85%e3%83%97%e3%83%ad%e3%83%95%e3%82%a3%e3%83%bc%e3%83%ab/', title: '運営者プロフィール | 犬と人生設計', headings: [{ level: 1 as const, text: '運営者プロフィール' }, { level: 2 as const, text: '「犬と人生設計」を始めた理由' }], bodyExcerpt: '運営者が犬との生活を始めた経緯や、このサイトを始めた理由を紹介します。', fetchStatus: 'available' as const },
  },
  contact: {
    source: { pageUrl: 'https://inu-jinsei.jp/', linkText: 'お問い合わせ', beforeText: '運営者プロフィール プライバシーポリシー・免責事項', afterText: '© 2026 犬と人生設計.' },
    target: { normalizedUrl: 'https://inu-jinsei.jp/contact-us/', finalUrl: 'https://inu-jinsei.jp/contact-us/', title: 'お問い合わせ | 犬と人生設計', headings: [{ level: 1 as const, text: 'お問い合わせ' }], bodyExcerpt: 'お問い合わせは以下のフォームよりお願いいたします。', fetchStatus: 'available' as const },
  },
  contactAnchor: {
    source: { pageUrl: 'https://inu-jinsei.jp/privacy-policy/', linkUrl: 'https://inu-jinsei.jp/privacy-policy/#お問い合わせ', urlFragment: 'お問い合わせ', isSamePageAnchor: true, linkText: 'お問い合わせ', beforeText: 'プライバシーポリシー・免責事項の変更について', afterText: '個人情報の利用について' },
    target: { normalizedUrl: 'https://inu-jinsei.jp/privacy-policy/', finalUrl: 'https://inu-jinsei.jp/privacy-policy/', title: 'プライバシーポリシー・免責事項 | 犬と人生設計', headings: [{ level: 1 as const, text: 'プライバシーポリシー・免責事項' }, { level: 2 as const, text: 'お問い合わせ' }], bodyExcerpt: 'お問い合わせ時に取得した個人情報は、回答や必要な連絡のために利用します。', fetchStatus: 'available' as const, anchor: { fragment: 'お問い合わせ', found: true, targetId: 'お問い合わせ', heading: { level: 2 as const, text: 'お問い合わせ' }, surroundingText: 'お問い合わせ時に取得した個人情報は、回答や必要な連絡のために利用します。' } },
  },
  nextPage: {
    source: { pageUrl: 'https://inu-jinsei.jp/', linkText: '次のページ', beforeText: '記事一覧 1ページ目', afterText: '1 2 次へ' },
    target: { normalizedUrl: 'https://inu-jinsei.jp/page/2/', finalUrl: 'https://inu-jinsei.jp/page/2/', title: '犬と人生設計 | ページ 2 | 犬との暮らしを、もっと楽しく、快適に', headings: [{ level: 2 as const, text: '犬用ヒーター・暖房器具おすすめ3選｜留守番にも使いやすい商品は？' }], bodyExcerpt: '記事一覧の2ページ目です。前へ 1 2', fetchStatus: 'available' as const },
  },
  privacy: {
    source: { pageUrl: 'https://inu-jinsei.jp/', linkText: 'プライバシーポリシー・免責事項', beforeText: '運営者プロフィール', afterText: 'お問い合わせ' },
    target: { normalizedUrl: 'https://inu-jinsei.jp/privacy-policy/', finalUrl: 'https://inu-jinsei.jp/privacy-policy/', title: 'プライバシーポリシー・免責事項 | 犬と人生設計', headings: [{ level: 1 as const, text: 'プライバシーポリシー・免責事項' }, { level: 2 as const, text: '個人情報の利用について' }, { level: 2 as const, text: '掲載情報について' }], bodyExcerpt: '個人情報の取り扱い、アクセス解析、広告、掲載情報の免責について説明します。', fetchStatus: 'available' as const },
  },
} satisfies Record<string, { source: Source; target: Target }>

const definitions: Array<{ caseName: string; source: Source; target: Target; expectedVerdict: AiVerdict; requiredReasonTerms: string[]; origin: LiveSiteQualityExpectation['origin'] }> = [
  { caseName: '記事内の換毛期アンカー', ...copied.shedding, expectedVerdict: 'match', requiredReasonTerms: ['換毛期の抜け毛対策'], origin: 'copied_live_data' },
  { caseName: '犬用品カテゴリ', ...copied.goods, expectedVerdict: 'match', requiredReasonTerms: ['犬用品・グッズ'], origin: 'copied_live_data' },
  { caseName: 'イベント一覧', ...copied.event, expectedVerdict: 'match', requiredReasonTerms: ['イベント情報', 'イベント'], origin: 'copied_live_data' },
  { caseName: 'X共有', ...copied.xShare, expectedVerdict: 'match', requiredReasonTerms: ['X', 'intent'], origin: 'copied_live_data' },
  { caseName: 'Facebook共有', ...copied.facebookShare, expectedVerdict: 'match', requiredReasonTerms: ['Facebook', 'share'], origin: 'copied_live_data' },
  { caseName: '運営者プロフィール', ...copied.profile, expectedVerdict: 'match', requiredReasonTerms: ['運営者プロフィール'], origin: 'copied_live_data' },
  { caseName: '問い合わせページ', ...copied.contact, expectedVerdict: 'match', requiredReasonTerms: ['お問い合わせ'], origin: 'copied_live_data' },
  { caseName: 'プライバシー内問い合わせアンカー', ...copied.contactAnchor, expectedVerdict: 'match', requiredReasonTerms: ['お問い合わせ'], origin: 'copied_live_data' },
  { caseName: '記事一覧の次ページ', ...copied.nextPage, expectedVerdict: 'match', requiredReasonTerms: ['次のページ', 'ページ 2'], origin: 'copied_live_data' },
  { caseName: 'プライバシーポリシー', ...copied.privacy, expectedVerdict: 'match', requiredReasonTerms: ['プライバシーポリシー'], origin: 'copied_live_data' },
  { caseName: '問い合わせ文言から犬用品カテゴリ', source: copied.contact.source, target: copied.goods.target, expectedVerdict: 'possible_mismatch', requiredReasonTerms: ['お問い合わせ', '犬用品・グッズ'], origin: 'modified_mismatch' },
  { caseName: '運営者文言からイベント一覧', source: copied.profile.source, target: copied.event.target, expectedVerdict: 'possible_mismatch', requiredReasonTerms: ['運営者プロフィール', 'イベント'], origin: 'modified_mismatch' },
  { caseName: '犬用品文言からプライバシー', source: copied.goods.source, target: copied.privacy.target, expectedVerdict: 'possible_mismatch', requiredReasonTerms: ['犬用品・グッズ', 'プライバシーポリシー'], origin: 'modified_mismatch' },
  { caseName: '取得不能で情報不足', source: { pageUrl: 'https://inu-jinsei.jp/', linkText: '詳しくはこちら', beforeText: '', afterText: '' }, target: { normalizedUrl: 'https://inu-jinsei.jp/unavailable-test/', headings: [], bodyExcerpt: '', fetchStatus: 'fetch_failed', unavailableReason: '接続できませんでした。' }, expectedVerdict: 'undetermined', requiredReasonTerms: ['fetch_failed'], origin: 'modified_insufficient' },
  { caseName: '取得済みだが意味情報不足', source: { pageUrl: 'https://inu-jinsei.jp/', linkText: '記事を読む', beforeText: '', afterText: '' }, target: { normalizedUrl: 'https://inu-jinsei.jp/generic-test/', finalUrl: 'https://inu-jinsei.jp/generic-test/', title: 'ページ', headings: [], bodyExcerpt: '', fetchStatus: 'available' }, expectedVerdict: 'undetermined', requiredReasonTerms: ['情報不足'], origin: 'modified_insufficient' },
]

function makeItem(definition: typeof definitions[number], sequence: number): AiLinkInput {
  const inputHash = createHash('sha256').update(JSON.stringify({ source: definition.source, target: definition.target })).digest('hex')
  const itemId = `ai_${createHash('sha256').update(`${sequence}:${inputHash}`).digest('hex')}`
  return {
    sequence,
    itemId,
    inputHash,
    source: definition.source,
    sourceReferences: [{ linkResultKey: `live-quality-${sequence + 1}`, pageUrl: definition.source.pageUrl }],
    target: definition.target,
    masking,
  }
}

const items = definitions.map(makeItem)

export const liveSiteAiQualityInput: AiInputBundle = {
  schemaVersion: 1,
  kind: 'web-check-ai-input',
  contractVersion: '1.1.0',
  promptVersion: '1.2.0',
  bundleId: '55555555-5555-4555-8555-555555555555',
  projectId: '66666666-6666-4666-8666-666666666666',
  runId: '77777777-7777-4777-8777-777777777777',
  generatedAt: '2026-10-22T13:00:00.000Z',
  contentTreatment: 'untrusted_data',
  items,
  integrity: {
    algorithm: 'HMAC-SHA256',
    payloadHash: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    signature: '8'.repeat(64),
  },
}

export const liveSiteAiQualityExpected: LiveSiteQualityExpectation[] = definitions.map((definition, sequence) => ({
  itemId: items[sequence]!.itemId,
  caseName: definition.caseName,
  expectedVerdict: definition.expectedVerdict,
  requiredReasonTerms: definition.requiredReasonTerms,
  origin: definition.origin,
}))
