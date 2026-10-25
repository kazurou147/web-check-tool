<script setup lang="ts">
import type { RunSummary, RunStatus, Verdict } from '~/shared/types/run'
import type { ComparisonCategory, ComparisonChange, RunComparisonResponse } from '~/shared/types/run-comparison'

const props = defineProps<{ projectId: string; runs: RunSummary[]; selectedRunId: string }>()
const baseRunId = ref('')
const targetRunId = ref('')
const category = ref<ComparisonCategory | ''>('')
const pageUrl = ref('')
const item = ref('')
const page = ref(1)
const loading = ref(false)
const errorMessage = ref('')
const comparison = ref<RunComparisonResponse | null>(null)

const selectedRun = computed(() => props.runs.find(run => run.runId === props.selectedRunId))
const rerunSourceAvailable = computed(() => Boolean(selectedRun.value?.rerunOfRunId && props.runs.some(run => run.runId === selectedRun.value?.rerunOfRunId)))

initializeDefaults()
onMounted(() => {
  if (baseRunId.value && targetRunId.value) void loadComparison()
})

function initializeDefaults() {
  const selected = selectedRun.value
  if (selected?.rerunOfRunId && props.runs.some(run => run.runId === selected.rerunOfRunId)) {
    baseRunId.value = selected.rerunOfRunId
    targetRunId.value = selected.runId
    return
  }
  const completed = props.runs.filter(run => run.status === 'completed')
  if (completed.length >= 2) {
    targetRunId.value = completed[0]!.runId
    baseRunId.value = completed[1]!.runId
  }
}

function useRerunPair() {
  const selected = selectedRun.value
  if (!selected?.rerunOfRunId) return
  baseRunId.value = selected.rerunOfRunId
  targetRunId.value = selected.runId
  page.value = 1
  void loadComparison()
}

async function loadComparison() {
  if (!baseRunId.value || !targetRunId.value || baseRunId.value === targetRunId.value) {
    errorMessage.value = baseRunId.value === targetRunId.value ? '同じ検査結果同士は比較できません。' : '比較元と比較先を選択してください。'
    return
  }
  loading.value = true
  errorMessage.value = ''
  try {
    comparison.value = await $fetch<RunComparisonResponse>(`/api/projects/${props.projectId}/compare`, {
      query: { base: baseRunId.value, target: targetRunId.value, category: category.value || undefined, pageUrl: pageUrl.value || undefined, item: item.value || undefined, page: page.value, pageSize: 25 },
    })
  } catch (caught) {
    errorMessage.value = (caught as { data?: { statusMessage?: string } }).data?.statusMessage ?? '履歴を比較できませんでした。'
  } finally {
    loading.value = false
  }
}

function applyFilters() {
  page.value = 1
  void loadComparison()
}

function movePage(next: number) {
  if (!comparison.value || next < 1 || next > comparison.value.pagination.totalPages) return
  page.value = next
  void loadComparison()
}

function formatDate(value?: string): string {
  return value ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)) : '—'
}

function formatValue(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value || '（空文字）'
  return JSON.stringify(value, null, 2)
}

function changeTitle(change: ComparisonChange): string {
  if (change.presence === 'added') return '対象追加'
  if (change.presence === 'removed') return '対象削除'
  if (change.presence === 'unobserved') return '片側で未観測'
  return outcomeLabels[change.issueOutcome]
}

const categories: Array<{ value: ComparisonCategory; label: string }> = [
  { value: 'aggregate', label: 'ページ集約' },
  { value: 'detail', label: '個別詳細' },
  { value: 'ai', label: 'AI判定' },
  { value: 'input', label: 'Excel入力' },
]
const statusLabels: Record<RunStatus, string> = {
  queued: '開始待ち', reading_input: 'Excel読込中', authenticating: '認証中', checking: '検査中', ai_checking: 'AI判定中', completed: '完了', failed: '失敗', canceled: 'キャンセル済み', interrupted: '中断',
}
const verdictLabels: Record<Verdict, string> = { ng: 'NG', needs_review: '要確認', unchecked: '未確認', excluded: '対象外', ok: 'OK' }
const outcomeLabels = {
  ng_resolved: 'NG解消', ng_introduced: 'NG発生', ng_continued: 'NG継続', verdict_changed: '判定変化', became_unchecked: '確認不能へ変更', became_excluded: '対象外へ変更', none: '内容変更', indeterminate: '対応不確実',
} as const
</script>

