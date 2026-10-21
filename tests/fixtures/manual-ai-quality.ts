import type { AiInputBundle, AiLinkInput, AiOutputBundle, AiVerdict } from '../../shared/types/ai'

interface QualityExpectation {
  itemId: string
  caseName: string
  expectedVerdict: AiVerdict
  requiredReasonTerms: string[]
}

const ids = ['a', 'b', 'c', 'd', 'e', 'f', '1', '2']
const hashes = ['3', '4', '5', '6', '7', '8', '9', '0']

function item(
  sequence: number,
  source: AiLinkInput['source'],
  target: AiLinkInput['target'],
): AiLinkInput {
  return {
    sequence,
    itemId: `ai_${ids[sequence]!.repeat(64)}`,
    inputHash: hashes[sequence]!.repeat(64),
    source,
    sourceReferences: [{ linkResultKey: `quality-link-${sequence + 1}`, pageUrl: source.pageUrl }],
    target,
    masking: {
      ruleVersion: '1.0.0',
      maskedCount: 0,
      maskedCategories: [],
      notice: '自動マスキングは、すべての個人情報や秘密情報の検出を保証しません。',
    },
  }
}

export const manualAiQualityInput: AiInputBundle = {
  schemaVersion: 1,
  kind: 'web-check-ai-input',
  contractVersion: '1.0.0',
  promptVersion: '1.1.0',
  bundleId: '33333333-3333-4333-8333-333333333333',
  projectId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  generatedAt: '2026-10-21T12:00:00.000Z',
  contentTreatment: 'untrusted_data',
  items: [
    item(0, {
      pageUrl: 'https://example.test/service',
      linkText: '料金プランを見る',
      beforeText: 'サービスの利用料金を比較できます。',
      afterText: '月額プランと年額プランがあります。',
    }, {
      normalizedUrl: 'https://example.test/pricing',
      finalUrl: 'https://example.test/pricing',
      title: '料金プラン',
      headings: [{ level: 1, text: '料金プラン' }, { level: 2, text: '月額・年額プラン' }],
      bodyExcerpt: 'サービスの月額料金と年額料金、各プランの機能を案内します。',
      fetchStatus: 'available',
    }),
    item(1, {
      pageUrl: 'https://example.test/company',
      linkText: '採用情報',
      beforeText: '一緒に働く仲間を募集しています。',
      afterText: '募集職種と応募条件をご覧ください。',
    }, {
      normalizedUrl: 'https://example.test/contact',
      finalUrl: 'https://example.test/contact',
      title: 'お問い合わせ',
      headings: [{ level: 1, text: 'お問い合わせフォーム' }],
      bodyExcerpt: '製品や契約に関するお問い合わせを受け付けています。',
      fetchStatus: 'available',
    }),
    item(2, {
      pageUrl: 'https://example.test/article',
      linkText: '詳しくはこちら',
      beforeText: '',
      afterText: '',
    }, {
      normalizedUrl: 'https://unavailable.example.test/detail',
      headings: [],
      bodyExcerpt: '',
      fetchStatus: 'fetch_failed',
      unavailableReason: '接続できませんでした。',
    }),
    item(3, {
      pageUrl: 'https://example.test/article',
      linkText: 'Xで共有',
      beforeText: 'この記事をSNSで共有する',
      afterText: '',
    }, {
      normalizedUrl: 'https://x.com/intent/post?url=https%3A%2F%2Fexample.test%2Farticle',
      finalUrl: 'https://x.com/intent/post?url=https%3A%2F%2Fexample.test%2Farticle',
      title: 'X',
      headings: [],
      bodyExcerpt: '',
      fetchStatus: 'available',
    }),
    item(4, {
      pageUrl: 'https://example.test/article',
      linkText: 'ホーム',
      beforeText: 'サイト内ナビゲーション',
      afterText: '',
    }, {
      normalizedUrl: 'https://example.test/',
      finalUrl: 'https://example.test/',
      title: '犬との暮らしガイド',
      headings: [{ level: 1, text: '犬との暮らしガイド' }],
      bodyExcerpt: '犬の健康、食事、お手入れに関する記事を案内するサイトです。',
      fetchStatus: 'available',
    }),
    item(5, {
      pageUrl: 'https://example.test/articles',
      linkText: '次のページ',
      beforeText: '記事一覧 1ページ目',
      afterText: '',
    }, {
      normalizedUrl: 'https://example.test/articles/page/2',
      finalUrl: 'https://example.test/articles/page/2',
      title: '記事一覧 2ページ目',
      headings: [{ level: 1, text: '記事一覧' }],
      bodyExcerpt: '記事一覧の2ページ目です。',
      fetchStatus: 'available',
    }),
    item(6, {
      pageUrl: 'https://example.test/footer',
      linkText: 'プライバシーポリシー',
      beforeText: '個人情報の取り扱いについて',
      afterText: '',
    }, {
      normalizedUrl: 'https://example.test/profile',
      finalUrl: 'https://example.test/profile',
      title: '運営者プロフィール',
      headings: [{ level: 1, text: '運営者について' }],
      bodyExcerpt: 'サイト運営者の経歴と活動内容を紹介します。',
      fetchStatus: 'available',
    }),
    item(7, {
      pageUrl: 'https://example.test/service',
      linkText: 'サービス詳細',
      beforeText: '',
      afterText: '',
    }, {
      normalizedUrl: 'https://example.test/destination',
      finalUrl: 'https://example.test/destination',
      title: 'ページ',
      headings: [],
      bodyExcerpt: '',
      fetchStatus: 'available',
    }),
  ],
  integrity: {
    algorithm: 'HMAC-SHA256',
    payloadHash: 'e'.repeat(64),
    signature: 'f'.repeat(64),
  },
}

