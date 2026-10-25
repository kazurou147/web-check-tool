<script setup lang="ts">
import type {
  FindingItem,
  GoogleTagDetection,
  ImageResult,
  LinkResult,
  PageResult,
  RunResult,
  RunStatus,
  RunSummary,
  Verdict,
} from '~/shared/types/run'
import type { AiPreparationStatus, AiVerdict } from '~/shared/types/ai'
import type { AiMode } from '~/shared/types/ai'
import type { ProjectSettings } from '~/shared/types/project'
import { buildCodexManualInstructions, judgmentByItemId, manualAiCounts, manualAiQualityWarnings } from '~/shared/utils/manual-ai'
import { canCancelRun, highestFindingVerdict, imageVerdictCounts, isActiveRun, runProgress, sortFindings } from '~/shared/utils/run-display'

const props = defineProps<{
  projectId: string
  archived: boolean
  hasExcel: boolean
  settings: ProjectSettings
  credentialsConfigured: boolean
}>()

const route = useRoute()
const router = useRouter()
const { data: initialHistory, error: initialHistoryError } = await useFetch<{ runs: RunSummary[] }>(
  `/api/projects/${props.projectId}/runs`,
)

const runs = ref<RunSummary[]>(initialHistory.value?.runs ?? [])
const queryRunId = typeof route.query.run === 'string' ? route.query.run : ''
const selectedRunId = ref(runs.value.some(run => run.runId === queryRunId) ? queryRunId : runs.value[0]?.runId ?? '')
const result = ref<RunResult | null>(null)
const starting = ref(false)
const loadingResult = ref(false)
const polling = ref(false)
const runMessage = ref('')
const runMessageKind = ref<'success' | 'error'>('success')
const importingAi = ref(false)
const downloadingAi = ref(false)
const downloadingExcel = ref(false)
const downloadingJson = ref(false)
const canceling = ref(false)
const rerunning = ref(false)
const showRerunDialog = ref(false)
const rerunConfigSource = ref<'current_project' | 'source_run'>('current_project')
const rerunAiMode = ref<AiMode>('off')
const confirmPaidApi = ref(false)
const aiFileInput = ref<HTMLInputElement | null>(null)
const { data: aiConfig } = await useFetch<{ apiKeyConfigured: boolean }>('/api/ai/config')
let pollTimer: ReturnType<typeof setInterval> | undefined

const progress = computed(() => result.value ? runProgress(result.value) : { completed: 0, total: 0, percent: 0 })
const activeResult = computed(() => Boolean(result.value && isActiveRun(result.value.status)))
const hasActiveRun = computed(() => activeResult.value || runs.value.some(run => isActiveRun(run.status)))
const canStart = computed(() => props.hasExcel && !props.archived && !starting.value && !hasActiveRun.value)
const canRerun = computed(() => Boolean(result.value && !activeResult.value && !props.archived && props.hasExcel && !hasActiveRun.value && !rerunning.value))
const rerunDifferences = computed(() => {
  if (!result.value) return []
  const source = result.value.configSnapshot
  const differences: string[] = []
  if (source.pageConcurrency !== props.settings.pageConcurrency) differences.push(`ページ並列数: 過去 ${source.pageConcurrency}／現在 ${props.settings.pageConcurrency}`)
  if (source.navigationTimeoutMs !== props.settings.navigationTimeoutMs) differences.push(`ページ遷移タイムアウト: 過去 ${source.navigationTimeoutMs / 1000}秒／現在 ${props.settings.navigationTimeoutMs / 1000}秒`)
  if (source.authMode !== props.settings.auth.mode) differences.push(`認証モード: 過去 ${source.authMode}／現在 ${props.settings.auth.mode}`)
  if (source.aiMode !== props.settings.ai.mode) differences.push(`AIモード: 過去 ${source.aiMode.toUpperCase()}／現在 ${props.settings.ai.mode.toUpperCase()}`)
  const sourceHosts = [...(source.allowedPrivateHosts ?? [])].sort().join(', ')
  const currentHosts = [...props.settings.allowedPrivateHosts].sort().join(', ')
  if (sourceHosts !== currentHosts) differences.push(`許可プライベートホスト: 過去 ${sourceHosts || 'なし'}／現在 ${currentHosts || 'なし'}`)
  return differences
})
const aiCounts = computed(() => manualAiCounts(result.value?.ai))
const aiJudgments = computed(() => judgmentByItemId(result.value?.ai))
const aiItems = computed(() => result.value?.ai?.inputBundle?.items ?? [])
const aiQualityWarnings = computed(() => manualAiQualityWarnings(result.value?.ai))

onMounted(async () => {
  if (selectedRunId.value) await loadRun(selectedRunId.value, false)
  syncPolling()
})

onBeforeUnmount(stopPolling)

