/**
 * dsh-zotero — PdfReader：pdf.js 自渲染阅读器 + 划词即时翻译。
 *
 * 渲染：getDocument(ArrayBuffer) → 分页 canvas + TextLayer（可选文本）；
 *       IntersectionObserver 懒渲染（视口 ±600px），缩放=fit-width × factor。
 * 划词：mouseup 取 selection →「译」浮钮 → POST /translate（host 缓存+上下文）
 *       → 气泡译文；长文 Intl.Segmenter 分块并发；AbortController 取消旧请求。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist'
import {
  API,
  fetchTranslateTargetLang,
  translateTextSmart,
  pdf2zhStart,
  pdf2zhStatus,
  pdf2zhCancel,
  pdf2zhFileUrl,
  type Pdf2zhJob,
  annotatePost,
  fetchAnnotations,
} from './api'
import { dispatchChatOpen } from './ChatWindow'
import { ContrastView } from './ContrastView'

// worker 由 host 静态提供（panel-api GET /pdfjs-worker）；失败时 pdfjs 自动降级主线程。
GlobalWorkerOptions.workerSrc = `${API}/pdfjs-worker`

const PAGE_GAP = 14
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const RENDER_MARGIN = 700 // px，视口外多少范围内保持渲染

export interface AnnotationItem {
  id: string
  itemKey?: string
  attachmentKey?: string
  type: 'highlight' | 'note' | 'comment'
  color: string // 如 '#ffd400', '#51cf66', '#ff6b6b', '#339af0'
  text: string
  comment?: string
  page: number
  rects?: Array<{ left: number; top: number; width: number; height: number }>
  createdAt: number
}

const HIGHLIGHT_COLORS = [
  { name: '黄', color: '#ffd400', label: '重点' },
  { name: '绿', color: '#51cf66', label: '方法' },
  { name: '红', color: '#ff6b6b', label: '疑问' },
  { name: '蓝', color: '#339af0', label: '定义' },
]

interface PdfReaderProps {
  attachmentKey: string
  itemKey?: string
  title?: string
  /** 返回列表（沉浸阅读时由外部提供；无则不显示该按钮）。 */
  onBack?: () => void
}