<template>
  <section class="run-comparison stack" aria-labelledby="run-comparison-title">
    <div class="section-title-row">
      <div><p class="eyebrow">HISTORY COMPARISON</p><h3 id="run-comparison-title">履歴を比較</h3></div>
      <button v-if="rerunSourceAvailable" class="button secondary" type="button" @click="useRerunPair">再実行元と比較</button>
    </div>
    <div class="comparison-selectors">
      <label>比較元run<select v-model="baseRunId"><option value="">選択してください</option><option v-for="run in runs" :key="run.runId" :value="run.runId">{{ formatDate(run.createdAt) }}／{{ statusLabels[run.status] }}／{{ run.runId }}</option></select></label>
      <label>比較先run<select v-model="targetRunId"><option value="">選択してください</option><option v-for="run in runs" :key="run.runId" :value="run.runId">{{ formatDate(run.createdAt) }}／{{ statusLabels[run.status] }}／{{ run.runId }}</option></select></label>
      <button class="button primary comparison-run-button" type="button" :disabled="loading || !baseRunId || !targetRunId" @click="applyFilters">{{ loading ? '比較中…' : '比較する' }}</button>
    </div>
    <p v-if="!baseRunId || !targetRunId" class="hint">completedが2件未満の場合は、比較する2件を手動で選択してください。</p>
    <p v-if="errorMessage" class="notice error">{{ errorMessage }}</p>

    <template v-if="comparison">
      <div class="comparison-run-descriptors">
        <article><strong>比較元</strong><span>{{ formatDate(comparison.base.createdAt) }}／{{ statusLabels[comparison.base.status] }}</span><code>{{ comparison.base.runId }}</code><span>{{ comparison.base.completedPages }}/{{ comparison.base.totalPages }}ページ</span></article>
        <article><strong>比較先</strong><span>{{ formatDate(comparison.target.createdAt) }}／{{ statusLabels[comparison.target.status] }}</span><code>{{ comparison.target.runId }}</code><span>{{ comparison.target.completedPages }}/{{ comparison.target.totalPages }}ページ</span></article>
      </div>
      <p v-for="warning in comparison.warnings" :key="warning" class="notice" :class="comparison.reliability === 'partial' ? 'error' : ''">{{ warning }}</p>

      <div class="comparison-summary-list">
        <article v-for="entry in categories" :key="entry.value" class="comparison-summary-card">
          <strong>{{ entry.label }}</strong><span>NG解消 {{ comparison.summary[entry.value].ngResolved }}</span><span>NG発生 {{ comparison.summary[entry.value].ngIntroduced }}</span><span>NG継続 {{ comparison.summary[entry.value].ngContinued }}</span><span>追加 {{ comparison.summary[entry.value].added }}</span><span>削除 {{ comparison.summary[entry.value].removed }}</span><span v-if="comparison.summary[entry.value].unobserved">未観測 {{ comparison.summary[entry.value].unobserved }}</span><span v-if="comparison.summary[entry.value].uncertain">対応不確実 {{ comparison.summary[entry.value].uncertain }}</span>
        </article>
      </div>

      <details v-if="Object.keys(comparison.summary.verdictTransitions).length" class="detail-group">
        <summary>判定遷移集計</summary><div class="comparison-transition-list"><span v-for="(count, transition) in comparison.summary.verdictTransitions" :key="transition">{{ transition }}: {{ count }}件</span></div>
      </details>
      <details v-if="comparison.conditionDifferences.length" class="detail-group" open>
        <summary>検査条件の差分（{{ comparison.conditionDifferences.length }}件）</summary>
        <div class="table-wrap"><table><thead><tr><th>条件</th><th>比較元</th><th>比較先</th></tr></thead><tbody><tr v-for="difference in comparison.conditionDifferences" :key="difference.key"><th>{{ difference.label }}</th><td class="break-all">{{ difference.before }}</td><td class="break-all">{{ difference.after }}</td></tr></tbody></table></div>
      </details>

      <form class="comparison-filters" @submit.prevent="applyFilters">
        <label>カテゴリ<select v-model="category"><option value="">すべて</option><option v-for="entry in categories" :key="entry.value" :value="entry.value">{{ entry.label }}</option></select></label>
        <label>ページ（URL・ページ名）<input v-model="pageUrl" type="search" placeholder="URLまたはページ名の一部"></label>
        <label>項目<input v-model="item" type="search" placeholder="title、リンクなど"></label>
        <button class="button secondary" type="submit" :disabled="loading">絞り込む</button>
      </form>

      <div class="comparison-changes">
        <p v-if="!comparison.changes.length" class="empty-inline">条件に一致する変更はありません。</p>
        <article v-for="change in comparison.changes" :key="change.key" class="comparison-change-card">
          <div class="comparison-change-heading"><span class="status-chip" :class="change.issueOutcome === 'ng_introduced' ? 'failed' : change.issueOutcome === 'ng_resolved' ? 'completed' : 'canceled'">{{ changeTitle(change) }}</span><strong>{{ change.item }}</strong><span>{{ categories.find(entry => entry.value === change.category)?.label }}</span><span v-if="change.confidence === 'uncertain'" class="confidence-warning">対応不確実</span></div>
          <p v-if="change.pageUrl" class="long-value">{{ change.pageUrl }}</p>
          <p v-if="change.pageNames.length" class="hint">{{ change.pageNames.join(' / ') }}<template v-if="change.sourceRows.length"> ／ 元行 {{ change.sourceRows.join(', ') }}</template></p>
          <div class="comparison-before-after">
            <div><span>変更前</span><template v-if="change.before"><b class="verdict-badge" :class="change.before.verdict">{{ verdictLabels[change.before.verdict] }}</b><p>{{ change.before.message }}</p><pre>期待値: {{ formatValue(change.before.expected) }}</pre><pre>実測値: {{ formatValue(change.before.actual) }}</pre></template><p v-else>（なし）</p></div>
            <div><span>変更後</span><template v-if="change.after"><b class="verdict-badge" :class="change.after.verdict">{{ verdictLabels[change.after.verdict] }}</b><p>{{ change.after.message }}</p><pre>期待値: {{ formatValue(change.after.expected) }}</pre><pre>実測値: {{ formatValue(change.after.actual) }}</pre></template><p v-else>（なし）</p></div>
          </div>
        </article>
      </div>
      <div class="comparison-pagination"><button class="button" type="button" :disabled="loading || comparison.pagination.page <= 1" @click="movePage(comparison.pagination.page - 1)">前へ</button><span>{{ comparison.pagination.page }}/{{ comparison.pagination.totalPages }}ページ（{{ comparison.pagination.total }}件）</span><button class="button" type="button" :disabled="loading || comparison.pagination.page >= comparison.pagination.totalPages" @click="movePage(comparison.pagination.page + 1)">次へ</button></div>
    </template>
  </section>
</template>