watch(() => result.value?.status, (status) => {
  if (status && !isActiveRun(status)) canceling.value = false
  syncPolling()
})

async function startRun() {
  if (!canStart.value) return
  starting.value = true
  setRunMessage('', 'success')
  try {
    const started = await $fetch<{ runId: string; status: RunStatus }>(`/api/projects/${props.projectId}/runs`, {
      method: 'POST',
    })
    selectedRunId.value = started.runId
    await Promise.all([refreshHistory(), loadRun(started.runId)])
    setRunMessage('検査を開始しました。途中結果はページ完了ごとに保存されます。', 'success')
  } catch (caught) {
    setRunMessage(getErrorMessage(caught), 'error')
    await refreshHistory().catch(() => undefined)
  } finally {
    starting.value = false
  }
}

async function cancelRun() {
  if (!result.value || !selectedRunId.value || !canCancelRun(result.value.status, canceling.value)) return
  const confirmed = window.confirm('検査をキャンセルしますか？ 完了済みページとAI判定バッチの途中結果は保持されます。OpenAI APIへ送信済みの処理は、キャンセル後も料金が発生する場合があります。')
  if (!confirmed) return
  canceling.value = true
  let accepted = false
  try {
    const response = await $fetch<{ message: string }>(
      `/api/projects/${props.projectId}/runs/${selectedRunId.value}/cancel`,
      { method: 'POST' },
    )
    accepted = true
    setRunMessage(response.message, 'success')
    await Promise.all([loadRun(selectedRunId.value, false), refreshHistory()])
  } catch (caught) {
    const message = getErrorMessage(caught)
    if ((caught as { statusCode?: number }).statusCode === 409 || (caught as { response?: { status?: number } }).response?.status === 409) {
      setRunMessage(`キャンセル要求時点で検査はすでに終了していました。${message}`, 'success')
    } else {
      setRunMessage(message, 'error')
    }
    await Promise.all([loadRun(selectedRunId.value, false), refreshHistory().catch(() => undefined)])
  } finally {
    if (!accepted) canceling.value = false
  }
}

async function selectRun(runId: string) {
  if (runId === selectedRunId.value && result.value) return
  selectedRunId.value = runId
  await loadRun(runId)
}

async function loadRun(runId: string, updateRoute = true) {
  if (!runId || loadingResult.value) return
  loadingResult.value = true
  try {
    const response = await $fetch<{ result: RunResult }>(`/api/projects/${props.projectId}/runs/${runId}`)
    result.value = response.result
    selectedRunId.value = runId
    if (updateRoute && route.query.run !== runId) {
      await router.replace({ query: { ...route.query, run: runId } })
    }
    if (runMessageKind.value === 'error') setRunMessage('', 'success')
  } catch (caught) {
    // Keep the last successfully loaded result visible when a refresh request fails.
    setRunMessage(`結果の更新に失敗しました。最後に保存された表示を維持しています。${getErrorMessage(caught)}`, 'error')
  } finally {
    loadingResult.value = false
  }
}

async function refreshHistory() {
  const response = await $fetch<{ runs: RunSummary[] }>(`/api/projects/${props.projectId}/runs`)
  runs.value = response.runs
}

async function downloadAiInput() {
  if (!result.value?.ai?.inputBundle || !selectedRunId.value) return
  const confirmed = window.confirm('自動マスキングですべての個人情報を検出できるとは限りません。内容を確認したうえでCodexへ添付してください。ダウンロードしますか？')
  if (!confirmed) return
  downloadingAi.value = true
  try {
    const response = await fetch(`/api/projects/${props.projectId}/runs/${selectedRunId.value}/ai/input`)
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { statusMessage?: string }
      throw new Error(error.statusMessage ?? 'AI判定用JSONをダウンロードできませんでした。')
    }
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `web-check-ai-input-${selectedRunId.value}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setRunMessage('AI判定用JSONをダウンロードしました。', 'success')
  } catch (caught) {
    setRunMessage(caught instanceof Error ? caught.message : 'AI判定用JSONをダウンロードできませんでした。', 'error')
  } finally {
    downloadingAi.value = false
  }
}

async function downloadExcelReport() {
  if (!result.value || !selectedRunId.value || activeResult.value || downloadingExcel.value) return
  downloadingExcel.value = true
  setRunMessage('', 'success')
  try {
    await $fetch(`/api/projects/${props.projectId}/runs/${selectedRunId.value}/export/excel`, { method: 'POST' })
    const response = await fetch(`/api/projects/${props.projectId}/runs/${selectedRunId.value}/export/excel`)
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { statusMessage?: string }
      throw new Error(error.statusMessage ?? 'Excelレポートをダウンロードできませんでした。')
    }
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `web-check-report-${selectedRunId.value}.xlsx`
    anchor.click()
    URL.revokeObjectURL(url)
    setRunMessage('Excelレポートを生成してダウンロードしました。', 'success')
  } catch (caught) {
    setRunMessage(getErrorMessage(caught), 'error')
  } finally {
    downloadingExcel.value = false
  }
}

async function downloadJsonResult() {
  if (!result.value || !selectedRunId.value || downloadingJson.value) return
  const confirmed = window.confirm('JSONには検査対象サイト由来の文章や一般的なメールアドレス・電話番号など、個人情報が含まれる可能性があります。自動マスキングは秘密情報の完全除去を保証しません。ダウンロードしますか？')
  if (!confirmed) return
  downloadingJson.value = true
  try {
    const response = await fetch(`/api/projects/${props.projectId}/runs/${selectedRunId.value}/export/json`)
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { statusMessage?: string }
      throw new Error(error.statusMessage ?? 'JSON結果をダウンロードできませんでした。')
    }
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `web-check-result-${selectedRunId.value}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setRunMessage(activeResult.value ? '現在までに保存されたJSONスナップショットをダウンロードしました。' : 'JSON結果をダウンロードしました。', 'success')
  } catch (caught) {
    setRunMessage(getErrorMessage(caught), 'error')
  } finally {
    downloadingJson.value = false
  }
}

