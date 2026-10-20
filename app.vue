<template>
  <div>
    <header class="app-header">
      <NuxtLink class="brand" to="/">納品前チェック</NuxtLink>
      <nav aria-label="メインナビゲーション">
        <NuxtLink to="/">案件</NuxtLink>
        <NuxtLink to="/projects/archived">アーカイブ</NuxtLink>
      </nav>
    </header>
    <main class="page-shell">
      <NuxtPage />
    </main>
  </div>
</template>
