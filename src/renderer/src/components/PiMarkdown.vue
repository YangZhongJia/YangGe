<script setup lang="ts">
import { computed } from 'vue'
import { renderPiMarkdown } from '../utils/pi-markdown'

const props = defineProps<{ text: string }>()
const html = computed(() => renderPiMarkdown(props.text))
</script>

<template>
  <div class="pi-markdown" v-html="html"></div>
</template>

<style>
/* v-html 内容不带 scoped 属性，因此这里使用独立类名做局部样式。 */
.pi-markdown {
  color: var(--text-1);
  font-size: var(--font-md);
  line-height: 1.72;
  overflow-wrap: anywhere;
  white-space: normal;
}
.pi-markdown > :first-child {
  margin-top: 0;
}
.pi-markdown > :last-child {
  margin-bottom: 0;
}
.pi-markdown p {
  margin: 0 0 11px;
}
.pi-markdown h1,
.pi-markdown h2,
.pi-markdown h3,
.pi-markdown h4,
.pi-markdown h5,
.pi-markdown h6 {
  margin: 20px 0 8px;
  color: var(--text-1);
  font-weight: 650;
  line-height: 1.35;
  letter-spacing: -0.01em;
}
.pi-markdown h1 {
  font-size: 24px;
}
.pi-markdown h2 {
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line);
  font-size: 20px;
}
.pi-markdown h3 {
  font-size: 17px;
}
.pi-markdown h4,
.pi-markdown h5,
.pi-markdown h6 {
  font-size: 15px;
}
.pi-markdown ul,
.pi-markdown ol {
  margin: 6px 0 12px;
  padding-left: 24px;
}
.pi-markdown li {
  margin: 4px 0;
  padding-left: 2px;
}
.pi-markdown li > p {
  margin: 0;
}
.pi-markdown .md-task-item {
  list-style: none;
  margin-left: -20px;
}
.pi-markdown .md-check {
  display: inline-grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin-right: 6px;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--on-primary);
  font-size: 10px;
  line-height: 1;
  vertical-align: -1px;
}
.pi-markdown .md-check.checked {
  border-color: var(--primary);
  background: var(--primary);
}
.pi-markdown strong {
  font-weight: 650;
}
.pi-markdown em {
  color: var(--text-2);
}
.pi-markdown del {
  color: var(--text-3);
}
.pi-markdown a {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.pi-markdown a:hover {
  color: var(--primary-hover, var(--primary));
}
.pi-markdown code {
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg-list);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 0.88em;
}
.pi-markdown pre.md-code {
  margin: 10px 0 14px;
  padding: 12px 14px;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-list);
  line-height: 1.6;
  tab-size: 2;
}
.pi-markdown pre.md-code code {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  font-size: 12px;
  white-space: pre;
}
.pi-markdown blockquote {
  margin: 10px 0 14px;
  padding: 2px 0 2px 12px;
  border-left: 3px solid var(--primary);
  color: var(--text-2);
}
.pi-markdown blockquote p:last-child {
  margin-bottom: 0;
}
.pi-markdown hr {
  height: 1px;
  margin: 20px 0;
  border: 0;
  background: var(--line);
}
.pi-markdown .md-table-wrap {
  margin: 10px 0 16px;
  overflow-x: auto;
}
.pi-markdown table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-sm);
  line-height: 1.55;
}
.pi-markdown th,
.pi-markdown td {
  padding: 7px 10px;
  border: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
.pi-markdown th {
  background: var(--bg-list);
  color: var(--text-1);
  font-weight: 600;
}
.pi-markdown tbody tr:hover td {
  background: var(--bg-list);
}
.pi-markdown .md-align-center {
  text-align: center;
}
.pi-markdown .md-align-right {
  text-align: right;
}
</style>