function openRerunDialog() {
  if (!canRerun.value) return
  rerunConfigSource.value = 'current_project'
  rerunAiMode.value = 'off'
  confirmPaidApi.value = false
  showRerunDialog.value = true
}

async function rerunAllUrls() {
  if (!result.value || !canRerun.value) return
  if (rerunAiMode.value === 'api' && !confirmPaidApi.value) {
    return setRunMessage('APIモードでは有料実行の確認が必要です。', 'error')
  }
  rerunning.value = true
  setRunMessage('', 'success')
  try {
    const started = await $fetch<{ runId: string; status: RunStatus }>(
      `/api/projects/${props.projectId}/runs/${result.value.runId}/rerun`,
      {
        method: 'POST',
        body: {
          configSource: rerunConfigSource.value,
          aiMode: rerunAiMode.value,
          confirmPaidApi: confirmPaidApi.value,
        },
      },
    )
    showRerunDialog.value = false
    selectedRunId.value = started.runId
    await Promise.all([refreshHistory(), loadRun(started.runId)])
    setRunMessage('現在のExcelを再読込し、全URLの再実行を開始しました。', 'success')
  } catch (caught) {
    setRunMessage(getErrorMessage(caught), 'error')
    await refreshHistory().catch(() => undefined)
  } finally {
    rerunning.value = false
  }
}

async function copyCodexInstructions() {
  const bundle = result.value?.ai?.inputBundle
  if (!bundle) return
  try {
    await navigator.clipboard.writeText(buildCodexManualInstructions(bundle))
    setRunMessage('Codex用の指示文をコピーしました。', 'success')
  } catch {
    setRunMessage('指示文をコピーできませんでした。ブラウザのクリップボード権限を確認してください。', 'error')
  }
}

async function importAiResult(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !selectedRunId.value) return
  importingAi.value = true
  try {
    const body = new FormData()
    body.append('file', file)
    const response = await $fetch<{ result: RunResult; idempotent: boolean; message: string }>(
      `/api/projects/${props.projectId}/runs/${selectedRunId.value}/ai/import`,
      { method: 'POST', body },
    )
    result.value = response.result
    setRunMessage(response.message, 'success')
    await refreshHistory().catch(() => undefined)
  } catch (caught) {
    setRunMessage(getErrorMessage(caught), 'error')
  } finally {
    importingAi.value = false
    input.value = ''
  }
}

function syncPolling() {
  stopPolling()
  if (!activeResult.value) return
  polling.value = true
  pollTimer = setInterval(async () => {
    if (!selectedRunId.value || loadingResult.value) return
    await loadRun(selectedRunId.value, false)
    await refreshHistory().catch(() => undefined)
    if (result.value && !isActiveRun(result.value.status)) stopPolling()
  }, 2_000)
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = undefined
  polling.value = false
}

function linksFor(page: PageResult): LinkResult[] {
  return result.value?.links.filter(item => item.pageUrl === page.normalizedUrl) ?? []
}

function imagesFor(page: PageResult): ImageResult[] {
  return result.value?.images.filter(item => item.pageUrl === page.normalizedUrl) ?? []
}

function imageCountsFor(page: PageResult) {
  return imageVerdictCounts(imagesFor(page))
}

function tagsFor(page: PageResult): GoogleTagDetection[] {
  return result.value?.googleTagDetections.filter(item => item.pageUrl === page.normalizedUrl) ?? []
}

function formatDate(value?: string): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
}

