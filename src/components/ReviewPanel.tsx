import { useEffect, useId, useRef, useState } from 'react'
import { Check, CheckCheck, ChevronRight, CircleHelp, Clock3, FileText, ShieldCheck, X } from 'lucide-react'
import './review.css'

export type ReviewDecision = 'issue' | 'clear' | 'recheck'

export type ReviewSubmission = {
  decisions: Record<string, ReviewDecision>
  uncheckedIds: string[]
  total: number
}

type ReviewPanelProps = {
  onClose: () => void
  onSubmit: (submission: ReviewSubmission) => void
}

type ReviewCase = {
  id: string
  title: string
  category: string
  summary: string
  input: string
  output: string
  standard: string
  finding: string
  sampledPass?: boolean
  trace: { time: string; action: string; detail: string; warning?: boolean }[]
}

const reviewCases: ReviewCase[] = [
  {
    id: 'CS-014',
    title: '告知已提交，实际未创建申请',
    category: '结果真实性',
    summary: '工具调用超时后，客服仍回复「退货申请已提交」。',
    input: '这双鞋尺码不合适，我想退货。订单号是 208614。',
    output: '已经为您提交退货申请，请留意后续的审核通知。',
    standard: '只有售后系统确认创建成功，才能告知用户申请已提交；失败时应说明当前状态并提供下一步。',
    finding: '创建接口返回 REQUEST_TIMEOUT；测试后台中未查询到新申请，回复却承诺已提交。',
    trace: [
      { time: '00:00.4', action: '查询订单', detail: '订单 208614 · 已签收 2 天 · 支持退货' },
      { time: '00:01.2', action: '创建售后申请', detail: 'REQUEST_TIMEOUT · 调用超时', warning: true },
      { time: '00:01.9', action: '生成客服回复', detail: '「已经为您提交退货申请」', warning: true },
      { time: '00:02.1', action: '核对测试后台', detail: '该订单新增售后申请：0 条' },
    ],
  },
  {
    id: 'CS-027',
    title: '同一订单重复创建售后',
    category: '重复请求',
    summary: '用户重复确认退货时，生成了两张有效售后单。',
    input: '刚刚好像卡住了。你再帮我提交一下退货吧。',
    output: '好的，已重新为您提交退货申请。',
    standard: '重复请求应优先查询已有售后状态，同一订单的相同诉求不能重复创建有效申请。',
    finding: '测试订单中已有处理中申请 R-3101；本轮继续创建 R-3102，两张申请同时有效。',
    trace: [
      { time: '00:00.3', action: '载入对话上下文', detail: '前一轮已成功创建 R-3101' },
      { time: '00:00.8', action: '创建售后申请', detail: '新申请 R-3102 · 创建成功', warning: true },
      { time: '00:01.5', action: '核对测试后台', detail: '同一订单存在 2 张有效退货申请', warning: true },
    ],
  },
  {
    id: 'CS-032',
    title: '超期订单未核实特殊政策',
    category: '政策理解',
    summary: '出现质量问题时，仅按七天无理由期限直接拒绝。',
    input: '买了 12 天的电水壶突然漏水了，还能申请售后吗？',
    output: '非常抱歉，商品已超过七天无理由退货期限，无法申请售后。',
    standard: '区分无理由退货与质量问题售后；涉及质量问题时，应查询适用政策并确认必要信息。',
    finding: '演示政策规定质量问题可在 30 天内申请核验；运行记录未显示政策查询或质量问题追问。',
    trace: [
      { time: '00:00.5', action: '识别诉求', detail: '退货咨询 · 商品已签收 12 天' },
      { time: '00:01.0', action: '检索政策', detail: '命中七天无理由条款；未查询质量售后条款', warning: true },
      { time: '00:01.8', action: '生成客服回复', detail: '直接拒绝售后申请', warning: true },
    ],
  },
  {
    id: 'CS-041',
    title: '接口超时后缺少结果核查',
    category: '异常处理',
    summary: '调用超时，但未进一步确认申请是否实际创建。',
    input: '帮我申请换货，还是换同一个颜色。',
    output: '提交失败了，您稍后再试一下。',
    standard: '创建请求超时后，应查询最终状态或明确说明结果待确认，避免引导用户重复提交。',
    finding: '调用记录显示超时，当前材料缺少后台最终状态。需要核查申请是否已落库。',
    trace: [
      { time: '00:00.6', action: '创建换货申请', detail: '请求已发送 · request_id: demo-041' },
      { time: '00:10.6', action: '等待接口返回', detail: 'REQUEST_TIMEOUT · 结果未知', warning: true },
      { time: '00:11.0', action: '生成客服回复', detail: '告知提交失败，未补查最终状态', warning: true },
    ],
  },
  {
    id: 'CS-056',
    title: '转人工后未传递问题摘要',
    category: '人工兜底',
    summary: '成功进入人工队列，但工单缺少订单与问题信息。',
    input: '退款一直没到账，我已经问过两次了，帮我找人工。',
    output: '已为您转接人工客服，请稍等。',
    standard: '转人工时，应传递已知订单、用户诉求与已执行步骤，避免用户重复描述。',
    finding: '转人工接口返回成功，工单中的 order_id 和 summary 均为空；当前会话已包含这些信息。',
    trace: [
      { time: '00:00.4', action: '识别升级请求', detail: '退款未到账 · 用户明确要求人工介入' },
      { time: '00:01.1', action: '创建人工工单', detail: '队列接收成功 · order_id、summary 为空', warning: true },
      { time: '00:01.8', action: '生成客服回复', detail: '告知已转人工' },
    ],
  },
  {
    id: 'CS-063',
    title: '正常退货流程抽查',
    category: '通过样本抽查',
    summary: '核实订单、创建申请、说明后续步骤，系统判定通过。',
    input: '这件外套不合适，我昨天刚收到，可以退吗？',
    output: '您的订单符合退货条件，申请已提交。审核通过后会通知您寄回方式，请先保留商品及包装。',
    standard: '核实退货条件，确认创建结果，并准确说明用户接下来需要做什么。',
    finding: '政策查询、接口结果与回复一致；测试后台存在对应有效申请。本例用于检查自动打分是否遗漏问题。',
    sampledPass: true,
    trace: [
      { time: '00:00.5', action: '查询订单与政策', detail: '已签收 1 天 · 符合退货条件' },
      { time: '00:01.3', action: '创建售后申请', detail: '申请 R-3118 · 创建成功' },
      { time: '00:02.0', action: '核对测试后台', detail: '申请有效 · 订单和退货商品一致' },
      { time: '00:02.3', action: '生成客服回复', detail: '说明当前状态、审核和寄回步骤' },
    ],
  },
]

