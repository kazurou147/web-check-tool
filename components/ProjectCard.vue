<script setup lang="ts">
import type { ProjectView } from '~/shared/types/project'

defineProps<{ project: ProjectView; archived?: boolean; busy?: boolean }>()
defineEmits<{ archive: []; unarchive: [] }>()

const formatDate = (value: string | null) => value
  ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '—'
</script>

<template>
  <article class="card project-card">
    <div>
      <p class="eyebrow">{{ archived ? `アーカイブ: ${formatDate(project.archivedAt)}` : `更新: ${formatDate(project.updatedAt)}` }}</p>
      <h2>{{ project.name }}</h2>
      <p class="meta">Excel: {{ project.excelFileName || '未登録' }} ／ 認証情報: {{ project.credentialsConfigured ? '設定済み' : '未設定' }}</p>
    </div>
    <div class="actions">
      <NuxtLink class="button secondary" :to="`/projects/${project.projectId}`">{{ archived ? '詳細' : '編集' }}</NuxtLink>
      <button v-if="archived" class="button primary" :disabled="busy" @click="$emit('unarchive')">解除</button>
      <button v-else class="button danger" :disabled="busy" @click="$emit('archive')">アーカイブ</button>
    </div>
  </article>
</template>