function formatValue(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return visibleWhitespace(value)
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return value.length ? value.map(item => visibleWhitespace(item)).join('\n') : '（なし）'
  }
  return JSON.stringify(value, null, 2)
}

function textDifferenceValues(finding: { item: FindingItem; detailStatus: string; expected?: unknown; actual?: unknown }) {
  if (
    (finding.item !== 'title' && finding.item !== 'description')
    || finding.detailStatus !== 'mismatch'
    || typeof finding.expected !== 'string'
    || !Array.isArray(finding.actual)
    || finding.actual.length !== 1
    || typeof finding.actual[0] !== 'string'
  ) return null

  return { expected: finding.expected, actual: finding.actual[0] }
}

function visibleWhitespace(value: string): string {
  return value.replaceAll(' ', '·').replaceAll('\t', '⇥').replaceAll('\r', '␍').replaceAll('\n', '↵\n') || '（空文字）'
}

function setRunMessage(value: string, kind: 'success' | 'error') {
  runMessage.value = value
  runMessageKind.value = kind
}

function getErrorMessage(caught: unknown): string {
  return (caught as { data?: { statusMessage?: string } }).data?.statusMessage
    ?? (caught instanceof Error ? caught.message : '処理に失敗しました。')
}

const statusLabels: Record<RunStatus, string> = {
  queued: '開始待ち',
  reading_input: 'Excel読込中',
  authenticating: '認証中',
  checking: '検査中',
  ai_checking: 'AI判定中',
  completed: '完了',
  failed: '失敗',
  canceled: 'キャンセル済み',
  interrupted: '中断',
}

const verdictLabels: Record<Verdict, string> = {
  ng: 'NG',
  needs_review: '要確認',
  unchecked: '未確認',
  excluded: '対象外',
  ok: 'OK',
}

const itemLabels: Record<FindingItem, string> = {
  page_fetch: 'ページ取得',
  title: 'title',
  description: 'description',
  google_tags: 'Googleタグ',
  links: 'リンク',
  images: '画像',
}

const detectionMethodLabels: Record<GoogleTagDetection['detectionMethod'], string> = {
  html_direct: 'HTML直接設置',
  gtm_delivered: 'GTMコンテナ経由',
  google_tag_delivered: '直接設置Googleタグ経由',
  network: '通信による検出',
}

const installationMethodLabels: Record<GoogleTagDetection['installationMethod'], string> = {
  direct: '直接設置',
  gtm: 'GTMコンテナ',
  google_tag: '直接設置Googleタグ',
  unknown: '不明',
}

const aiModeLabels = { off: 'OFF', manual: 'MANUAL', api: 'API' } as const
const aiStatusLabels: Record<AiPreparationStatus, string> = {
  disabled: 'AI判定なし',
  preparing: '入力準備中',
  input_ready: '手動判定待ち（旧形式）',
  awaiting_manual: '手動判定待ち',
  no_targets: '判定対象なし',
  api_checking: 'API判定中',
  api_failed: 'API判定失敗',
  completed: '判定完了',
  canceled: 'キャンセル済み',
  interrupted: '異常終了による中断',
  preparation_failed: '入力準備失敗',
}
const aiVerdictLabels: Record<AiVerdict, string> = {
  match: 'OK',
  possible_mismatch: '要確認',
  undetermined: '判定不可',
}
</script>

