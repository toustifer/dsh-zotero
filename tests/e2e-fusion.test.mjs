/**
 * Phase 1 E2E Fusion Verification Suite:
 * 1. Backend Annotation Object Construction & Zotero Local API Writeback Protocol
 * 2. Local Workspace Markdown Literature Note Card Creation & Incremental Append
 * 3. Agent-facing zotero_annotate Tool Scheduling & Dispatch Workflow
 * 4. Frontend Artifact lib/client.js Integrity & Fusion UI Identifiers
 *
 * Run: node tests/e2e-fusion.test.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Import backend modules from lib
const {
  formatMarkdownCard,
  formatPaperHeader,
  appendMarkdownNote,
} = await import('../lib/backend/markdown-notes.js')

const {
  buildZoteroItemPayload,
  annotateItem,
} = await import('../lib/backend/annotations.js')

const {
  registerZoteroTools,
  stripBySchema,
} = await import('../lib/tools.js')

let passed = 0
let failed = 0

function assert(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

console.log('======================================================================')
console.log('  Phase 1 Zotero Fusion End-to-End Automated Verification')
console.log('======================================================================\n')

// ============================================================================
// Suite 1: Backend Annotation Object Construction & Zotero Local API Protocol
// ============================================================================
console.log('── Suite 1: Backend Annotation Object Construction & Writeback Protocol ──')

// 1.1 Highlight payload construction
const highlightPayload = buildZoteroItemPayload({
  itemKey: 'KEY_FUSION_001',
  type: 'highlight',
  parentItem: 'ATT_PDF_001',
  text: 'Self-attention allows the model to jointly attend to information from different representation subspaces.',
  comment: 'Multi-head attention 核心优势阐述。',
  color: '#ffd400',
  pageLabel: '4',
  tags: ['transformer', 'multi-head', 'attention'],
})

assert('Highlight: itemType is annotation', highlightPayload.itemType === 'annotation')
assert('Highlight: annotationType is highlight', highlightPayload.annotationType === 'highlight')
assert('Highlight: parentItem bound to attachment', highlightPayload.parentItem === 'ATT_PDF_001')
assert('Highlight: annotationText matches', highlightPayload.annotationText?.includes('jointly attend'))
assert('Highlight: annotationComment matches', highlightPayload.annotationComment?.includes('Multi-head attention'))
assert('Highlight: annotationColor matches yellow hex', highlightPayload.annotationColor === '#ffd400')
assert('Highlight: annotationPageLabel matches', highlightPayload.annotationPageLabel === '4')
assert('Highlight: tags formatted as array of {tag}', 
  Array.isArray(highlightPayload.tags) && 
  highlightPayload.tags.length === 3 && 
  highlightPayload.tags[1].tag === 'multi-head'
)

// 1.2 Note (Child HTML Note) payload construction
const notePayload = buildZoteroItemPayload({
  itemKey: 'KEY_FUSION_001',
  type: 'note',
  parentItem: 'KEY_FUSION_001',
  title: 'Architecture Review & Thoughts',
  text: 'The Transformer is the first transduction model relying entirely on self-attention.',
  comment: '无需循环与卷积结构，彻底突破长程依赖瓶颈。',
  tags: ['review', 'breakthrough'],
})

assert('Note: itemType is note', notePayload.itemType === 'note')
assert('Note: parentItem bound to parent itemKey', notePayload.parentItem === 'KEY_FUSION_001')
assert('Note: note contains strong title HTML', typeof notePayload.note === 'string' && notePayload.note.includes('<strong>Architecture Review &amp; Thoughts</strong>'))
assert('Note: note contains blockquote quote text', notePayload.note.includes('<blockquote>The Transformer is the first'))
assert('Note: note contains paragraph commentary', notePayload.note.includes('<p>无需循环与卷积结构'))

// 1.3 Comment payload with default coral color
const commentPayload = buildZoteroItemPayload({
  itemKey: 'KEY_FUSION_001',
  type: 'comment',
  parentItem: 'ATT_PDF_001',
  comment: '此处的计算复杂度为 O(n^2)，当序列极长时会成为显存瓶颈。',
})
assert('Comment: itemType is annotation', commentPayload.itemType === 'annotation')
assert('Comment: default color is #ff6666', commentPayload.annotationColor === '#ff6666')
assert('Comment: comment text captured', commentPayload.annotationComment?.includes('O(n^2)'))

// 1.4 Mock Zotero Local API client roundtrip
let createItemsCalled = false
let capturedPayloads = []

const mockZoteroClient = {
  scoped() {
    return this
  },
  async getItem(key) {
    if (key === 'KEY_FUSION_001') {
      return {
        found: true,
        source: 'local',
        item: {
          key: 'KEY_FUSION_001',
          title: 'Attention Is All You Need',
          doi: '10.48550/arXiv.1706.03762',
          attachments: [
            { key: 'ATT_PDF_001', isPdf: true, title: '1706.03762.pdf' },
          ],
        },
        error: '',
        hint: '',
      }
    }
    return { found: false, source: 'none', item: null, error: 'Not found', hint: '' }
  },
  async createItems(items) {
    createItemsCalled = true
    capturedPayloads = items
    return {
      ok: true,
      source: 'local',
      successKeys: ['ZOTERO_ANNO_KEY_999'],
      failed: {},
      error: '',
      hint: '',
      raw: { success: { '0': 'ZOTERO_ANNO_KEY_999' } },
    }
  },
}

const mockTempDir = mkdtempSync(join(tmpdir(), 'dsh-e2e-zotero-proto-'))
try {
  const annotateRes = await annotateItem(mockZoteroClient, {
    itemKey: 'KEY_FUSION_001',
    type: 'highlight',
    text: 'Scaled dot-product attention scales dot products by 1/sqrt(d_k).',
    comment: '防止点积在大维度下数值过大导致 softmax 梯度极小。',
    workspaceDir: mockTempDir,
  })

  assert('Mock Local API: annotateItem returns ok=true', annotateRes.ok === true)
  assert('Mock Local API: client.createItems called', createItemsCalled === true)
  assert('Mock Local API: captured payload has parentItem=ATT_PDF_001 resolved automatically', capturedPayloads[0]?.parentItem === 'ATT_PDF_001')
  assert('Mock Local API: zoteroItemKey recorded', annotateRes.zoteroItemKey === 'ZOTERO_ANNO_KEY_999')
  assert('Mock Local API: citation title resolved', annotateRes.citation.title === 'Attention Is All You Need')
  assert('Mock Local API: citation doi resolved', annotateRes.citation.doi === '10.48550/arXiv.1706.03762')
} finally {
  rmSync(mockTempDir, { recursive: true, force: true })
}

console.log('')

// ============================================================================
// Suite 2: Local Workspace Markdown Note Card Creation & Incremental Append
// ============================================================================
console.log('── Suite 2: Markdown Literature Card Creation & Incremental Append ──')

const testWsDir = mkdtempSync(join(tmpdir(), 'dsh-e2e-notes-'))
try {
  // 2.1 First note: Card creation & initial file generation
  const resStep1 = appendMarkdownNote(
    {
      itemKey: 'PAPER_LLM_01',
      title: 'LLaMA: Open and Efficient Foundation Language Models',
      doi: '10.48550/arXiv.2302.13971',
      type: 'highlight',
      text: 'We show that it is possible to train state-of-the-art models using entirely publicly available datasets.',
      comment: '开源基础模型的里程碑工作，使用公开数据集达标。',
      color: '#ffd400',
      pageLabel: '1',
      tags: ['llama', 'open-source', 'foundation-models'],
      timestamp: '2026-09-18T14:30:00.000Z',
      zoteroKey: 'ZOTERO_NOTE_001',
    },
    { workspaceDir: testWsDir },
  )

  assert('Markdown Step 1: created flag is true', resStep1.created === true)
  assert('Markdown Step 1: default path is zotero-notes/PAPER_LLM_01.md', resStep1.filePath === 'zotero-notes/PAPER_LLM_01.md')

  const noteFile1 = join(testWsDir, resStep1.filePath)
  assert('Markdown Step 1: file exists on disk', existsSync(noteFile1))

  const contentStep1 = readFileSync(noteFile1, 'utf8')
  assert('Markdown Step 1: contains document header', contentStep1.includes('# 📚 文献笔记卡片'))
  assert('Markdown Step 1: contains paper title', contentStep1.includes('LLaMA: Open and Efficient Foundation Language Models'))
  assert('Markdown Step 1: contains DOI link', contentStep1.includes('10.48550/arXiv.2302.13971'))
  assert('Markdown Step 1: contains itemKey badge', contentStep1.includes('`PAPER_LLM_01`'))
  assert('Markdown Step 1: contains highlight quote', contentStep1.includes('entirely publicly available datasets'))
  assert('Markdown Step 1: contains commentary', contentStep1.includes('开源基础模型的里程碑工作'))
  assert('Markdown Step 1: contains tags', contentStep1.includes('`#llama`') && contentStep1.includes('`#foundation-models`'))
  assert('Markdown Step 1: contains zoteroKey link', contentStep1.includes('`ZOTERO_NOTE_001`'))

  // 2.2 Second note: Incremental append to existing card
  const resStep2 = appendMarkdownNote(
    {
      itemKey: 'PAPER_LLM_01',
      title: 'LLaMA: Open and Efficient Foundation Language Models',
      doi: '10.48550/arXiv.2302.13971',
      type: 'comment',
      comment: '关于 13B 规模超越 GPT-3 (175B) 的训练细节思考：高质量 tokens 数量至关重要。',
      color: '#ff6666',
      pageLabel: '3',
      tags: ['data-quality', 'scaling'],
      timestamp: '2026-09-18T14:45:00.000Z',
      zoteroKey: 'ZOTERO_NOTE_002',
    },
    { workspaceDir: testWsDir },
  )

  assert('Markdown Step 2: append to existing file returns created=false', resStep2.created === false)
  const contentStep2 = readFileSync(noteFile1, 'utf8')
  
  // Header should appear only once
  const headerCount = (contentStep2.match(/# 📚 文献笔记卡片/g) || []).length
  assert('Markdown Step 2: header is NOT duplicated (count=1)', headerCount === 1)
  assert('Markdown Step 2: retains first note', contentStep2.includes('entirely publicly available datasets'))
  assert('Markdown Step 2: appends second note', contentStep2.includes('关于 13B 规模超越 GPT-3'))
  assert('Markdown Step 2: second note zoteroKey present', contentStep2.includes('`ZOTERO_NOTE_002`'))

  // 2.3 Third note: Custom relative path
  const customPath = 'custom-research-notes/llama-critique.md'
  const resStep3 = appendMarkdownNote(
    {
      itemKey: 'PAPER_LLM_01',
      title: 'LLaMA: Open and Efficient Foundation Language Models',
      type: 'note',
      comment: '独立思考札记：开源生态的繁荣带动了微调和推理量化技术的井喷。',
    },
    { workspaceDir: testWsDir, markdownPath: customPath },
  )

  assert('Markdown Step 3: custom markdownPath respected', resStep3.filePath === customPath)
  assert('Markdown Step 3: custom path created=true', resStep3.created === true)
  assert('Markdown Step 3: custom file exists', existsSync(join(testWsDir, customPath)))
} finally {
  rmSync(testWsDir, { recursive: true, force: true })
}

console.log('')

// ============================================================================
// Suite 3: Agent-facing zotero_annotate Tool Scheduling & Dispatch Workflow
// ============================================================================
console.log('── Suite 3: Agent-Facing zotero_annotate Tool Scheduling & Dispatch ──')

const registeredTools = []
const mockContext = {
  tools: {
    register(tool) {
      registeredTools.push(tool)
    },
  },
}

const mockToolClient = {
  scoped() {
    return this
  },
  async getItem(key) {
    if (key === 'AGENT_PAPER_01') {
      return {
        found: true,
        source: 'local',
        item: {
          key: 'AGENT_PAPER_01',
          title: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning',
          doi: '10.5555/deepseek.r1.2025',
          attachments: [
            { key: 'PDF_R1_MAIN', isPdf: true, title: 'deepseek-r1.pdf' },
          ],
        },
        error: '',
        hint: '',
      }
    }
    return { found: false, source: 'none', item: null, error: 'Item not found', hint: '' }
  },
  async createItems(items) {
    return {
      ok: true,
      source: 'local',
      successKeys: ['AGENT_ANNO_007'],
      failed: {},
      error: '',
      hint: '',
      raw: { success: { '0': 'AGENT_ANNO_007' } },
    }
  },
}

// Register all tools
registerZoteroTools(mockContext, mockToolClient, {})

const annotateTool = registeredTools.find((t) => t.name === 'zotero_annotate')
assert('Tool Registration: zotero_annotate is registered', Boolean(annotateTool))
assert('Tool Registration: tool has description', typeof annotateTool.description === 'string' && annotateTool.description.includes('Zotero'))
assert('Tool Registration: concurrency safe is false', annotateTool.isConcurrencySafe() === false)

// Check parameters definition
const params = annotateTool.parameters?.properties || annotateTool.parameters
assert('Tool Parameters: itemKey defined', Boolean(params?.itemKey))
assert('Tool Parameters: type enum includes highlight/note/comment', 
  Array.isArray(params?.type?.enum) && 
  params.type.enum.includes('highlight') && 
  params.type.enum.includes('note') && 
  params.type.enum.includes('comment')
)
assert('Tool Parameters: text defined', Boolean(params?.text))
assert('Tool Parameters: comment defined', Boolean(params?.comment))
assert('Tool Parameters: color defined', Boolean(params?.color))
assert('Tool Parameters: pageLabel defined', Boolean(params?.pageLabel))
assert('Tool Parameters: markdownPath defined', Boolean(params?.markdownPath))
assert('Tool Parameters: exportMarkdown defined', Boolean(params?.exportMarkdown))
assert('Tool Parameters: syncToZotero defined', Boolean(params?.syncToZotero))

// Check output schema
const outProps = annotateTool.output?.schema?.properties
assert('Tool Output Schema: ok property is boolean', outProps?.ok?.type === 'boolean')
assert('Tool Output Schema: zoteroCreated is boolean', outProps?.zoteroCreated?.type === 'boolean')
assert('Tool Output Schema: zoteroItemKey is string', outProps?.zoteroItemKey?.type === 'string')
assert('Tool Output Schema: markdownSaved is boolean', outProps?.markdownSaved?.type === 'boolean')
assert('Tool Output Schema: markdownPath is string', outProps?.markdownPath?.type === 'string')
assert('Tool Output Schema: citation object defined', outProps?.citation?.type === 'object')

// Check presentCall UI representation
const cardPresent = annotateTool.presentCall({ itemKey: 'AGENT_PAPER_01', type: 'highlight' })
assert('Tool presentCall: returns UI title', cardPresent?.title?.includes('AGENT_PAPER_01') && cardPresent?.title?.includes('highlight'))
assert('Tool presentCall: card type is generic', cardPresent?.card === 'generic')

// Execute tool end-to-end via agent invocation simulation
const agentWsDir = mkdtempSync(join(tmpdir(), 'dsh-agent-dispatch-'))
try {
  // Test case 3.1: Standard full execution (both Zotero Local write and Markdown card export)
  const execResult = await annotateTool.execute(
    {
      itemKey: 'AGENT_PAPER_01',
      type: 'highlight',
      text: 'We demonstrate that reasoning behaviors can naturally emerge via pure RL without supervised warm-up.',
      comment: 'R1 核心洞见：冷启动监督微调非纯强化学习涌现推理的必要前提。',
      color: '#ffd400',
      pageLabel: '2',
      tags: ['deepseek', 'reasoning', 'rl'],
      workspaceDir: agentWsDir,
    },
    { signal: undefined },
  )

  assert('Tool Execution: result ok=true', execResult.ok === true)
  assert('Tool Execution: zoteroCreated is true', execResult.zoteroCreated === true)
  assert('Tool Execution: zoteroItemKey matches mock response', execResult.zoteroItemKey === 'AGENT_ANNO_007')
  assert('Tool Execution: markdownSaved is true', execResult.markdownSaved === true)
  assert('Tool Execution: citation title correctly populated', execResult.citation.title.includes('DeepSeek-R1'))
  assert('Tool Execution: citation doi correctly populated', execResult.citation.doi === '10.5555/deepseek.r1.2025')
  assert('Tool Execution: markdown file exists', existsSync(join(agentWsDir, execResult.markdownPath)) || existsSync(resolve(execResult.markdownPath)))

  // Test stripBySchema validation compliance
  const stripped = stripBySchema(execResult, annotateTool.output.schema)
  assert('Tool Schema Compliance: stripped output has ok property', stripped.ok === true)
  assert('Tool Schema Compliance: stripped output has itemKey', stripped.itemKey === 'AGENT_PAPER_01')
  assert('Tool Schema Compliance: stripped output has citation.title', stripped.citation?.title?.includes('DeepSeek-R1'))

  // Test case 3.2: syncToZotero=false (local markdown only)
  const execResultMdOnly = await annotateTool.execute(
    {
      itemKey: 'AGENT_PAPER_01',
      type: 'comment',
      comment: '纯本地笔记模式，无需同步远程 Zotero。',
      syncToZotero: false,
      workspaceDir: agentWsDir,
    },
    { signal: undefined },
  )
  assert('Tool Execution (MD only): ok=true', execResultMdOnly.ok === true)
  assert('Tool Execution (MD only): zoteroCreated=false', execResultMdOnly.zoteroCreated === false)
  assert('Tool Execution (MD only): markdownSaved=true', execResultMdOnly.markdownSaved === true)

  // Test case 3.3: exportMarkdown=false (zotero sync only)
  const execResultZoteroOnly = await annotateTool.execute(
    {
      itemKey: 'AGENT_PAPER_01',
      type: 'highlight',
      text: 'Rule-based reward system validates accuracy and formatting.',
      comment: '规则导向奖励函数。',
      exportMarkdown: false,
      syncToZotero: true,
      workspaceDir: agentWsDir,
    },
    { signal: undefined },
  )
  assert('Tool Execution (Zotero only): ok=true', execResultZoteroOnly.ok === true)
  assert('Tool Execution (Zotero only): zoteroCreated=true', execResultZoteroOnly.zoteroCreated === true)
  assert('Tool Execution (Zotero only): markdownSaved=false', execResultZoteroOnly.markdownSaved === false)
} finally {
  rmSync(agentWsDir, { recursive: true, force: true })
  try {
    rmSync(resolve('zotero-notes'), { recursive: true, force: true })
  } catch {}
}

console.log('')

// ============================================================================
// Suite 4: Frontend Artifact lib/client.js Integrity & Fusion UI Identifiers
// ============================================================================
console.log('── Suite 4: Frontend Artifact lib/client.js Integrity & UI Identifiers ──')

const clientJsPath = resolve('lib/client.js')
assert('Client Bundle: lib/client.js file exists', existsSync(clientJsPath))

const clientStat = statSync(clientJsPath)
assert('Client Bundle: size > 500KB (actual bundle with PDF reader)', clientStat.size > 500 * 1024, `(size: ${(clientStat.size / 1024).toFixed(1)} KB)`)

// Syntax check via Node -c
const syntaxCheck = spawnSync(process.execPath, ['-c', clientJsPath], { encoding: 'utf8' })
assert('Client Bundle: passes node -c syntax check', syntaxCheck.status === 0, syntaxCheck.stderr)

const clientContent = readFileSync(clientJsPath, 'utf8')

// Fusion Key Identifiers Check
assert('Fusion UI: contains floating Action Bar state (actionBar / setActionBar)', 
  clientContent.includes('actionBar') && clientContent.includes('setActionBar')
)
assert('Fusion UI: contains dshz-action-bar CSS class identifier',
  clientContent.includes('dshz-action-bar')
)
assert('Fusion UI: contains highlight execution function (applyHighlight)',
  clientContent.includes('applyHighlight')
)
assert('Fusion UI: contains PDF.js HighlightEditor & AnnotationElement integration',
  clientContent.includes('HighlightEditor') && clientContent.includes('HighlightAnnotationElement')
)
assert('Fusion UI: contains inline note taking popover (dshz-note-popover)',
  clientContent.includes('dshz-note-popover')
)
assert('Fusion UI: contains annotate API endpoint (/annotate / annotatePost)',
  clientContent.includes('/annotate') || clientContent.includes('annotatePost')
)
assert('Fusion UI: contains translation / bilingual reading integration (dshz-bubble / translate)',
  clientContent.includes('dshz-bubble') || clientContent.includes('translateTextSmart') || clientContent.includes('translateChunk')
)

console.log('\n======================================================================')
if (failed === 0) {
  console.log(`  🎉 ALL ${passed} VERIFICATION CHECKS PASSED!`)
  console.log('======================================================================\n')
  process.exit(0)
} else {
  console.error(`  ❌ VERIFICATION FAILED: ${failed} failed out of ${passed + failed} checks.`)
  console.log('======================================================================\n')
  process.exit(1)
}
