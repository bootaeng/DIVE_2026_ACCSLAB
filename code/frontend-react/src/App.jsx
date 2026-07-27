import { useState } from 'react'
import Header from './components/Header.jsx'
import DashboardOverview from './components/DashboardOverview.jsx'
import RoutingEngine from './components/RoutingEngine.jsx'
import NudgeSimulator from './components/NudgeSimulator.jsx'
import AssistantChat from './components/AssistantChat.jsx'

export default function App() {
  const [activeTab, setActiveTab] = useState('nudge') // 기본 화면 = 여행 일정 도우미
  const [chatOpen, setChatOpen] = useState(false) // 우측 하단 플로팅 AI 챗봇

  const tabs = [
    { id: 'nudge', icon: '🧳', name: '여행 일정 도우미', desc: 'AI 일정 설계 & 짐 처리' },
    { id: 'routing', icon: '🚶', name: '배리어프리 라우팅', desc: '교통약자 안전 경로' },
    { id: 'overview', icon: '📊', name: '종합 분석', desc: '혼잡도 & 짐배송 흐름' }
  ]

  return (
    <div className="min-h-screen bg-[#f4f6f8] text-[#191f28] font-sans antialiased pb-20">
      <Header />

      {/* 카테고리 탭 — 여행 서비스 스타일 상단 내비게이션 */}
      <nav className="sticky top-0 z-40 bg-white/90 backdrop-blur-md border-b border-[#e8ebee]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex gap-1 sm:gap-2 overflow-x-auto">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`shrink-0 flex items-center gap-1.5 px-3 sm:px-4 py-3.5 text-sm font-bold border-b-2 transition-all cursor-pointer ${
                    isActive
                      ? 'border-[#3182f6] text-[#1b64da]'
                      : 'border-transparent text-[#8b95a1] hover:text-[#4e5968]'
                  }`}
                >
                  <span className="text-base">{tab.icon}</span>
                  {tab.name}
                </button>
              )
            })}
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Active Tab Screen Content */}
        <div className="mt-2">
          {activeTab === 'nudge' && <NudgeSimulator />}
          {activeTab === 'routing' && <RoutingEngine />}
          {activeTab === 'overview' && <DashboardOverview />}
        </div>
      </main>

      {/* 우측 하단 플로팅 AI 챗봇 */}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end">
        {/* 챗 패널 — 닫아도 언마운트하지 않아 대화가 유지된다 */}
        <div
          className={`${chatOpen ? 'flex' : 'hidden'} flex-col w-[min(400px,calc(100vw-2.5rem))] h-[min(600px,calc(100vh-7.5rem))] mb-3 bg-white border border-[#e8ebee] rounded-2xl shadow-2xl overflow-hidden animate-fade-in-up`}
        >
          <div className="flex items-center gap-2 px-4 py-3 bg-gradient-to-r from-[#3182f6] to-[#00b8ae]">
            <span className="text-lg">🤖</span>
            <div className="min-w-0">
              <div className="text-sm font-bold text-white leading-tight">부산 여행 AI 어시스턴트</div>
              <div className="text-[10px] text-white/80">캐리로그 CarryLog</div>
            </div>
            <button
              type="button"
              onClick={() => setChatOpen(false)}
              title="닫기"
              className="ml-auto w-7 h-7 rounded-lg text-white/90 hover:bg-white/15 cursor-pointer text-sm leading-none"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <AssistantChat />
          </div>
        </div>

        {/* 토글 버튼 */}
        <button
          type="button"
          onClick={() => setChatOpen(o => !o)}
          title={chatOpen ? 'AI 어시스턴트 닫기' : 'AI 어시스턴트 열기'}
          className="w-14 h-14 rounded-full bg-gradient-to-br from-[#3182f6] to-[#00b8ae] text-white text-2xl shadow-lg shadow-[#3182f6]/30 hover:scale-105 active:scale-95 transition-transform cursor-pointer flex items-center justify-center"
        >
          {chatOpen ? '✕' : '🤖'}
        </button>
      </div>

      <footer className="border-t border-[#e8ebee] bg-white mt-20 py-8 text-center text-[#8b95a1] text-xs">
        <div className="max-w-7xl mx-auto px-4">
          <p>© 2026 캐리로그(CarryLog) · DIVE 글로벌 데이터 해커톤 - 부산교통공사 × 짐캐리 트랙</p>
          <p className="mt-1 text-[#b0b8c1]">AI 기반 No-Carrier 스마트 여행 어시스턴트 프로토타입</p>
        </div>
      </footer>
    </div>
  )
}
