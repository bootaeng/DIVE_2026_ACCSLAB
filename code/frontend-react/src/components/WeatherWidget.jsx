import { useState, useEffect } from 'react'

// 전역 실시간 기상 위젯 (헤더 우측 상단) — 백엔드 /api/weather (Open-Meteo, 10분 캐시)
export default function WeatherWidget() {
  const [weather, setWeather] = useState(null)

  useEffect(() => {
    let ignore = false
    async function load() {
      try {
        const resp = await fetch('/api/weather')
        const json = await resp.json()
        if (!ignore) setWeather(json)
      } catch (e) {
        console.error('Failed to load weather:', e)
      }
    }
    load()
    const timer = setInterval(load, 10 * 60 * 1000) // 백엔드 캐시 주기와 동일
    return () => { ignore = true; clearInterval(timer) }
  }, [])

  if (!weather) return null

  return (
    <div className="bg-[#f2f4f6] rounded-2xl px-4 py-2.5 flex items-center gap-3 border border-[#e8ebee]">
      <span className="text-2xl">{weather.icon}</span>
      <div>
        <div className="flex items-baseline gap-2">
          <h5 className="text-xs font-bold text-[#191f28]">부산 실시간 기상</h5>
          <span className="text-base font-extrabold text-[#191f28]">{weather.temp}°C</span>
        </div>
        <div className="text-[10px] text-[#8b95a1] mt-0.5 flex items-center gap-1.5 flex-wrap">
          <span>{weather.condition}</span>
          <span>·</span>
          <span>강수 {weather.precip}mm</span>
          {weather.updatedAt && (
            <>
              <span>·</span>
              <span>{new Date(weather.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 관측</span>
            </>
          )}
        </div>
        {weather.isBad && (
          <div className="text-[9px] text-[#f04452] font-semibold mt-0.5">⚠️ 악천후 — 야외 승강장 안전가중치 적용 중</div>
        )}
      </div>
    </div>
  )
}
