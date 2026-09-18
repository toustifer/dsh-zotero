/**
 * Unit tests for Zotero annotations and Markdown note synchronization.
 * Run: node tests/test-annotations.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  formatMarkdownCard,
  formatPaperHeader,
  appendMarkdownNote,
} = await import('../lib/backend/markdown-notes.js')

const {
  buildZoteroItemPayload,
  annotateItem,
} = await import('../lib/backend/annotations.js')

let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

console.log('[1] Markdown Notes Generator')

const card1 = formatMarkdownCard({
  itemKey: 'ITEM1234',
  title: 'Attention Is All You Need',
  doi: '10.5555/3295222.3295349',
  type: 'highlight',
  text: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
  comment: 'Transformer 开篇立论：指出 RNN/CNN 的固有缺陷。',
  color: '#ffd400',
  pageLabel: '1',
  tags: ['transformer', 'nlp'],
  timestamp: '2026-09-18T12:00:00.000Z',
  zoteroKey: 'ANNO9999',
})

check('card contains title', card1.includes('Attention Is All You Need'))
check('card contains itemKey', card1.includes('`ITEM1234`'))
check('card contains DOI link', card1.includes('10.5555/3295222.3295349'))
check('card contains quote text', card1.includes('The dominant sequence transduction models'))
check('card contains comment', card1.includes('Transformer 开篇立论'))
check('card contains timestamp', card1.includes('2026-09-18T12:00:00.000Z'))
check('card contains tags', card1.includes('`#transformer`') && card1.includes('`#nlp`'))
check('card contains zoteroKey', card1.includes('`ANNO9999`'))

// Test appendMarkdownNote in temporary directory
const tempDir = mkdtempSync(join(tmpdir(), 'dsh-zotero-test-'))
try {
  const res1 = appendMarkdownNote(
    {
      itemKey: 'ITEM1234',
      title: 'Attention Is All You Need',
      doi: '10.5555/3295222.3295349',
      type: 'highlight',
      text: 'First highlight',
      comment: 'First comment',
    },
    { workspaceDir: tempDir },
  )
  check('new note file created', res1.created === true)
  const fullPath1 = join(tempDir, res1.filePath)
  check('file exists on disk', existsSync(fullPath1))
  const fileContent1 = readFileSync(fullPath1, 'utf8')
  check('file has header', fileContent1.includes('# 📚 文献笔记卡片'))

  // Append a second note
  const res2 = appendMarkdownNote(
    {
      itemKey: 'ITEM1234',
      title: 'Attention Is All You Need',
      doi: '10.5555/3295222.3295349',
      type: 'comment',
      comment: 'Second comment',
    },
    { workspaceDir: tempDir },
  )
  check('append to existing file created=false', res2.created === false)
  const fileContent2 = readFileSync(fullPath1, 'utf8')
  check('file has both notes', fileContent2.includes('First highlight') && fileContent2.includes('Second comment'))
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

console.log('[2] Zotero Item Payload Builder')

// Highlight annotation
const payloadHighlight = buildZoteroItemPayload({
  itemKey: 'ITEM1234',
  type: 'highlight',
  parentItem: 'PDFATT01',
  text: 'Self-attention mechanism connects all positions.',
  comment: 'Key mechanism',
  color: '#ffd400',
  pageLabel: '3',
  tags: ['attention'],
})

check('highlight itemType is annotation', payloadHighlight.itemType === 'annotation')
check('highlight annotationType is highlight', payloadHighlight.annotationType === 'highlight')
check('highlight parentItem is attachment key', payloadHighlight.parentItem === 'PDFATT01')
check('highlight text preserved', payloadHighlight.annotationText === 'Self-attention mechanism connects all positions.')
check('highlight comment preserved', payloadHighlight.annotationComment === 'Key mechanism')
check('highlight color preserved', payloadHighlight.annotationColor === '#ffd400')
check('highlight pageLabel preserved', payloadHighlight.annotationPageLabel === '3')
check('highlight tags formatted as objects', Array.isArray(payloadHighlight.tags) && payloadHighlight.tags[0].tag === 'attention')

// Note item
const payloadNote = buildZoteroItemPayload({
  itemKey: 'ITEM1234',
  type: 'note',
  parentItem: 'ITEM1234',
  title: 'Paper Overview',
  text: 'Quote',
  comment: 'General reflection on model scaling.',
  tags: ['overview'],
})

check('note itemType is note', payloadNote.itemType === 'note')
check('note parentItem is itemKey', payloadNote.parentItem === 'ITEM1234')
check('note HTML contains title and comment', typeof payloadNote.note === 'string' && payloadNote.note.includes('Paper Overview') && payloadNote.note.includes('General reflection on model scaling.'))

// Comment item
const payloadComment = buildZoteroItemPayload({
  itemKey: 'ITEM1234',
  type: 'comment',
  parentItem: 'PDFATT01',
  comment: 'Important critique on computational complexity.',
  color: '#ff6666',
})
check('comment itemType is annotation', payloadComment.itemType === 'annotation')
check('comment comment preserved', payloadComment.annotationComment === 'Important critique on computational complexity.')
check('comment color preserved', payloadComment.annotationColor === '#ff6666')

console.log('[3] End-to-End annotateItem with Mock Client')

const mockClient = {
  scoped() {
    return this
  },
  async getItem(key) {
    if (key === 'VALID_KEY') {
      return {
        found: true,
        source: 'local',
        item: {
          key: 'VALID_KEY',
          title: 'Deep Residual Learning for Image Recognition',
          doi: '10.1109/CVPR.2016.90',
          attachments: [
            { key: 'PDF_RESNET', isPdf: true, title: 'resnet.pdf' },
          ],
        },
        error: '',
        hint: '',
      }
    }
    return {
      found: false,
      source: 'none',
      item: null,
      error: 'Not found',
      hint: '',
    }
  },
  async createItems(items) {
    return {
      ok: true,
      source: 'local',
      successKeys: ['ANNO_CREATED_001'],
      failed: {},
      error: '',
      hint: '',
      raw: { success: { '0': 'ANNO_CREATED_001' } },
    }
  },
}

const testWsDir = mkdtempSync(join(tmpdir(), 'dsh-annotate-ws-'))
try {
  const result = await annotateItem(mockClient, {
    itemKey: 'VALID_KEY',
    type: 'highlight',
    text: 'Deep neural networks are more difficult to train.',
    comment: 'ResNet problem statement',
    workspaceDir: testWsDir,
  })

  check('annotateItem result ok', result.ok === true)
  check('zoteroCreated is true', result.zoteroCreated === true)
  check('zoteroItemKey captured', result.zoteroItemKey === 'ANNO_CREATED_001')
  check('markdownSaved is true', result.markdownSaved === true)
  check('citation title captured from item', result.citation.title === 'Deep Residual Learning for Image Recognition')
  check('citation doi captured from item', result.citation.doi === '10.1109/CVPR.2016.90')

  const writtenMd = readFileSync(join(testWsDir, result.markdownPath), 'utf8')
  check('markdown file contains ResNet title', writtenMd.includes('Deep Residual Learning for Image Recognition'))
  check('markdown file contains zotero key', writtenMd.includes('ANNO_CREATED_001'))
} finally {
  rmSync(testWsDir, { recursive: true, force: true })
}

if (failed) {
  console.error(`\nFAILED ${failed}`)
  process.exit(1)
}

console.log('\nAll annotation & sync tests passed!')
