<script setup lang="ts">
import type { ProjectListItem } from '~/shared/types/project'

const { data, status, error, refresh } = await useFetch<{ projects: ProjectListItem[] }>('/api/projects')
const busyId = ref('')

async function archive(project: ProjectListItem) {
  if (!confirm(`「${project.name}」をアーカイブしますか？ファイルと履歴は保持されます。`)) return
  busyId.value = project.projectId
  try {
    await $fetch(`/api/projects/${project.projectId}/archive`, { method: 'POST' })
    await refresh()
  } finally {
    busyId.value = ''
  }
}
</script>

<template>
  <section class="stack spacious">
    <div class="page-heading">
      <div>
        <p class="eyebrow">PROJECTS</p>
        <h1>案件一覧</h1>
        <p>納品前チェックの入力と認証設定を案件ごとに管理します。</p>
      </div>
      <NuxtLink class="button primary" to="/projects/new">新しい案件</NuxtLink>
    </div>

    <p v-if="status === 'pending'" class="notice">読み込み中…</p>
    <p v-else-if="error" class="notice error">案件を読み込めませんでした。</p>
    <div v-else-if="data?.projects.length" class="card-list">
      <ProjectCard
        v-for="project in data.projects"
        :key="project.projectId"
        :project="project"
        :busy="busyId === project.projectId"
        @archive="archive(project)"
      />
    </div>
    <div v-else class="empty-state">
      <h2>案件はまだありません</h2>
      <p>案件を作成し、検査元のExcelを登録してください。</p>
    </div>
  </section>
</template>
