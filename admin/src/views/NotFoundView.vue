<script setup>
import PageHeader from '../components/PageHeader.vue'
</script>

<template>
  <PageHeader title="Page not found" description="That address doesn’t match anything in the admin panel. It may have been renamed or deleted.">
    <RouterLink to="/" class="btn primary">Go to the dashboard</RouterLink>
  </PageHeader>
</template>