/** 一键全文翻译（pdf2zh 官方引擎 → 双语 PDF，页内 iframe 呈现）。 */
export function FullTranslatePanel(props: { itemKey: string; attachmentKey: string; onBack: () => void }): JSX.Element {
  const [job, setJob] = useState<Pdf2zhJob | null>(null)
  const [configured, setConfigured] = useState(true)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    void pdf2zhStart(props.itemKey, props.attachmentKey)
      .then((r) => {
        if (cancelled) return
        if (r.job) setJob(r.job)
        if (!r.ok && !r.job) setConfigured(false)
      })
      .catch(() => { /* 尽力而为 */ })
    const stopWhenSettled = (j: Pdf2zhJob | null): void => {
      if (j && ['done', 'error', 'cancelled'].includes(j.state)) {
        if (timer !== undefined) window.clearInterval(timer)
      }
    }
    timer = window.setInterval(() => {
      void pdf2zhStatus(props.attachmentKey)
        .then((r) => {
          if (cancelled) return
          setConfigured(r.configured)
          if (r.job) { setJob(r.job); stopWhenSettled(r.job) }
        })
        .catch(() => { /* 尽力而为 */ })
    }, 2000)
    return () => { cancelled = true; if (timer !== undefined) window.clearInterval(timer) }
  }, [props.itemKey, props.attachmentKey])

  /** 视图切换：dual=双语对照(默认) / mono=译文版 / original=原文版 / side=左右对照。 */
  const [view, setView] = useState<'dual' | 'mono' | 'original' | 'side'>('side')

  const running = job?.state === 'running'
  const done = job?.state === 'done'
  // 从 pdf2zh 进度输出解析页码：pdf2zh-page 12/56
  const pageM = /pdf2zh-page\s+(\d+)\s*\/\s*(\d+)/.exec(job?.progress ?? '')
  const pageNo = pageM ? Number(pageM[1]) : 0
  const pageTotal = pageM ? Number(pageM[2]) : 0
  const pct = done ? 100 : pageTotal > 0 ? Math.round((pageNo / pageTotal) * 100) : 0

  const fileSrc = (): string => {
    if (view === 'mono') return pdf2zhFileUrl(props.attachmentKey, 'mono')
    if (view === 'original') return `${API}/pdf?key=${encodeURIComponent(props.attachmentKey)}`
    return pdf2zhFileUrl(props.attachmentKey)
  }

  return (
    <div className="dshz-ft">
      <div className="dshz-ft-head">
        <div className="row1">
          <button className="dshz-btn" onClick={props.onBack}>← PDF</button>
          <span className="pg">{running ? (pageTotal > 0 ? `翻译中 ${pageNo}/${pageTotal} 页` : '正在翻译…') : done ? '✅ 已生成' : ''}</span>
          {running ? (
            <button className="dshz-btn" onClick={() => void pdf2zhCancel(props.attachmentKey)}>取消</button>
          ) : null}
          {done ? (
            <a className="dshz-btn primary" href={pdf2zhFileUrl(props.attachmentKey)} download>下载双语 PDF</a>
          ) : null}
          {done ? (
            <a className="dshz-btn" href={`${API}/pdf2zh/file?attachmentKey=${encodeURIComponent(props.attachmentKey)}&type=mono`} download>下载译文版</a>
          ) : null}
          {done ? (
            <div className="dshz-seg">
              {([
                ['side', '左右对照'],
                ['original', '英文版'],
                ['mono', '中文版'],
                ['dual', '上下对照'],
              ] as const).map(([id, label]) => (
                <button key={id} className={view === id ? 'on' : ''} onClick={() => setView(id)}>{label}</button>
              ))}
            </div>
          ) : null}
        </div>
        {running ? (
          <div className="dshz-ft-progress">
            <div className="fill" style={{ width: `${pageTotal > 0 ? pct : 100}%`, animation: pageTotal > 0 ? 'none' : 'dshz-stripe 1.2s linear infinite' }} />
          </div>
        ) : null}
        {running && job?.progress ? <div className="dshz-note" style={{ fontFamily: 'monospace', maxHeight: 44, overflow: 'hidden' }}>{(job.progress.split(/[\r\n]+/).pop() ?? '').slice(-90)}</div> : null}
        {!configured ? (
          <div className="dshz-note" style={{ color: '#FF9F0A' }}>
            ⚠ 未配置 pdf2zh API Key —— 前往「设置 → PDF2ZH 翻译引擎」填写 OpenAI 兼容 Key（如 DeepSeek）后重试。
          </div>
        ) : null}
        {job?.state === 'error' || job?.state === 'cancelled' ? (
          <div className="dshz-note" style={{ color: '#FF8B84' }}>
            {job.state === 'cancelled' ? '任务已取消。' : `失败：${job.error || '未知错误'}`}
            {' '}可重新点击「全文翻译」重试。
          </div>
        ) : null}
      </div>
      {/* 产出预览：三视图切换（原/译文/双语均走 PDF 流） */}
      <div className="dshz-ft-body">
        {!job || running ? (
          <div className="dshz-null" style={{ paddingTop: 40 }}>
            <span className="dshz-spin" style={{ display: 'inline-block', margin: '0 auto 10px', width: 18, height: 18, color: 'var(--ios-blue)' }} />
            <div>{pageTotal > 0 ? `正在翻译第 ${pageNo}/${pageTotal} 页…` : running ? 'pdf2zh 正在翻译（模型加载 / 版面分析 / 分块 / LLM 翻译）…' : '正在启动…'}</div>
            <div style={{ marginTop: 6, fontSize: 11 }}>{pageTotal > 0 ? '' : '首次运行需下载 DocLayout 模型（约 200MB，仅一次）'}</div>
          </div>
        ) : done && view === 'side' ? (
          <ContrastView
            originalUrl={`${API}/pdf?key=${encodeURIComponent(props.attachmentKey)}`}
            monoUrl={pdf2zhFileUrl(props.attachmentKey, 'mono')}
          />
        ) : done ? (
          <iframe
            key={view}
            title={view === 'dual' ? '双语对照' : view === 'mono' ? '中文版' : '原文版'}
            src={fileSrc()}
            style={{ flex: 1, width: '100%', border: 0, background: '#111' }}
          />
        ) : (
          <div className="dshz-null" style={{ paddingTop: 40 }}>{job?.error || '未开始'}</div>
        )}
      </div>
    </div>
  )
}