export const manualAiQualityExpected: QualityExpectation[] = [
  { itemId: manualAiQualityInput.items[0]!.itemId, caseName: '正常な内容リンク', expectedVerdict: 'match', requiredReasonTerms: ['料金プランを見る', '料金プラン'] },
  { itemId: manualAiQualityInput.items[1]!.itemId, caseName: '明らかな不一致', expectedVerdict: 'possible_mismatch', requiredReasonTerms: ['採用情報', 'お問い合わせ'] },
  { itemId: manualAiQualityInput.items[2]!.itemId, caseName: '取得不能で情報不足', expectedVerdict: 'undetermined', requiredReasonTerms: ['fetch_failed', '取得でき'] },
  { itemId: manualAiQualityInput.items[3]!.itemId, caseName: 'SNS共有リンク', expectedVerdict: 'match', requiredReasonTerms: ['Xで共有', 'x.com/intent/post'] },
  { itemId: manualAiQualityInput.items[4]!.itemId, caseName: 'ホームへのナビゲーション', expectedVerdict: 'match', requiredReasonTerms: ['ホーム', '犬との暮らしガイド'] },
  { itemId: manualAiQualityInput.items[5]!.itemId, caseName: 'ページ送りナビゲーション', expectedVerdict: 'match', requiredReasonTerms: ['次のページ', '記事一覧 2ページ目'] },
  { itemId: manualAiQualityInput.items[6]!.itemId, caseName: '別主題へのリンク', expectedVerdict: 'possible_mismatch', requiredReasonTerms: ['プライバシーポリシー', '運営者プロフィール'] },
  { itemId: manualAiQualityInput.items[7]!.itemId, caseName: '取得済みだが意味情報不足', expectedVerdict: 'undetermined', requiredReasonTerms: ['サービス詳細', '「ページ」'] },
]

export const manualAiQualityCodexOutput: AiOutputBundle = {
  schemaVersion: 1,
  kind: 'web-check-ai-output',
  contractVersion: manualAiQualityInput.contractVersion,
  promptVersion: manualAiQualityInput.promptVersion,
  projectId: manualAiQualityInput.projectId,
  runId: manualAiQualityInput.runId,
  inputBundleId: manualAiQualityInput.bundleId,
  inputPayloadHash: manualAiQualityInput.integrity.payloadHash,
  judge: { mode: 'manual' },
  judgments: [
    { itemId: manualAiQualityInput.items[0]!.itemId, inputHash: manualAiQualityInput.items[0]!.inputHash, verdict: 'match', reason: 'リンク文言「料金プランを見る」と周辺文の月額・年額プラン案内に対し、リンク先titleとh1が「料金プラン」、h2が「月額・年額プラン」で対応しています。' },
    { itemId: manualAiQualityInput.items[1]!.itemId, inputHash: manualAiQualityInput.items[1]!.inputHash, verdict: 'possible_mismatch', reason: 'リンク文言「採用情報」と募集職種を示す周辺文に対し、リンク先titleは「お問い合わせ」、h1は「お問い合わせフォーム」で、主題が明らかに異なります。' },
    { itemId: manualAiQualityInput.items[2]!.itemId, inputHash: manualAiQualityInput.items[2]!.inputHash, verdict: 'undetermined', reason: 'リンク文言は「詳しくはこちら」だけで周辺文がなく、fetchStatusが「fetch_failed」でリンク先内容も取得できないため判断できません。' },
    { itemId: manualAiQualityInput.items[3]!.itemId, inputHash: manualAiQualityInput.items[3]!.inputHash, verdict: 'match', reason: 'リンク文言「Xで共有」とSNS共有を示す直前文に対し、リンク先URLが「x.com/intent/post」でtitleも「X」のため、Xへの共有リンクとして対応しています。' },
    { itemId: manualAiQualityInput.items[4]!.itemId, inputHash: manualAiQualityInput.items[4]!.inputHash, verdict: 'match', reason: 'リンク文言「ホーム」とサイト内ナビゲーションを示す直前文に対し、リンク先はサイトのルートURLで、titleとh1が「犬との暮らしガイド」のためホームへの移動として対応しています。' },
    { itemId: manualAiQualityInput.items[5]!.itemId, inputHash: manualAiQualityInput.items[5]!.inputHash, verdict: 'match', reason: 'リンク文言「次のページ」と「記事一覧 1ページ目」の直前文に対し、リンク先titleが「記事一覧 2ページ目」で、一覧のページ送りとして対応しています。' },
    { itemId: manualAiQualityInput.items[6]!.itemId, inputHash: manualAiQualityInput.items[6]!.inputHash, verdict: 'possible_mismatch', reason: 'リンク文言「プライバシーポリシー」と個人情報を示す直前文に対し、リンク先titleは「運営者プロフィール」、h1は「運営者について」で、主題が異なります。' },
    { itemId: manualAiQualityInput.items[7]!.itemId, inputHash: manualAiQualityInput.items[7]!.inputHash, verdict: 'undetermined', reason: 'リンク文言「サービス詳細」に対し、リンク先で利用できる情報は意味を特定できないtitle「ページ」だけで、対応関係を判断できません。' },
  ],
}
