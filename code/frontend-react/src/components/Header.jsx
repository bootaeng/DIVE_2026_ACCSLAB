import WeatherWidget from './WeatherWidget.jsx'

export default function Header() {
  return (
    <header className="bg-white border-b border-[#e8ebee]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          {/* Logo / Icon */}
          <img
            src="/carrylog_icon.svg"
            alt="캐리로그 CarryLog"
            className="w-12 h-12 rounded-2xl shadow-md shadow-[#0E9E8E]/20"
          />

          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold gradient-text leading-tight">
              캐리로그 <span className="text-[#0E9E8E]">CarryLog</span>
            </h1>
            <p className="text-[#8b95a1] mt-0.5 text-sm">
              짐 없는 부산 여행의 시작 — 부산교통공사 × 짐캐리 · DIVE 2026
            </p>
          </div>

          {/* 전역 실시간 기상 위젯 (우측 상단) */}
          <div className="sm:ml-auto">
            <WeatherWidget />
          </div>
        </div>
      </div>
    </header>
  )
}