const decisionLabels: Record<ReviewDecision, string> = {
  issue: '确认有问题',
  clear: '判定无问题',
  recheck: '不确定，再核查',
}

export default function ReviewPanel({ onClose, onSubmit }: ReviewPanelProps) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const allRef = useRef<HTMLInputElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState(reviewCases[0].id)
  const [decisions, setDecisions] = useState<Record<string, ReviewDecision>>({})
  const [announcement, setAnnouncement] = useState('')
  const activeCase = reviewCases.find((item) => item.id === activeId) ?? reviewCases[0]
  const decidedCount = Object.keys(decisions).length
  const unmarkedCount = reviewCases.length - decidedCount
  const recheckCount = Object.values(decisions).filter((value) => value === 'recheck').length

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex="0"]',
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = selectedIds.size > 0 && selectedIds.size < reviewCases.length
  }, [selectedIds])

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const judgeCase = (id: string, decision: ReviewDecision) => {
    setDecisions((current) => ({ ...current, [id]: decision }))
    setAnnouncement(`${id} 已标记为${decisionLabels[decision]}`)
  }

  const judgeSelected = (decision: ReviewDecision) => {
    setDecisions((current) => {
      const next = { ...current }
      selectedIds.forEach((id) => { next[id] = decision })
      return next
    })
    setAnnouncement(`已将 ${selectedIds.size} 项标记为${decisionLabels[decision]}`)
  }

  const submit = () => {
    onSubmit({
      decisions: { ...decisions },
      uncheckedIds: reviewCases.filter((item) => !decisions[item.id]).map((item) => item.id),
      total: reviewCases.length,
    })
  }

  return (
    <div className="review-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} className="review-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <header className="review-header">
          <div className="review-title-icon"><CheckCheck size={24} strokeWidth={1.6} /></div>
          <div className="review-header-copy">
            <div className="review-eyebrow">HUMAN REVIEW <span>ROUND 003</span></div>
            <div className="review-heading-line"><h2 id={titleId}>一起核查这些案例</h2><span className="review-demo-badge">演示数据</span></div>
            <p id={descriptionId}>5 项候选问题，1 项通过样本抽查。可以逐项判断，也可以批量处理。</p>
          </div>
          <button ref={closeRef} className="review-icon-button" onClick={onClose} aria-label="关闭批量复核"><X size={19} /></button>
        </header>

        <div className="review-toolbar">
          <label className="review-select-all"><input ref={allRef} type="checkbox" checked={selectedIds.size === reviewCases.length} onChange={() => setSelectedIds(selectedIds.size === reviewCases.length ? new Set() : new Set(reviewCases.map((item) => item.id)))} /><span>{selectedIds.size ? `已选 ${selectedIds.size} 项` : '全选案例'}</span></label>
          <span className="review-toolbar-divider" />
          <div className="review-bulk-actions" aria-label="批量判定">
            <button className="is-issue" disabled={!selectedIds.size} onClick={() => judgeSelected('issue')}><Check size={16} />确认有问题</button>
            <button className="is-clear" disabled={!selectedIds.size} onClick={() => judgeSelected('clear')}><X size={16} />判定无问题</button>
            <button className="is-recheck" disabled={!selectedIds.size} onClick={() => judgeSelected('recheck')}><CircleHelp size={16} />不确定</button>
          </div>
          <div className="review-completion"><span>已判断 <strong>{decidedCount}</strong> / {reviewCases.length}</span><div className="review-completion-track" aria-hidden="true"><span style={{ width: `${decidedCount / reviewCases.length * 100}%` }} /></div></div>
        </div>

        <div className="review-content">
          <aside className="review-case-list" aria-label="待复核案例">
            <div className="review-list-heading"><span>本批案例</span><span>{reviewCases.length} CASES</span></div>
            {reviewCases.map((item) => (
              <div key={item.id} className={`review-case-row ${activeId === item.id ? 'is-active' : ''}`}>
                <input type="checkbox" className="review-case-checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelected(item.id)} aria-label={`选择 ${item.id} ${item.title}`} />
                <button className="review-case-button" onClick={() => setActiveId(item.id)} aria-pressed={activeId === item.id}>
                  <span className="review-case-meta"><span>{item.id}</span><span className={item.sampledPass ? 'review-sample-label' : ''}>{item.category}</span></span>
                  <strong>{item.title}</strong>
                  <span className={`review-case-status ${decisions[item.id] ? `is-${decisions[item.id]}` : ''}`}>
                    {decisions[item.id] ? <Check size={12} /> : <span className="review-status-dot" />}
                    {decisions[item.id] ? decisionLabels[decisions[item.id]] : '等待判断'}
                  </span>
                </button>
                <ChevronRight className="review-row-chevron" size={14} />
              </div>
            ))}
          </aside>

          <div className="review-detail-pane">
          <section key={activeCase.id} className="review-evidence" aria-label={`${activeCase.id} 案例详情`}>
            <div className="review-detail-top"><span className="review-detail-id">{activeCase.id}</span><span className={`review-result-tag ${activeCase.sampledPass ? 'is-pass' : ''}`}>{activeCase.sampledPass ? '自动判定通过 · 抽查' : '自动判定待复核'}</span></div>
            <h3>{activeCase.title}</h3>
            <p className="review-case-summary">{activeCase.summary}</p>

            <div className="review-conversation">
              <div><span>用户</span><p>{activeCase.input}</p></div>
              <div><span>客服</span><p>{activeCase.output}</p></div>
            </div>

            <div className="review-evidence-section">
              <h4><ShieldCheck size={17} />本次评测标准</h4>
              <p>{activeCase.standard}</p>
            </div>
            <div className={`review-evidence-section review-finding ${activeCase.sampledPass ? 'is-pass' : ''}`}>
              <h4><FileText size={17} />判断依据</h4>
              <p>{activeCase.finding}</p>
            </div>
            <div className="review-evidence-section">
              <h4><Clock3 size={17} />执行记录<span className="review-trace-label">独立测试会话</span></h4>
              <ol className="review-trace">
                {activeCase.trace.map((step, index) => (
                  <li key={`${activeCase.id}-${index}`} className={step.warning ? 'has-warning' : ''}>
                    <span className="review-trace-dot" /><time>{step.time}</time><div><strong>{step.action}</strong><p>{step.detail}</p></div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
            <div className="review-single-judgment">
              <div className="review-judgment-heading"><span>你的判断</span><span>{activeCase.id}</span></div>
              <div className="review-decision-actions">
                {(['issue', 'clear', 'recheck'] as const).map((decision) => (
                  <button key={decision} aria-pressed={decisions[activeId] === decision} className={`is-${decision} ${decisions[activeId] === decision ? 'is-chosen' : ''}`} onClick={() => judgeCase(activeId, decision)}>{decisions[activeId] === decision && <Check size={15} />}{decisionLabels[decision]}</button>
                ))}
              </div>
              {decisions[activeId] && <button className="review-reset-judgment" onClick={() => { setDecisions((current) => { const next = { ...current }; delete next[activeId]; return next }); setAnnouncement(`${activeId} 已撤销判断`) }}>撤销这项判断</button>}
            </div>
          </div>
        </div>

        <footer className="review-footer">
          <div className="review-footer-note"><CircleHelp size={16} /><p>未判断的 <strong>{unmarkedCount}</strong> 项与不确定的 <strong>{recheckCount}</strong> 项将交给 Agent 核查。<br /><span>证据不足时保留待定，你已明确的判断会被保留。</span></p></div>
          <button className="review-submit" onClick={submit}>提交本批复核<ChevronRight size={16} /></button>
        </footer>
        <div className="review-sr-only" role="status" aria-live="polite">{announcement}</div>
      </div>
    </div>
  )
}
