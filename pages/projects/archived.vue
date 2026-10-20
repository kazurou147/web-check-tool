<script setup lang="ts">
import type { ProjectView } from '~/shared/types/project'

const { data, status, error, refresh } = await useFetch<{ projects: ProjectView[] }>('/api/projects/archived')
const busyId = ref('')

async function unarchive(project: ProjectView) {
  busyId.value = project.projectId
  try {
    await $fetch(`/api/projects/${project.projectId}/unarchive`, { method: 'POST' })
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
        <p class="eyebrow">ARCHIVE</p>
        <h1>アーカイブ</h1>
        <p>保管中の案件です。解除して通常一覧へ戻せます。</p>
      </div>
    </div>
    <p v-if="status === 'pending'" class="notice">読み込み中…</p>
    <p v-else-if="error" class="notice error">アーカイブを読み込めませんでした。</p>
    <div v-else-if="data?.projects.length" class="card-list">
      <ProjectCard
        v-for="project in data.projects"
        :key="project.projectId"
        :project="project"
        :archived="true"
        :busy="busyId === project.projectId"
        @unarchive="unarchive(project)"
      />
    </div>
    <div v-else class="empty-state"><h2>アーカイブ案件はありません</h2></div>
  </section>
</template>
