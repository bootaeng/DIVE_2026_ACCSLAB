import { useState, useEffect, useRef } from 'react'

// 예시 질문 — 내부 데이터(혼잡도·시설·경로·짐배송)와 웹 근거가 함께 동원되는 케이스들
const EXAMPLE_QUESTIONS = [
  '부산역에서 해운대까지 지하철로 어떻게 가? 캐리어가 큰데 괜찮을까?',
  '서면역 물품보관함 요금이랑 위치 알려줘',
  '휠체어로 연산역 이용할 수 있어?',
  '광안리 근처에 가볼 만한 곳 있어?'
]

// 우측 하단 플로팅 챗봇 패널 내부에 들어가는 대화 UI (부모가 크기를 결정)
export default function AssistantChat() {
  const [messages, setMessages] = useState([]) // { role: 'user'|'assistant', text, sources?, meta? }
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [health, setHealth] = useState(null)
  const bottomRef = useRef(null)

  useEffect(() => {
    fetch('/api/assistant/health').then(r => r.json()).then(setHealth).catch(() => setHealth({ running: false }))
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const ask = async (question) => {
    const q = question.trim()
    if (!q || loading) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text: q }])
    setLoading(true)
    try {
      const resp = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q })
      })
      const json = await resp.json()
      if (json.error) {
        setMessages(prev => [...prev, { role: 'assistant', text: `⚠️ ${json.error}` }])
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: json.answer,
          sources: json.sources || [],
          meta: { internal: json.internalChunks, web: json.webChunks, provider: json.searchProvider }
        }])
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', text: '⚠️ 어시스턴트 호출에 실패했습니다. 잠시 후 다시 시도해주세요.' }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 상태 배지 */}
      <div className="px-3 py-2 flex items-center gap-1.5 border-b border-[#f2f4f6] bg-white">
        {health ? (
          <>
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
              health.running && health.llm
                ? 'text-emerald-600 bg-emerald-50 border-emerald-200'
                : 'text-rose-600 bg-rose-50 border-rose-200'
            }`}>
              {health.running ? (health.llm ? '🟢 LLM 연결됨' : '🔑 LLM 키 필요') : '⚪ 서비스 꺼짐'}
            </span>
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
              health.webSearch
                ? 'text-[#1b64da] bg-[#e8f3ff] border-[#b3d4ff]'
                : 'text-[#6b7684] bg-[#f2f4f6] border-[#e8ebee]'
            }`}>
              {health.webSearch ? `🌐 웹검색: ${health.webSearch}` : '📁 내부 데이터 전용'}
            </span>
          </>
        ) : (
          <span className="text-[9px] text-[#8b95a1]">상태 확인 중...</span>
        )}
        <span className="ml-auto text-[9px] text-[#b0b8c1]">실데이터 근거 인용 RAG</span>
      </div>

      {/* 대화 영역 */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-[#f9fafb] px-3 py-3 space-y-3">
        {messages.length === 0 && !loading && (
          <div className="h-full flex flex-col items-center justify-center text-center px-2">
            <span className="text-3xl mb-2">🗺️</span>
            <p className="text-xs text-[#4e5968] font-semibold">부산 여행이나 도시철도에 대해 무엇이든 물어보세요</p>
            <p className="text-[10px] text-[#8b95a1] mt-1 mb-3">역 이름을 넣으면 혼잡도·시설·경로 실데이터로 답해요</p>
            <div className="flex flex-col gap-1.5 w-full">
              {EXAMPLE_QUESTIONS.map((q, i) => (
                <button key={i} type="button" onClick={() => ask(q)}
                  className="text-[11px] text-left text-[#1b64da] bg-[#e8f3ff] border border-[#b3d4ff] hover:bg-[#d9e8ff] rounded-xl px-3 py-2 cursor-pointer transition-all">
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[88%] rounded-2xl px-3 py-2.5 text-[13px] leading-relaxed ${
              m.role === 'user'
                ? 'bg-[#3182f6] border border-[#3182f6] text-white'
                : 'bg-[#f2f4f6] border border-[#e8ebee] text-[#333d4b]'
            }`}>
              <div className="whitespace-pre-wrap">{m.text}</div>

              {m.sources && m.sources.length > 0 && (
                <div className="mt-2.5 pt-2.5 border-t border-[#e8ebee]">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[9px] font-bold text-[#6b7684] uppercase">근거 출처</span>
                    {m.meta && (
                      <span className="text-[9px] text-[#8b95a1]">
                        내부 {m.meta.internal}건 · 웹 {m.meta.web}건
                      </span>
                    )}
                  </div>
                  <ul className="space-y-1">
                    {m.sources.map((s, j) => (
                      <li key={j} className="text-[10px] flex items-start gap-1.5">
                        <span className={`shrink-0 text-[8px] font-bold px-1 py-0.5 rounded ${
                          s.sourceKind === 'internal_data'
                            ? 'text-emerald-600 bg-emerald-50'
                            : s.official
                              ? 'text-[#1b64da] bg-[#e8f3ff]'
                              : 'text-[#6b7684] bg-[#e8ebee]'
                        }`}>
                          {s.sourceKind === 'internal_data' ? '실데이터' : s.official ? '공식' : '웹'}
                        </span>
                        {s.sourceKind === 'internal_data' ? (
                          <span className="text-[#6b7684]">{s.title}</span>
                        ) : (
                          <a href={s.url} target="_blank" rel="noreferrer" className="text-[#1b64da] hover:underline line-clamp-1">{s.title || s.url} ↗</a>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-[#f2f4f6] border border-[#e8ebee] rounded-2xl px-3 py-2.5 flex items-center gap-2">
              <div className="animate-spin rounded-full h-3.5 w-3.5 border-t-2 border-b-2 border-[#3182f6]"></div>
              <span className="text-[11px] text-[#6b7684]">근거 조회 → 답변 생성 중...</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 입력 영역 */}
      <form
        className="p-2.5 flex gap-1.5 border-t border-[#f2f4f6] bg-white"
        onSubmit={(e) => { e.preventDefault(); ask(input) }}
      >
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="부산 여행 질문을 입력하세요"
          className="flex-1 bg-[#f9fafb] border border-[#e8ebee] rounded-xl px-3 py-2.5 text-[13px] text-[#191f28] placeholder-[#b0b8c1] focus:outline-none focus:border-[#3182f6]"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="bg-[#3182f6] hover:bg-[#1b64da] text-white rounded-xl px-4 font-semibold text-[13px] transition-all cursor-pointer disabled:opacity-40"
        >
          질문
        </button>
      </form>
    </div>
  )
}
