<script setup lang="ts">
import type { ProjectListItem } from '~/shared/types/project'
import type { RunStatus } from '~/shared/types/run'

defineProps<{ project: ProjectListItem; archived?: boolean; busy?: boolean }>()
defineEmits<{ archive: []; unarchive: [] }>()

const formatDate = (value: string | null) => value
  ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '—'

const statusLabels: Record<RunStatus, string> = {
  queued: '開始待ち', reading_input: 'Excel読込中', authenticating: '認証中', checking: '検査中', ai_checking: 'AI判定中',
  completed: '完了', failed: '失敗', canceled: 'キャンセル済み', interrupted: '中断',
}
</script>

<template>
  <article class="card project-card">
    <div>
      <p class="eyebrow">{{ archived ? `アーカイブ: ${formatDate(project.archivedAt)}` : `更新: ${formatDate(project.updatedAt)}` }}</p>
      <h2>{{ project.name }}</h2>
      <p class="meta">Excel: {{ project.excelFileName || '未登録' }} ／ 認証情報: {{ project.credentialsConfigured ? '設定済み' : '未設定' }}</p>
      <div v-if="project.latestRun" class="project-run-summary">
        <p><strong>最新検査:</strong> {{ formatDate(project.latestRun.createdAt) }} ／ {{ statusLabels[project.latestRun.status] }} ／ {{ project.latestRun.completedPages }}/{{ project.latestRun.totalPages }}ページ</p>
        <p>ページ集約項目: NG {{ project.latestRun.summary.ng }} ／ 要確認 {{ project.latestRun.summary.needsReview }} ／ 未確認 {{ project.latestRun.summary.unchecked }} ／ 対象外 {{ project.latestRun.summary.excluded ?? 0 }} ／ OK {{ project.latestRun.summary.ok }}</p>
        <p v-if="project.latestCompletedRun"><strong>直近の完了:</strong> {{ formatDate(project.latestCompletedRun.createdAt) }} ／ NG {{ project.latestCompletedRun.summary.ng }} ／ 要確認 {{ project.latestCompletedRun.summary.needsReview }}</p>
      </div>
      <p v-else class="meta">検査履歴なし</p>
      <p v-if="project.historyHealth.corruptedCount || project.historyHealth.oversizedCount" class="history-health-warning">
        読み取れない履歴があります（破損 {{ project.historyHealth.corruptedCount }}件／過大 {{ project.historyHealth.oversizedCount }}件）。正常な履歴だけを表示しています。
      </p>
    </div>
    <div class="actions">
      <NuxtLink class="button secondary" :to="`/projects/${project.projectId}`">{{ archived ? '詳細' : '編集' }}</NuxtLink>
      <button v-if="archived" class="button primary" :disabled="busy" @click="$emit('unarchive')">解除</button>
      <button v-else class="button danger" :disabled="busy" @click="$emit('archive')">アーカイブ</button>
    </div>
  </article>
</template>