<template>
  <section class="card run-panel stack">
    <div class="run-heading">
      <div>
        <p class="eyebrow">INSPECTION</p>
        <h2>Webサイト自動検査</h2>
        <p class="hint">Excelの有効URLだけを検査します。検査中もページ完了ごとに結果を保存します。</p>
      </div>
      <button class="button primary start-run" :disabled="!canStart" @click="startRun">
        {{ starting ? '開始準備中…' : hasActiveRun ? '検査実行中' : '検査開始' }}
      </button>
    </div>

    <p v-if="!hasExcel" class="notice">検査を開始するにはExcelを登録してください。</p>
    <p v-else-if="archived" class="notice">アーカイブ中は新しい検査を開始できません。過去の結果は閲覧できます。</p>
    <p v-if="initialHistoryError" class="notice error">検査履歴を読み込めませんでした。</p>
    <p v-if="runMessage" class="notice" :class="runMessageKind">{{ runMessage }}</p>

    <div v-if="runs.length" class="run-workspace">
      <aside class="run-history" aria-label="検査履歴">
        <div class="section-title-row">
          <h3>検査履歴</h3>
          <span>{{ runs.length }}件</span>
        </div>
        <button
          v-for="run in runs"
          :key="run.runId"
          class="history-item"
          :class="{ selected: run.runId === selectedRunId }"
          @click="selectRun(run.runId)"
        >
          <span class="history-date">{{ formatDate(run.createdAt) }}</span>
          <span class="history-status">
            <span class="status-chip" :class="run.status">{{ statusLabels[run.status] }}</span>
            {{ run.completedPages }}/{{ run.totalPages }}ページ
          </span>
          <span class="history-counts">NG {{ run.summary.ng }} ・ 要確認 {{ run.summary.needsReview }} ・ 対象外 {{ run.summary.excluded ?? 0 }}</span>
        </button>
      </aside>

      <div class="run-result-area">
        <p v-if="loadingResult && !result" class="notice">保存済みの検査結果を読み込んでいます…</p>
        <template v-if="result">
          <div class="result-header">
            <div>
              <span class="status-chip" :class="result.status">{{ statusLabels[result.status] }}</span>
              <span v-if="polling" class="polling-label">2秒ごとに更新中</span>
              <h3>{{ formatDate(result.createdAt) }} の検査</h3>
              <p class="run-id">runId: {{ result.runId }}</p>
              <p v-if="result.rerunOfRunId" class="run-id">再実行元: {{ result.rerunOfRunId }}</p>
            </div>
            <div class="run-times">
              <span>開始 {{ formatDate(result.startedAt) }}</span>
              <span>終了 {{ formatDate(result.finishedAt) }}</span>
              <button
                class="button"
                type="button"
                :disabled="activeResult || downloadingExcel"
                @click="downloadExcelReport"
              >
                {{ downloadingExcel ? 'Excel生成中…' : 'Excelレポートをダウンロード' }}
              </button>
              <button class="button" type="button" :disabled="downloadingJson" @click="downloadJsonResult">
                {{ downloadingJson ? 'JSON準備中…' : activeResult ? '現在までのJSONをダウンロード' : 'JSON結果をダウンロード' }}
              </button>
              <button class="button" type="button" :disabled="!canRerun" @click="openRerunDialog">
                {{ rerunning ? '再実行準備中…' : '全URLを再実行' }}
              </button>
              <button
                v-if="activeResult"
                class="button danger"
                type="button"
                :disabled="canceling"
                @click="cancelRun"
              >
                {{ canceling ? 'キャンセル処理中…' : '検査をキャンセル' }}
              </button>
            </div>
          </div>

          <p v-if="activeResult" class="hint">JSONダウンロードは、ダウンロード時点までに保存された途中結果のスナップショットです。</p>

          <dialog v-if="showRerunDialog" open class="rerun-dialog" aria-labelledby="rerun-dialog-title">
            <form method="dialog" class="stack" @submit.prevent="rerunAllUrls">
              <div>
                <p class="eyebrow">RERUN</p>
                <h3 id="rerun-dialog-title">全URLを再実行</h3>
                <p>現在登録されているExcelを再読込し、新しいrunIdで検査します。元runと入力Excelは変更しません。</p>
              </div>
              <fieldset>
                <legend>検査条件</legend>
                <label><input v-model="rerunConfigSource" type="radio" value="current_project"> 現在の案件設定</label>
                <label><input v-model="rerunConfigSource" type="radio" value="source_run"> 過去runの設定スナップショット</label>
              </fieldset>
              <div class="rerun-differences">
                <strong>過去runと現在設定の差分</strong>
                <ul v-if="rerunDifferences.length"><li v-for="difference in rerunDifferences" :key="difference">{{ difference }}</li></ul>
                <p v-else>比較可能な設定に差はありません。</p>
              </div>
              <p v-if="rerunConfigSource === 'source_run' && result.configSnapshot.authMode !== 'none'" class="notice">
                認証情報とフォーム認証手順は現在の案件設定を使用します。認証モードが過去runと異なる場合は開始できません。
              </p>
              <p v-if="settings.auth.mode !== 'none' && !credentialsConfigured" class="notice error">現在の案件に認証情報が保存されていないため、再実行を開始できません。</p>
              <fieldset>
                <legend>AIリンク内容判定（初期値OFF）</legend>
                <label><input v-model="rerunAiMode" type="radio" value="off"> OFF</label>
                <label><input v-model="rerunAiMode" type="radio" value="manual"> MANUAL</label>
                <label><input v-model="rerunAiMode" type="radio" value="api"> API</label>
              </fieldset>
              <div v-if="rerunAiMode === 'api'" class="notice warning">
                <p>モデル: {{ settings.ai.model }}／料金上限: {{ settings.ai.costLimitUsd.toFixed(2) }} USD／APIキー: {{ aiConfig?.apiKeyConfigured ? '設定済み' : '未設定' }}</p>
                <label><input v-model="confirmPaidApi" type="checkbox"> OpenAI API料金が発生する可能性を確認し、有料実行を許可します。</label>
              </div>
              <div class="button-row rerun-dialog-actions">
                <button class="button" type="button" :disabled="rerunning" @click="showRerunDialog = false">閉じる</button>
                <button class="button primary" type="submit" :disabled="rerunning || (settings.auth.mode !== 'none' && !credentialsConfigured) || (rerunAiMode === 'api' && (!confirmPaidApi || !aiConfig?.apiKeyConfigured))">
                  {{ rerunning ? '開始準備中…' : '新しいrunで再実行' }}
                </button>
              </div>
            </form>
          </dialog>

          <p v-if="result.termination" class="notice">
            <strong>{{ result.termination.kind === 'canceled' ? 'キャンセル' : '異常終了からの復旧' }}:</strong>
            {{ result.termination.kind === 'canceled'
              ? '完了済みの途中結果を保持して検査を終了しました。'
              : 'アプリ再起動時に実行中だったため、中断状態として確定しました。自動再実行はしていません。' }}
            （直前の状態: {{ statusLabels[result.termination.previousStatus] }}）
          </p>

          <div class="progress-block" aria-label="検査進捗">
            <div class="progress-copy">
              <strong>{{ progress.completed }} / {{ progress.total }} ページ完了</strong>
              <span>{{ progress.percent }}%</span>
            </div>
            <div class="progress-track"><span :style="{ width: `${progress.percent}%` }" /></div>
          </div>

          <div class="verdict-metrics" aria-label="判定集計">
            <div class="ng"><strong>{{ result.summary.ng }}</strong><span>NG</span></div>
            <div class="needs_review"><strong>{{ result.summary.needsReview }}</strong><span>要確認</span></div>
            <div class="unchecked"><strong>{{ result.summary.unchecked }}</strong><span>未確認</span></div>
            <div class="excluded"><strong>{{ result.summary.excluded ?? 0 }}</strong><span>対象外</span></div>
            <div class="ok"><strong>{{ result.summary.ok }}</strong><span>OK</span></div>
          </div>

          <p v-if="result.fatalError" class="notice error">
            <strong>検査エラー:</strong> {{ result.fatalError.message }}（{{ result.fatalError.code }}）
          </p>

          <div class="result-context">
            <span>対象行 {{ result.input.totalDataRows }}</span>
            <span>有効行 {{ result.input.validRows }}</span>
            <span>非表示除外 {{ result.input.hiddenExcludedRows }}</span>
            <span>不正・欠落URL {{ result.input.invalidRows.length }}</span>
            <span>固有ページ {{ result.input.uniqueUrlCount }}</span>
          </div>

          <section v-if="result.ai" class="ai-manual-panel stack">
            <div class="section-title-row">
              <h3>AIリンク内容判定</h3>
              <span>{{ aiModeLabels[result.ai.mode] }} ／ {{ aiStatusLabels[result.ai.status] }}</span>
            </div>
            <p v-if="result.ai.error" class="notice error">{{ result.ai.error.message }}</p>
            <p v-else-if="result.ai.mode === 'off'" class="empty-inline">この検査はAI判定OFFで実行されました。機械検査結果だけを表示しています。</p>
            <p v-else-if="result.ai.status === 'no_targets'" class="notice">AI判定対象のテキストリンクは0件でした。</p>

            <template v-if="result.ai.mode !== 'off' && result.ai.inputBundle">
              <div class="ai-metrics" aria-label="AI判定集計">
                <div><strong>{{ aiCounts.sourceLinkCount }}</strong><span>元リンク</span></div>
                <div><strong>{{ aiCounts.targetCount }}</strong><span>重複排除後</span></div>
                <div><strong>{{ aiCounts.completedCount }}</strong><span>判定完了</span></div>
                <div class="ok"><strong>{{ aiCounts.ok }}</strong><span>OK</span></div>
                <div class="needs_review"><strong>{{ aiCounts.needsReview }}</strong><span>要確認計</span></div>
                <div class="unchecked"><strong>{{ aiCounts.undetermined }}</strong><span>判定不可</span></div>
              </div>
              <p v-if="result.ai.mode === 'manual'" class="notice">自動マスキングですべての個人情報を検出できるとは限りません。ダウンロードしたJSONをCodexへ渡す前に内容を確認してください。</p>
              <div v-else class="result-context">
                <span>モデル {{ result.ai.model ?? '—' }}</span>
                <span>入力 {{ result.aiUsage.inputTokens }} tokens</span>
                <span>キャッシュ入力 {{ result.aiUsage.cachedInputTokens ?? 0 }} tokens</span>
                <span>出力 {{ result.aiUsage.outputTokens }} tokens</span>
                <span>概算 ${{ result.aiUsage.estimatedCostUsd.toFixed(6) }}</span>
                <span>上限 ${{ result.aiUsage.costLimitUsd.toFixed(2) }}</span>
                <span>API失敗 {{ result.aiUsage.apiFailureCount ?? 0 }}件</span>
                <span>上限到達 {{ result.aiUsage.stoppedByCostLimit ? 'あり' : 'なし' }}</span>
              </div>
              <p v-if="result.ai.mode === 'api'" class="hint">料金は保存した価格プロファイルによる概算で、実際の請求額を保証しません。</p>
              <p v-for="warning in aiQualityWarnings" :key="warning.code" class="notice error">{{ warning.message }}</p>
              <div v-if="result.ai.mode === 'manual' && aiCounts.targetCount" class="button-row">
                <button class="button" type="button" :disabled="downloadingAi" @click="downloadAiInput">
                  {{ downloadingAi ? 'ダウンロード準備中…' : 'AI判定用JSONをダウンロード' }}
                </button>
                <button class="button" type="button" @click="copyCodexInstructions">Codex用の指示文をコピー</button>
                <button class="button primary" type="button" :disabled="importingAi" @click="aiFileInput?.click()">
                  {{ importingAi ? '取り込み中…' : 'AI判定結果JSONを取り込む' }}
                </button>
                <input ref="aiFileInput" class="visually-hidden" type="file" accept=".json,application/json" @change="importAiResult">
              </div>
              <p v-if="result.ai.manualResult" class="hint">取り込み日時: {{ formatDate(result.ai.manualResult.importedAt) }}</p>
              <p v-if="result.ai.apiResult" class="hint">API判定更新日時: {{ formatDate(result.ai.apiResult.completedAt) }}</p>

              <details v-if="result.ai.manualResult || result.ai.apiResult" class="detail-group" open>
                <summary>AI判定詳細（{{ aiCounts.completedCount }}件）</summary>
                <div class="detail-list">
                  <article v-for="item in aiItems" :key="item.itemId" class="detail-row ai-detail-row">
                    <span
                      v-if="aiJudgments.get(item.itemId)"
                      class="verdict-badge"
                      :class="aiJudgments.get(item.itemId)!.verdict === 'match' ? 'ok' : 'needs_review'"
                    >{{ aiVerdictLabels[aiJudgments.get(item.itemId)!.verdict] }}</span>
                    <div>
                      <strong class="long-value">{{ item.source.linkText || '（リンク文言なし）' }}</strong>
                      <p class="long-value"><strong>リンク元:</strong> {{ item.source.pageUrl }}</p>
                      <p class="long-value"><strong>リンク先:</strong> {{ item.target.finalUrl || item.target.normalizedUrl }}</p>
                      <p><strong>判定理由:</strong> {{ aiJudgments.get(item.itemId)?.reason }}</p>
                      <details>
                        <summary>周辺文章・対応する元リンク（{{ item.sourceReferences.length }}件）</summary>
                        <p class="ai-context"><strong>直前:</strong> {{ item.source.beforeText || '（なし）' }}</p>
                        <p class="ai-context"><strong>直後:</strong> {{ item.source.afterText || '（なし）' }}</p>
                        <ul class="evidence-list">
                          <li v-for="source in item.sourceReferences" :key="source.linkResultKey" class="long-value">{{ source.pageUrl }} ／ {{ source.linkResultKey }}</li>
                        </ul>
                      </details>
                    </div>
                  </article>
                </div>
              </details>
            </template>
          </section>

          <div class="page-results">
            <div class="section-title-row">
              <h3>ページ別結果</h3>
              <span>NG・要確認・未確認・対象外・OKの順に項目を表示</span>
            </div>
            <p v-if="!result.pages.length" class="empty-inline">ページの完了を待っています。画面を更新しても途中結果は保持されます。</p>

            <details
              v-for="page in result.pages"
              :key="page.normalizedUrl"
              class="page-result"
              :open="highestFindingVerdict(page.findings) !== 'ok'"
            >
              <summary>
                <span class="verdict-badge" :class="highestFindingVerdict(page.findings)">
                  {{ verdictLabels[highestFindingVerdict(page.findings)] }}
                </span>
                <span class="page-identity">
                  <strong>{{ page.pageNames.join(' / ') }}</strong>
                  <span>{{ page.normalizedUrl }}</span>
                </span>
                <span class="page-meta">行 {{ page.sourceRows.join(', ') }} ／ HTTP {{ page.httpStatus ?? '—' }}</span>
              </summary>

              <div class="page-result-body">
                <div class="finding-grid">
                  <article v-for="finding in sortFindings(page.findings)" :key="finding.key" class="finding-card" :class="finding.verdict">
                    <div class="finding-title">
                      <span class="verdict-badge" :class="finding.verdict">{{ verdictLabels[finding.verdict] }}</span>
                      <strong>{{ itemLabels[finding.item] }}</strong>
                    </div>
                    <p>{{ finding.message }}</p>
                    <TextDifference
                      v-if="textDifferenceValues(finding)"
                      :expected="textDifferenceValues(finding)!.expected"
                      :actual="textDifferenceValues(finding)!.actual"
                    />
                    <div v-else-if="finding.expected !== undefined || finding.actual !== undefined" class="value-comparison">
                      <div><span>期待値</span><pre>{{ formatValue(finding.expected) }}</pre></div>
                      <div><span>実際の値</span><pre>{{ formatValue(finding.actual) }}</pre></div>
                    </div>
                    <p v-if="finding.item === 'google_tags' && finding.evidence.length" class="evidence-hint">通信根拠は下のGoogleタグ検出詳細に要約表示します。</p>
                    <ul v-else-if="finding.evidence.length" class="evidence-list">
                      <li v-for="(evidence, index) in finding.evidence" :key="index">{{ evidence }}</li>
                    </ul>
                  </article>
                </div>

                <details v-if="tagsFor(page).length" class="detail-group">
                  <summary>Googleタグ検出詳細（{{ tagsFor(page).length }}件）</summary>
                  <div class="detail-list">
                    <article v-for="tag in tagsFor(page)" :key="tag.key" class="detail-row">
                      <span class="verdict-badge" :class="tag.verdict">{{ verdictLabels[tag.verdict] }}</span>
                      <div>
                        <strong>{{ tag.id }}</strong>
                        <p>{{ detectionMethodLabels[tag.detectionMethod] }} ／ 設置方法: {{ installationMethodLabels[tag.installationMethod] }} ／ 位置: {{ tag.location ?? '不明' }} ／ {{ tag.occurrences }}回</p>
                        <p v-if="tag.sourceTagId"><strong>検出元Googleタグ:</strong> {{ tag.sourceTagId }}</p>
                        <p>{{ tag.verdictReason }}</p>
                        <ul v-if="tag.associationEvidence?.length" class="association-evidence">
                          <li v-for="(evidence, index) in tag.associationEvidence" :key="index">{{ evidence }}</li>
                        </ul>
                        <GoogleTagEvidence :tag="tag" />
                      </div>
                    </article>
                  </div>
                </details>

                <details v-if="linksFor(page).length" class="detail-group">
                  <summary>リンク検査詳細（{{ linksFor(page).length }}件）</summary>
                  <div class="detail-list">
                    <article v-for="link in linksFor(page)" :key="link.key" class="detail-row">
                      <span class="verdict-badge" :class="link.verdict">{{ verdictLabels[link.verdict] }}</span>
                      <div>
                        <strong class="long-value">{{ link.href || '（空のhref）' }}</strong>
                        <p>{{ link.message }} ／ HTTP {{ link.status ?? '—' }} ／ リダイレクト {{ link.redirectCount }}回</p>
                        <p v-if="link.finalUrl" class="long-value">到達先: {{ link.finalUrl }}</p>
                        <ul v-if="link.evidence.length" class="evidence-list"><li v-for="(evidence, index) in link.evidence" :key="index">{{ evidence }}</li></ul>
                      </div>
                    </article>
                  </div>
                </details>

                <details v-if="imagesFor(page).length" class="detail-group">
                  <summary>画像検査詳細（{{ imagesFor(page).length }}件）</summary>
                  <div class="image-counts" aria-label="画像判定集計">
                    <span>OK {{ imageCountsFor(page).ok }}</span>
                    <span>NG {{ imageCountsFor(page).ng }}</span>
                    <span>要確認 {{ imageCountsFor(page).needsReview }}</span>
                    <span>未確認 {{ imageCountsFor(page).unchecked }}</span>
                    <span>対象外 {{ imageCountsFor(page).excluded }}</span>
                  </div>
                  <div class="detail-list">
                    <article v-for="image in imagesFor(page)" :key="image.key" class="detail-row">
                      <span class="verdict-badge" :class="image.verdict">{{ verdictLabels[image.verdict] }}</span>
                      <div>
                        <strong>{{ image.device === 'desktop' ? 'PC' : 'スマートフォン' }} ／ {{ image.sourceKind }}</strong>
                        <p class="long-value">{{ image.imageUrl }}</p>
                        <p>{{ image.message }} ／ 出現箇所: {{ image.location }}</p>
                        <p v-if="image.exclusion"><strong>非表示要素:</strong> {{ image.exclusion.hiddenBy }} ／ <strong>media query:</strong> {{ image.exclusion.mediaCondition }}</p>
                        <ul v-if="image.evidence.length" class="evidence-list"><li v-for="(evidence, index) in image.evidence" :key="index">{{ evidence }}</li></ul>
                      </div>
                    </article>
                  </div>
                </details>
              </div>
            </details>
          </div>
        </template>
      </div>
    </div>

    <p v-else class="empty-inline">検査履歴はまだありません。</p>
  </section>
</template>