export function PdfReader(props: PdfReaderProps): JSX.Element {
  const { attachmentKey, itemKey, onBack } = props

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const pageElsRef = useRef<Map<number, HTMLDivElement>>(new Map())
  const pageCacheRef = useRef<Map<number, PDFPageProxy>>(new Map())
  const renderedRef = useRef<Set<number>>(new Set())
  const abortRef = useRef<AbortController | null>(null)

  const [err, setErr] = useState('')
  const [numPages, setNumPages] = useState(0)
  const [baseW, setBaseW] = useState(0) // page1 的 pt 宽度（scale=1）
  const [baseH, setBaseH] = useState(0) // page1 的 pt 高度（scale=1，实测页比例用）
  /** 已渲染页的真实高度（覆盖占位估计；避免滚动跳动）。 */
  const [renderedH, setRenderedH] = useState<Record<number, number>>({})
  const [pageW, setPageW] = useState(0) // 容器可用宽度 px（fit-width 基准）
  const [factor, setFactor] = useState(1)
  const [current, setCurrent] = useState(1)
  const [targetLang, setTargetLang] = useState('zh')
  const [ftView, setFtView] = useState(false)
  /** 该附件是否已有 pdf2zh 产物（决定按钮文案与行为）。 */
  const [hasOutput, setHasOutput] = useState(false)

  // 打开阅读器即检测产物：已有译文的论文 →「📄 双语阅读」（秒进对照/切换视图）
  useEffect(() => {
    let cancelled = false
    void pdf2zhStatus(attachmentKey)
      .then((r) => { if (!cancelled) setHasOutput(r.job?.state === 'done' || Boolean(r.job?.files?.dual)) })
      .catch(() => { /* 尽力而为 */ })
    return () => { cancelled = true }
  }, [attachmentKey])

  // 划词状态
  const [selText, setSelText] = useState('')
  const [selBtn, setSelBtn] = useState<{ x: number; y: number; bottom: number } | null>(null)
  const [translating, setTranslating] = useState(false)
  const [bubble, setBubble] = useState<{ x: number; y: number; text?: string; error?: string } | null>(null)

  const scale = useMemo(() => (baseW > 0 && pageW > 0 ? (pageW / baseW) * factor : factor), [baseW, pageW, factor])
  // fit-width：页面高 = 页面宽 × 实测页比例（不再用 A4 近似，避免滚动/占位失真）
  const pageH = useMemo(
    () => (pageW > 0 && baseH > 0 && baseW > 0 ? (pageW * (baseH / baseW)) * factor : 800),
    [pageW, baseW, baseH, factor],
  )

  const scaleRef = useRef(scale); scaleRef.current = scale
  const factorRef = useRef(factor); factorRef.current = factor
  const pageWRef = useRef(pageW); pageWRef.current = pageW
  const pageHRef = useRef(pageH); pageHRef.current = pageH
  const numPagesRef = useRef(numPages); numPagesRef.current = numPages
  const selTextRef = useRef(selText); selTextRef.current = selText
  const selBtnRef = useRef(selBtn); selBtnRef.current = selBtn

  /* ── 装载 PDF + 目标语言 ── */
  useEffect(() => {
    let cancelled = false
    let task: { destroy(): void } | null = null
    void fetchTranslateTargetLang().then(setTargetLang).catch(() => {})
    void (async () => {
      try {
        const res = await fetch(`${API}/pdf?key=${encodeURIComponent(attachmentKey)}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.arrayBuffer()
        task = getDocument({ data })
        const d = await task.promise
        if (cancelled) { try { d.destroy() } catch { /* noop */ } return }
        docRef.current = d
        setNumPages(d.numPages)
        // 页比例采样：取 1/2/3/中位页的中位数（避免封面/特殊页污染占位高度）
        const samples: Array<{ w: number; ratio: number }> = []
        const idxs = [1, 2, Math.min(3, d.numPages), Math.min(Math.ceil(d.numPages / 2), d.numPages)]
        for (const idx of idxs) {
          try {
            const p = await d.getPage(idx)
            const v = p.getViewport({ scale: 1 })
            if (v.width > 0) samples.push({ w: v.width, ratio: v.height / v.width })
          } catch { /* skip */ }
        }
        samples.sort((a, b) => a.ratio - b.ratio)
        const mid = samples[Math.floor(samples.length / 2)] ?? samples[0]
        if (mid) {
          setBaseW(mid.w)
          setBaseH(mid.w * mid.ratio)
        }
        // 等待布局后量容器宽（首次渲染时 scrollRef 已有）
        requestAnimationFrame(() => {
          const el = scrollRef.current
          if (!el) return
          const w = el.clientWidth - 28 // padding 14*2
          if (w >= 120) setPageW(w)
        })
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e))
      } finally {
        if (!cancelled) setErr((s) => s) // keep flow; loading handled by numPages
        if (cancelled) { try { task?.destroy() } catch { /* noop */ } }
      }
    })()
    return () => {
      cancelled = true
      try { task?.destroy() } catch { /* noop */ }
      try { docRef.current?.destroy() } catch { /* noop */ }
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentKey])

  /* ── 容器宽度跟踪 ── */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth - 28
      if (w >= 120) setPageW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* ── 单页渲染（canvas + 文本层） ── */
  const renderPage = useCallback(async (i: number): Promise<void> => {
    const d = docRef.current
    const el = pageElsRef.current.get(i)
    if (!d || !el || renderedRef.current.has(i)) return
    renderedRef.current.add(i)
    try {
      let page = pageCacheRef.current.get(i)
      if (!page) {
        page = await d.getPage(i)
        pageCacheRef.current.set(i, page)
      }
      const vp = page.getViewport({ scale: scaleRef.current })
      const canvas = el.querySelector('canvas') as HTMLCanvasElement | null
      const tl = el.querySelector('.tl') as HTMLDivElement | null
      if (!canvas || !tl) return
      if (pageCacheRef.current.size > 12) {
        // 简单 LRU：清理最旧的缓存页（渲染页仍保留，翻回时重新 getPage）
        const firstKey = pageCacheRef.current.keys().next().value
        if (firstKey !== undefined) pageCacheRef.current.delete(firstKey)
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(vp.width * dpr)
      canvas.height = Math.floor(vp.height * dpr)
      canvas.style.width = `${vp.width}px`
      canvas.style.height = `${vp.height}px`
      // 校准页 div 高度为真实渲染高度（占位估计 → 精确，消除滚动跳动）
      setRenderedH((prev) => (prev[i] === vp.height ? prev : { ...prev, [i]: vp.height }))
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const task = page.render({
        canvasContext: ctx,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      })
      try {
        await task.promise
      } catch (e: any) {
        if (e?.name === 'RenderingCancelledException') return
        throw e
      }
      tl.innerHTML = ''
      try {
        const textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp })
        await textLayer.render()
      } catch (te: any) {
        console.warn('[dsh-zotero PdfReader] textLayer failed', i, String(te?.message ?? te))
        throw te
      }
    } catch (e: any) {
      renderedRef.current.delete(i)
      console.warn('[dsh-zotero PdfReader] page render failed', i, String(e?.message ?? e))
    }
  }, [])

  /* ── 懒渲染：单 IO 触发（回收改 onScroll 节流，避免双观察者竞态） ── */
  useEffect(() => {
    if (!numPages || !baseW || !pageW) return
    const root = scrollRef.current
    if (!root) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const el = en.target as HTMLElement
          const i = Number(el.dataset.page)
          if (en.isIntersecting) void renderPage(i)
        }
      },
      { root, rootMargin: `${RENDER_MARGIN}px 0px` },
    )
    for (let i = 1; i <= numPages; i++) {
      const el = pageElsRef.current.get(i)
      if (el) io.observe(el)
    }
    return () => io.disconnect()
  }, [numPages, baseW, pageW, renderPage])

  /* ── 缩放变化 → 全量重渲染 ── */
  useEffect(() => {
    if (!numPages) return
    renderedRef.current.clear()
    pageCacheRef.current.clear()
    setRenderedH({})
    for (const el of pageElsRef.current.values()) {
      const canvas = el.querySelector('canvas') as HTMLCanvasElement | null
      const tl = el.querySelector('.tl') as HTMLDivElement | null
      if (canvas) { canvas.width = 0; canvas.height = 0 }
      if (tl) tl.innerHTML = ''
    }
    const lo = Math.max(1, current - 1)
    const hi = Math.min(numPages, current + 1)
    for (let i = lo; i <= hi; i++) void renderPage(i)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factor, pageW])

  /* ── 滚动联动 / 关闭浮层 / 远页回收（400ms 节流） ── */
  const rcAtRef = useRef(0)
  function onScroll(): void {
    const el = scrollRef.current
    if (el) {
      const h = pageHRef.current + PAGE_GAP
      const n = Math.floor(el.scrollTop / h) + 1
      setCurrent((prev) => (prev === n ? prev : Math.min(Math.max(1, n), numPagesRef.current)))
      // 回收远离视口的已渲染页（防内存膨胀 + 减少重绘闪烁）
      const now = Date.now()
      if (now - rcAtRef.current >= 400) {
        rcAtRef.current = now
        const vh = el.clientHeight
        for (const i of [...renderedRef.current]) {
          const pageTop = (i - 1) * h
          if (Math.abs(pageTop - el.scrollTop) > vh + RENDER_MARGIN * 2.5) {
            const pageEl = pageElsRef.current.get(i)
            if (pageEl) {
              const canvas = pageEl.querySelector('canvas') as HTMLCanvasElement | null
              const tl = pageEl.querySelector('.tl') as HTMLDivElement | null
              if (canvas) { canvas.width = 0; canvas.height = 0 }
              if (tl) tl.innerHTML = ''
            }
            renderedRef.current.delete(i)
            pageCacheRef.current.delete(i)
            setRenderedH((prev) => {
              if (!(i in prev)) return prev
              const nx = { ...prev }
              delete nx[i]
              return nx
            })
          }
        }
      }
    }
    setSelBtn(null)
    setBubble(null)
  }

  function goPage(n: number): void {
    const el = scrollRef.current
    setCurrent(Math.min(Math.max(1, n), numPages))
    if (el) {
      el.scrollTo({ top: Math.max(0, (n - 1) * (pageHRef.current + PAGE_GAP)), behavior: 'smooth' })
    }
  }

  function zoom(delta: number): void {
    setFactor((f) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(f + delta).toFixed(2))))
  }

  /* ── 划词 ── */
  function onMouseUp(): void {
    setTimeout(() => {
      const sel = window.getSelection()
      const anchor = sel?.anchorNode
      if (!sel || sel.isCollapsed || !anchor || !scrollRef.current?.contains(anchor)) {
        setSelBtn(null)
        setSelText('')
        return
      }
      const text = sel.toString().replace(/\s+/g, ' ').trim()
      if (!text || text.length > 8000) {
        setSelBtn(null)
        setSelText('')
        return
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      setSelText(text)
      setSelBtn({ x: rect.left + rect.width / 2, y: rect.top, bottom: rect.bottom })
      setBubble(null)
    }, 12)
  }

  async function doTranslate(): Promise<void> {
    const text = selTextRef.current
    const pos = selBtnRef.current
    if (!text || !pos) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setTranslating(true)
    setBubble({ x: pos.x, y: pos.bottom + 10 })
    try {
      const result = await translateTextSmart(text, itemKey, targetLang, ctrl.signal)
      setBubble({ x: pos.x, y: pos.bottom + 10, text: result })
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      setBubble({ x: pos.x, y: pos.bottom + 10, error: String(e?.message ?? e) })
    } finally {
      setTranslating(false)
    }
  }

  function closeOverlays(): void {
    setSelBtn(null)
    setSelText('')
    setBubble(null)
    abortRef.current?.abort()
  }

  /* ── 渲染 ── */
  if (err) {
    return (
      <div className="dshz-pdf-loading" style={{ position: 'static', background: 'var(--ios-bg)' }}>
        <span className="t">PDF 加载失败：{err}</span>
      </div>
    )
  }
  return (
    <div className="dshz-pdf-reader" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* 阅读器工具条（进入翻译面板后隐藏——按钮合并进翻译栏，避免双栏冗余） */}
      {!ftView ? (
        <div className="dshz-pdf-toolbar">
          {onBack ? <button className="dshz-btn" onClick={onBack} title="返回列表">← 列表</button> : null}
          <button className="dshz-btn" onClick={() => goPage(Math.max(1, current - 1))} disabled={numPages === 0 || current <= 1} title="上一页">‹</button>
          <span className="pg">{numPages ? `${current} / ${numPages}` : '…'}</span>
          <button className="dshz-btn" onClick={() => goPage(Math.min(numPages, current + 1))} disabled={numPages === 0 || current >= numPages} title="下一页">›</button>
          <button className="dshz-btn" onClick={() => zoom(-0.1)} disabled={numPages === 0} title="缩小">−</button>
          <span className="pg">{Math.round(factor * 100)}%</span>
          <button className="dshz-btn" onClick={() => zoom(0.1)} disabled={numPages === 0} title="放大">+</button>
          <span style={{ flex: 1 }} />
          <button
            className="dshz-btn primary"
            title={hasOutput ? '查看该论文的中英对照（已有译文）' : '一键翻译全文（生成中英对照）'}
            disabled={!itemKey}
            onClick={() => setFtView(true)}
          >{hasOutput ? '📄 双语阅读' : '📄 全文翻译'}</button>
          <button className="dshz-btn" title="下载原 PDF（在浏览器中打开）" onClick={() => { window.open(`${API}/pdf?key=${encodeURIComponent(attachmentKey)}`, '_blank') }}>⬇ 原 PDF</button>
          <button className="dshz-btn" title="在 Zotero 阅读器打开" onClick={() => { void fetch(`${API}/open?key=${encodeURIComponent(attachmentKey)}&target=zotero`).catch(() => {}) }}>Zotero</button>
        </div>
      ) : null}
      {/* 划词翻译浮钮 */}
      {selBtn && !translating && !bubble?.text && !bubble?.error ? (
        <button className="dshz-sel" style={{ left: selBtn.x, top: selBtn.y }} onClick={() => void doTranslate()}>
          译
        </button>
      ) : null}
      {translating ? (
        <div className="dshz-bubble" style={{ left: selBtn?.x ?? 0, top: (selBtn?.bottom ?? 0) + 10 }}>
          <div className="bar"><span className="lang">翻译中…</span></div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="dshz-spin" /> 正在翻译选中文本</div>
        </div>
      ) : null}
      {/* 译文气泡 */}
      {bubble?.text || bubble?.error ? (
        <div className="dshz-bubble" style={{ left: bubble.x, top: bubble.y }}>
          <div className="bar">
            <span className="lang">译 → {targetLang}</span>
            {bubble.text ? (
              <button className="dshz-btn" onClick={() => void navigator.clipboard.writeText(String(bubble.text ?? '')).catch(() => {})}>复制</button>
            ) : null}
            <button className="dshz-btn" onClick={closeOverlays}>关闭</button>
          </div>
          {bubble.error ? <div style={{ color: '#FF8B84' }}>{bubble.error}</div> : null}
          {bubble.text ? <div className="txt">{bubble.text}</div> : null}
        </div>
      ) : null}
      {/* 全文翻译对照视图 / 滚动页面区 */}
      {ftView && itemKey ? (
        <FullTranslatePanel itemKey={itemKey} attachmentKey={attachmentKey} onBack={() => setFtView(false)} />
      ) : (
        <div className="dshz-pdf-scroll" ref={scrollRef} onMouseUp={onMouseUp} onScroll={onScroll} onBlur={closeOverlays}>
        {(!numPages || pageW < 120) && !err ? (
          <div className="dshz-pdf-loading" style={{ position: 'static', minHeight: 320 }}>
            <span className="dshz-spin" style={{ width: 20, height: 20, color: 'var(--ios-blue)' }} />
            <span className="t">正在加载 PDF…</span>
          </div>
        ) : null}
        {numPages > 0 && pageW >= 120 ? (
          Array.from({ length: numPages }, (_v, idx) => {
            const i = idx + 1
            const w = Math.max(120, pageW * factor)
            return (
              <div
                key={i}
                className="dshz-pdf-page"
                data-page={i}
                style={{ width: `${w}px`, height: `${Math.round(renderedH[i] ?? pageH)}px` }}
                ref={(el) => {
                  if (el) pageElsRef.current.set(i, el)
                  else pageElsRef.current.delete(i)
                }}
              >
                <canvas />
                <div className="tl" />
              </div>
            )
          })
        ) : null}
        </div>
      )}
    </div>
  )
}
