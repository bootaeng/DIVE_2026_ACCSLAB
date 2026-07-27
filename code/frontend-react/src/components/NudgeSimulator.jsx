import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getLineColor, groupStationsByLine, getLineList, displayStationName } from '../utils/lines'
import PlanMap from './PlanMap.jsx'
import StationMapModal from './StationMapModal.jsx'

function isoAfter(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function todayIso() {
  return isoAfter(0)
}

// "7/25 (토)" 형태로 표시
function fmtDateKr(iso) {
  const d = new Date(`${iso}T00:00:00`)
  return `${d.getMonth() + 1}/${d.getDate()} (${['일', '월', '화', '수', '목', '금', '토'][d.getDay()]})`
}

// 숙소 근처 역 → 짐배송 권역 추정 (luggage-advice의 흐름 통계 파라미터용)
function regionForStation(name) {
  const n = (name || '').trim()
  const REGIONS = {
    '해운대·기장': ['해운대', '중동', '장산', '센텀시티', '벡스코', '시립미술관', '기장', '송정', '오시리아', '동백'],
    '광안리': ['광안', '수영', '민락', '금련산', '남천'],
    '서면·부산진구': ['서면', '전포', '부전', '양정', '범내골', '부암'],
    '원도심(동구·중구)': ['남포', '중앙', '자갈치', '토성', '부산', '초량', '부산진', '좌천', '범일'],
  }
  for (const [region, names] of Object.entries(REGIONS)) {
    if (names.some(s => n === s || n.startsWith(s))) return region
  }
  return '기타'
}

export default function NudgeSimulator() {
  const [stations, setStations] = useState([])
  const [selectedLine, setSelectedLine] = useState('1호선')
  const [selectedStation, setSelectedStation] = useState('다대포해수욕장')
  const [stationDetail, setStationDetail] = useState(null)
  const [activeTab, setActiveTab] = useState('nudge') // 'nudge', 'kiosk', 'lockers'

  // 짐캐리 여행 일정 생성기 — sdbwork/JimCarry_Busan(persona.py) 이식
  // 짐 무게·여행 스타일 → 컨시어지 페르소나 → 일자별 일정 (짐캐리 배송/보관함은 무조건 이용 전제)
  const [planForm, setPlanForm] = useState({ weight: 'medium', styles: ['food'], days: 1, companions: '', travelDate: '', plan: '' })
  const [plan, setPlan] = useState(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState(null)
  const [planAdvice, setPlanAdvice] = useState(null) // 생성된 일정 기준 보관함 vs 짐캐리 비용 비교 스냅샷

  // Open-Meteo 예보 제공 범위(오늘부터 약 16일, weather.py MAX_FORECAST_DAYS와 동일) 판정
  const forecastAvailable = (() => {
    if (!planForm.travelDate) return true
    const start = new Date(`${planForm.travelDate}T00:00:00`)
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const delta = Math.round((start - today) / 86400000)
    return delta >= 0 && delta + planForm.days <= 16
  })()

  const toggleStyle = (id) => {
    setPlanForm(f => ({
      ...f,
      styles: f.styles.includes(id) ? f.styles.filter(s => s !== id) : [...f.styles, id]
    }))
  }

  // 도착 거점 (짐캐리 오피스) — 일정 생성 및 비용 비교에 반영
  const [hub, setHub] = useState('busan_station')
  // 여행 마침 거점 — 마지막 날 동선은 숙소 복귀 없이 이 거점 방향으로 마무리
  const [endHub, setEndHub] = useState('busan_station')

  // 짐캐리 무인보관함 이용 시간 산정
  // 당일치기: 숙소가 없어 하루 종일(약 9시간) 보관
  // 1박 이상: 짐캐리 배송이 거점↔숙소 운반을 담당하므로, 보관함은 도착일 체크인(15시) 전 임시보관(~6h)만
  const lockerHoursFor = (days) => (days === 1 ? 9 : 6)

  const generatePlan = async () => {
    setPlanLoading(true)
    setPlan(null)
    setPlanError(null)
    setPlanAdvice(null)
    try {
      // 일정 생성과 동시에 이 일정 기준 짐캐리 무인보관함 요금을 스냅샷으로 확보
      const size = { light: 'small', medium: 'medium', heavy: 'large' }[planForm.weight] || 'large'
      const hours = lockerHoursFor(planForm.days)
      // 당일치기는 숙소가 없으므로 관광 권역 = 거점 기준(부산역·국제터미널 → 원도심), 1박 이상은 숙소 역 기준
      const region = planForm.days === 1
        ? ({ busan_station: '원도심(동구·중구)', intl_terminal: '원도심(동구·중구)', gimhae_airport: '기타' }[hub] || '기타')
        : regionForStation(selectedStation)
      const adviceQ = new URLSearchParams({ hub, size, hours: String(hours), region })

      const [resp, adviceResp] = await Promise.all([
        fetch('/api/tour-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // 짐 처리 방식은 짐캐리 배송 전제(urgency: deliver 고정)
          body: JSON.stringify({ ...planForm, urgency: 'deliver', station: planForm.days === 1 ? '' : selectedStation, hub, endHub })
        }),
        fetch(`/api/luggage-advice?${adviceQ}`)
      ])
      const json = await resp.json()
      if (json.error) setPlanError(json.error)
      else {
        setPlan(json)
        try { setPlanAdvice({ ...(await adviceResp.json()), days: planForm.days }) } catch { setPlanAdvice(null) }
      }
    } catch (e) {
      console.error('Failed to generate tour plan:', e)
      setPlanError('일정 생성에 실패했습니다. 잠시 후 다시 시도해주세요.')
    } finally {
      setPlanLoading(false)
    }
  }

  // 장애인 편의시설 실데이터 (부산도시철도 OpenAPI - 서비스명세서 기반)
  const [accData, setAccData] = useState(null)
  const [accLoading, setAccLoading] = useState(false)

  useEffect(() => {
    let ignore = false
    async function loadAccessibility() {
      setAccLoading(true)
      try {
        const resp = await fetch(`/api/accessibility/${encodeURIComponent(selectedStation)}`)
        const json = await resp.json()
        if (!ignore) setAccData(json)
      } catch (e) {
        console.error('Failed to load accessibility info:', e)
        if (!ignore) setAccData(null)
      } finally {
        if (!ignore) setAccLoading(false)
      }
    }
    loadAccessibility()
    return () => { ignore = true }
  }, [selectedStation])

  useEffect(() => {
    async function loadStations() {
      try {
        const resp = await fetch('/api/stations')
        const json = await resp.json()
        const list = json.stations || []
        setStations(list)

        // Find default station detail + sync its line
        const found = list.find(s => s.name === '다대포해수욕장')
        setStationDetail(found || list[0] || null)
        if (found) setSelectedLine(found.line)
        else if (list[0]) setSelectedLine(list[0].line)
      } catch (e) {
        console.error(e)
      }
    }
    loadStations()
  }, [])

  const stationsByLine = groupStationsByLine(stations)
  const lineList = getLineList(stations)

  const handleLineChange = (line) => {
    setSelectedLine(line)
    const first = (stationsByLine[line] || [])[0]
    if (first) {
      setSelectedStation(first.name)
      setStationDetail(first)
    }
  }

  const handleStationChange = (e) => {
    const name = e.target.value
    setSelectedStation(name)
    const found = stations.find(s => s.name === name && s.line === selectedLine) || stations.find(s => s.name === name)
    setStationDetail(found || null)
  }

  // 지도에서 숙소 근처 역 선택
  const [showMapModal, setShowMapModal] = useState(false)
  const pickStationByName = (name) => {
    setSelectedStation(name)
    const found = stations.find(s => s.name === name)
    if (found) { setSelectedLine(found.line); setStationDetail(found) }
  }

  return (
    <div className="space-y-6 mt-6 animate-fade-in-up">
      {/* Persona + Station Selector */}
      <div className="glass-card p-6 space-y-5">
        <div>
          <h3 className="text-lg font-bold text-[#191f28]">🧳 짐캐리 여행 일정 도우미 & 역 편의시설 정보</h3>
          <p className="text-xs text-[#6b7684] mt-1">짐 상황·여행 스타일 기반으로 AI 컨시어지가 짐캐리 보관·배송 시점을 포함한 일자별 일정을 설계하고, 역별 교통약자 편의시설·물품보관함 현황을 제공합니다.</p>
        </div>

        {/* Line → Station selector — 편의시설 조회용 (일정 도우미 탭에서는 폼 안의 '숙소 근처 역'을 사용) */}
        {activeTab !== 'nudge' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#6b7684] mb-2">호선 선택</label>
              <div className="flex flex-wrap gap-1.5">
                {lineList.map(line => (
                  <button
                    key={`nudge-line-${line}`}
                    type="button"
                    onClick={() => handleLineChange(line)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
                      selectedLine === line ? 'text-[#191f28]' : 'text-[#6b7684] border-[#e8ebee] bg-[#f2f4f6] hover:bg-[#e8ebee]'
                    }`}
                    style={selectedLine === line ? { backgroundColor: `${getLineColor(line)}22`, borderColor: getLineColor(line) } : {}}
                  >
                    <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ backgroundColor: getLineColor(line) }} />
                    {line}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#6b7684] mb-2">조회할 역</label>
              <select
                value={selectedStation}
                onChange={handleStationChange}
                className="w-full bg-white border border-[#d1d6db] rounded-xl px-4 py-2 text-sm text-[#191f28] focus:outline-none focus:border-[#3182f6]"
              >
                {(stationsByLine[selectedLine] || []).map(s => (
                  <option key={`nudge-s-${s.id}`} value={s.name}>{s.name}{s.transferType === '환승역' ? ' 🔄' : ''}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#e8ebee]">
        <button
          onClick={() => setActiveTab('nudge')}
          className={`px-6 py-3 text-sm font-bold border-b-2 transition-all cursor-pointer ${
            activeTab === 'nudge'
              ? 'border-[#3182f6] text-[#191f28]'
              : 'border-transparent text-[#8b95a1] hover:text-[#4e5968]'
          }`}
        >
          🧳 여행 일정 도우미
        </button>
        <button
          onClick={() => setActiveTab('kiosk')}
          className={`px-6 py-3 text-sm font-bold border-b-2 transition-all cursor-pointer ${
            activeTab === 'kiosk'
              ? 'border-[#3182f6] text-[#191f28]'
              : 'border-transparent text-[#8b95a1] hover:text-[#4e5968]'
          }`}
        >
          ♿ 교통약자 편의시설 · 키오스크
        </button>
        <button
          onClick={() => setActiveTab('lockers')}
          className={`px-6 py-3 text-sm font-bold border-b-2 transition-all cursor-pointer ${
            activeTab === 'lockers'
              ? 'border-[#3182f6] text-[#191f28]'
              : 'border-transparent text-[#8b95a1] hover:text-[#4e5968]'
          }`}
        >
          📦 물품보관함(락커) 현황
        </button>
      </div>

      {/* Tab Contents */}
      <div className="min-h-[350px]">
        {/* TAB 1: 짐캐리 여행 일정 생성기 (sdbwork/JimCarry_Busan 이식) */}
        {activeTab === 'nudge' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              {/* 짐 조건 + 여행 스타일 입력 (persona.py 선택지 그대로) */}
              <div className="glass-card p-6">
                <h4 className="text-sm font-bold text-[#191f28] mb-1">🧳 짐캐리 여행 일정 도우미</h4>
                <p className="text-xs text-[#6b7684] mb-4">
                  짐 상황과 여행 스타일을 알려주시면, AI 컨시어지가 <strong>{planForm.days === 1 ? '도착 거점 출발 당일치기 일정' : `숙소(${displayStationName(selectedStation)}역 인근) 기준 일자별 일정`}</strong>을
                  짐캐리 보관·배송 시점까지 넣어 설계합니다. (보관함 요금·혼잡 시간대는 공사 실데이터 반영)
                </p>

                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-semibold text-[#6b7684] mb-1.5">🛬 도착 거점 (여행 시작)</label>
                      <div className="grid grid-cols-3 gap-1">
                        {[
                          { id: 'busan_station', label: '부산역' },
                          { id: 'gimhae_airport', label: '김해공항' },
                          { id: 'intl_terminal', label: '국제터미널' }
                        ].map(h => (
                          <button key={h.id} type="button" onClick={() => setHub(h.id)}
                            className={`px-1 py-1.5 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                              hub === h.id ? 'bg-[#e8f3ff] border-[#3182f6] text-[#191f28]' : 'bg-[#f2f4f6] border-[#e8ebee] text-[#6b7684] hover:bg-[#e8ebee]'
                            }`}>{h.label}</button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-[#6b7684] mb-1.5">🛫 여행 마침 거점 (떠나는 곳)</label>
                      <div className="grid grid-cols-3 gap-1">
                        {[
                          { id: 'busan_station', label: '부산역' },
                          { id: 'gimhae_airport', label: '김해공항' },
                          { id: 'intl_terminal', label: '국제터미널' }
                        ].map(h => (
                          <button key={`end-${h.id}`} type="button" onClick={() => setEndHub(h.id)}
                            className={`px-1 py-1.5 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                              endHub === h.id ? 'bg-[#fdecee] border-[#f04452] text-[#191f28]' : 'bg-[#f2f4f6] border-[#e8ebee] text-[#6b7684] hover:bg-[#e8ebee]'
                            }`}>{h.label}</button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between items-baseline mb-1.5">
                      <label className="text-[10px] font-semibold text-[#6b7684]">여행 시작일</label>
                      <span className="text-[10px] font-bold text-[#1b64da]">
                        {(() => {
                          const iso = planForm.travelDate || todayIso()
                          const dday = Math.round((new Date(`${iso}T00:00:00`) - new Date(`${todayIso()}T00:00:00`)) / 86400000)
                          return `${fmtDateKr(iso)} 출발 · ${dday === 0 ? '오늘' : `D-${dday}`}`
                        })()}
                      </span>
                    </div>
                    {/* 빠른 선택 칩 */}
                    <div className="flex gap-1.5 mb-2">
                      {[
                        { label: '오늘', date: '' },
                        { label: '내일', date: isoAfter(1) },
                        { label: '이번 주말', date: isoAfter(((6 - new Date().getDay()) + 7) % 7 || 7) }
                      ].map(c => {
                        const active = planForm.travelDate === c.date
                        return (
                          <button key={c.label} type="button"
                            onClick={() => setPlanForm(f => ({ ...f, travelDate: c.date }))}
                            className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
                              active
                                ? 'bg-[#e8f3ff] border-[#3182f6] text-[#191f28] shadow-md shadow-[#3182f6]/10'
                                : 'bg-[#f2f4f6] border-[#e8ebee] text-[#6b7684] hover:bg-[#e8ebee] hover:text-[#333d4b]'
                            }`}>
                            {c.label}
                          </button>
                        )
                      })}
                    </div>
                    {/* 직접 선택 (자유 날짜) */}
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm pointer-events-none">📅</span>
                      <input
                        type="date"
                        value={planForm.travelDate}
                        min={todayIso()}
                        onChange={e => setPlanForm(f => ({ ...f, travelDate: e.target.value }))}
                        className="w-full bg-white border border-[#d1d6db] rounded-xl pl-9 pr-3 py-2 text-xs text-[#191f28] cursor-pointer transition-all hover:border-[#3182f6]/50 focus:outline-none focus:border-[#3182f6] focus:ring-2 focus:ring-[#3182f6]/20 [&::-webkit-calendar-picker-indicator]:opacity-50 [&::-webkit-calendar-picker-indicator]:cursor-pointer hover:[&::-webkit-calendar-picker-indicator]:opacity-100"
                      />
                    </div>
                    {!forecastAvailable && (
                      <p className="text-[10px] text-amber-600 mt-1.5 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                        ⛅ 이 날짜는 날씨 예보 제공 범위(오늘부터 약 16일)를 벗어나, 예보 없이 일정을 설계합니다.
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-[10px] font-semibold text-[#6b7684] mb-1.5">여행 일수</label>
                    <select value={planForm.days} onChange={e => setPlanForm(f => ({ ...f, days: Number(e.target.value) }))}
                      className="w-full bg-white border border-[#d1d6db] rounded-lg px-2.5 py-1.5 text-xs text-[#191f28] focus:outline-none focus:border-[#3182f6]">
                      <option value="1">당일치기</option>
                      <option value="2">1박 2일</option>
                      <option value="3">2박 3일</option>
                    </select>
                  </div>

                  {/* 숙소 근처 역 — 1박 이상일 때만 활성화 (당일치기는 숙소 개념 없음) */}
                  <div className={`transition-opacity ${planForm.days === 1 ? 'opacity-40 pointer-events-none select-none' : ''}`}>
                    <div className="flex justify-between items-center mb-1.5">
                      <label className="text-[10px] font-semibold text-[#6b7684]">🏨 숙소 근처 역 {planForm.days === 1 && <span className="text-[#8b95a1] font-normal">(1박 이상 선택 시 활성화)</span>}</label>
                      <button
                        type="button"
                        onClick={() => setShowMapModal(true)}
                        className="text-[10px] text-[#1b64da] hover:text-[#3182f6] font-bold cursor-pointer transition-all"
                      >
                        🗺️ 지도에서 선택
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {lineList.map(line => (
                        <button
                          key={`plan-line-${line}`}
                          type="button"
                          onClick={() => handleLineChange(line)}
                          className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                            selectedLine === line ? 'text-[#191f28]' : 'text-[#6b7684] border-[#e8ebee] bg-[#f2f4f6] hover:bg-[#e8ebee]'
                          }`}
                          style={selectedLine === line ? { backgroundColor: `${getLineColor(line)}22`, borderColor: getLineColor(line) } : {}}
                        >
                          <span className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle" style={{ backgroundColor: getLineColor(line) }} />
                          {line}
                        </button>
                      ))}
                    </div>
                    <select
                      value={selectedStation}
                      onChange={handleStationChange}
                      className="w-full bg-white border border-[#d1d6db] rounded-lg px-2.5 py-1.5 text-xs text-[#191f28] focus:outline-none focus:border-[#3182f6]"
                    >
                      {(stationsByLine[selectedLine] || []).map(s => (
                        <option key={`plan-s-${s.id}`} value={s.name}>{s.name}{s.transferType === '환승역' ? ' 🔄' : ''}</option>
                      ))}
                    </select>
                  </div>
                  {planForm.days === 1 && (
                    <p className="text-[10px] text-[#8b95a1] -mt-1.5">🏷️ 당일치기는 숙소 없이 <strong className="text-[#4e5968]">도착 거점 기준</strong>으로 일정을 설계합니다.</p>
                  )}

                  <div>
                    <label className="block text-[10px] font-semibold text-[#6b7684] mb-1.5">① 짐이 얼마나 무거우신가요?</label>
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        { id: 'light', label: '🎒 가벼움 (백팩)' }, { id: 'medium', label: '🧳 보통 (기내용)' }, { id: 'heavy', label: '🏋️ 무거움 (대형)' }
                      ].map(w => (
                        <button key={w.id} type="button" onClick={() => setPlanForm(f => ({ ...f, weight: w.id }))}
                          className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
                            planForm.weight === w.id ? 'bg-[#e8f3ff] border-[#3182f6] text-[#191f28]' : 'bg-[#f2f4f6] border-[#e8ebee] text-[#6b7684] hover:bg-[#e8ebee]'
                          }`}>{w.label}</button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-semibold text-[#6b7684] mb-1.5">② 어떤 여행을 원하시나요? <span className="text-[#8b95a1]">(복수 선택)</span></label>
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        { id: 'activity', label: '🏄 액티비티' }, { id: 'food', label: '🍜 맛집' }, { id: 'healing', label: '🍃 힐링' },
                        { id: 'photo', label: '📸 감성 스팟' }, { id: 'culture', label: '🏛️ 문화·역사' }, { id: 'shopping', label: '🛍️ 쇼핑·시장' }
                      ].map(s => (
                        <button key={s.id} type="button" onClick={() => toggleStyle(s.id)}
                          className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
                            planForm.styles.includes(s.id) ? 'bg-[#fdecee] border-[#f04452] text-[#191f28]' : 'bg-[#f2f4f6] border-[#e8ebee] text-[#6b7684] hover:bg-[#e8ebee]'
                          }`}>{s.label}</button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-semibold text-[#6b7684] mb-1.5">동행</label>
                    <select value={planForm.companions} onChange={e => setPlanForm(f => ({ ...f, companions: e.target.value }))}
                      className="w-full bg-white border border-[#d1d6db] rounded-lg px-2.5 py-1.5 text-xs text-[#191f28] focus:outline-none focus:border-[#3182f6]">
                      <option value="">혼자</option>
                      <option value="친구">친구와</option>
                      <option value="연인">연인과</option>
                      <option value="가족(아이 동반)">가족 (아이 동반)</option>
                      <option value="부모님">부모님과</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[10px] font-semibold text-[#6b7684] mb-1.5">
                      이미 정해둔 계획 <span className="text-[#8b95a1]">(선택 — 있으면 이 계획을 축으로 일정을 설계)</span>
                    </label>
                    <textarea
                      value={planForm.plan}
                      onChange={e => setPlanForm(f => ({ ...f, plan: e.target.value }))}
                      rows={2}
                      placeholder="예: 둘째 날 저녁 7시 광안리에서 친구 만남, 마지막 날 자갈치시장 들르기"
                      className="w-full bg-white border border-[#d1d6db] rounded-lg px-2.5 py-1.5 text-xs text-[#191f28] focus:outline-none focus:border-[#3182f6] resize-none"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={generatePlan}
                  disabled={planLoading || planForm.styles.length === 0}
                  className="w-full mt-4 bg-[#3182f6] hover:bg-[#1b64da] text-white shadow-md shadow-[#3182f6]/20 rounded-xl py-3 font-semibold text-xs transition-all cursor-pointer disabled:opacity-50"
                >
                  {planLoading ? '🧳 AI 컨시어지가 일정을 설계하는 중... (약 20~40초)' : '🧳 짐 없는 여행 일정 생성'}
                </button>
                {planForm.styles.length === 0 && (
                  <p className="text-[10px] text-[#8b95a1] mt-1.5">여행 스타일을 1개 이상 선택해주세요.</p>
                )}
                {planError && (
                  <p className="text-[11px] text-rose-600 mt-2">⚠️ {planError}</p>
                )}

                <p className="text-[9px] text-[#8b95a1] mt-2">
                  * 캐리로그 AI 컨시어지가 보관함 요금(공사 실데이터)·짐캐리 공식 배송요금(zimcarry.net)·혼잡 시간대를 일정에 반영합니다. 생성 후 지도 아래에서 짐 처리 비용 비교를 확인하세요.
                </p>
              </div>
            </div>

            {/* 오른쪽: 생성된 일정 + 주변 놀거리·관광지 */}
            <div className="space-y-4">
              {planLoading && (
                <div className="glass-card p-8 flex flex-col items-center justify-center min-h-[200px]">
                  <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-[#3182f6] mb-3"></div>
                  <p className="text-xs text-[#6b7684]">짐 조건 분석 → 실데이터 조회 → 일자별 일정 설계 중...</p>
                </div>
              )}

              {plan && !planLoading && (
                <div className="glass-card p-5 border-l-4 border-l-[#f04452]">
                  <div className="flex justify-between items-start mb-2 gap-2">
                    <h4 className="text-sm font-bold text-[#191f28]">🗓️ {plan.profile?.days}일 짐 없는 부산 여정</h4>
                    <div className="flex gap-1.5 shrink-0">
                      {plan.internalContext && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border text-emerald-600 bg-emerald-50 border-emerald-200">🟢 실데이터 반영</span>
                      )}
                    </div>
                  </div>
                  <div className="text-[10px] text-[#8b95a1] mb-3">
                    {plan.profile?.weight} · {plan.profile?.styles?.join(', ')} · {plan.profile?.days === 1
                      ? `당일치기 · ${plan.profile?.hub || '부산역'} 도착`
                      : (plan.profile?.hub ? `${plan.profile.hub} 도착 · 숙소 ${plan.profile?.station}역 인근` : `${plan.profile?.station}역 출발`)}{plan.profile?.endHub ? ` → ${plan.profile.endHub}에서 마무리` : ''} · 🗓️ {plan.profile?.travelDate}{plan.profile?.hasPlan ? ' · 📌 기존 계획 반영' : ''}
                  </div>
                  {plan.weather ? (
                    <div className="mb-3 text-[10px] text-sky-700 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 whitespace-pre-line leading-relaxed">
                      🌤️ <strong>여행 기간 부산 날씨 예보 반영</strong> (Open-Meteo){'\n'}{plan.weather}
                    </div>
                  ) : (
                    <div className="mb-3 text-[10px] text-[#8b95a1] bg-[#f2f4f6] border border-[#e8ebee] rounded-lg px-3 py-2">
                      ⛅ 이 일정은 날씨 예보 없이 설계됐습니다 (예보 제공 범위: 오늘부터 약 16일).
                    </div>
                  )}
                  <div className="plan-markdown text-xs text-[#333d4b] leading-relaxed max-h-[45vh] overflow-y-auto pr-1.5">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.plan}</ReactMarkdown>
                  </div>
                </div>
              )}

              {/* 일정 동선 지도 (카카오맵) */}
              {plan && !planLoading && <PlanMap stops={plan.stops} />}

              {/* 짐캐리 이용 총 비용 — 지도 아래, 짐캐리 배송+무인보관함을 쓴다는 전제로 총액 산정 */}
              {plan && planAdvice && !planLoading && (() => {
                const lk = planAdvice.lockerOption || {}
                const dv = planAdvice.deliveryOption || {}
                const dayTrip = planAdvice.days === 1
                const lockerName = lk.provider === 'zimcarry' ? '짐캐리 무인보관함' : '역 물품보관함'
                const lockerTotal = lk.available ? lk.total : 0
                const oneWay = dv.fare || 0
                // 짐캐리 배송을 쓰면 도착 즉시 거점→숙소로 짐이 이동해 전 일정 빈손 — 별도 보관함이 필요 없다.
                // 당일치기(숙소 없음)만 짐캐리 무인보관함으로 하루 보관.
                const items = dayTrip
                  ? [{ icon: lk.provider === 'zimcarry' ? '🧳' : '🔐', name: `${lockerName} 하루 보관`, sub: lk.available ? `${lk.feePer3h?.toLocaleString()}원 · ${lk.unitLabel || '3시간당'} × ${lk.periods}회` : (lk.reason || '보관함 정보 없음'), amount: lockerTotal }]
                  : [
                      { icon: '🚚', name: '짐캐리 배송 · 거점→숙소 (도착일)', sub: `${dv.zimSize} 사이즈 · ${oneWay.toLocaleString()}원`, amount: oneWay },
                      { icon: '🚚', name: '짐캐리 배송 · 숙소→거점 (마지막날)', sub: `${dv.zimSize} 사이즈 · ${oneWay.toLocaleString()}원`, amount: oneWay },
                    ]
                const total = items.reduce((s, it) => s + (it.amount || 0), 0)
                return (
                  <div className="glass-card p-5 border-l-4 border-l-[#0E9E8E]">
                    <div className="flex justify-between items-center mb-1">
                      <h4 className="text-sm font-bold text-[#191f28]">💰 이 일정의 짐캐리 이용 총 비용</h4>
                      <span className="text-[10px] text-[#8b95a1]">짐 1개 기준</span>
                    </div>
                    <p className="text-[11px] text-[#6b7684] mb-3">
                      {dayTrip
                        ? <>당일치기는 숙소가 없어 <strong className="text-[#4e5968]">{lockerName}</strong>에 하루 맡기는 비용으로 산정했습니다.</>
                        : <>짐캐리 <strong className="text-[#4e5968]">배송(거점→숙소·숙소→거점)</strong>만으로 도착부터 출발까지 짐을 들 필요가 없습니다. 별도 물품보관함은 필요하지 않습니다. (숙소 체크인 15시)</>}
                    </p>

                    {dayTrip && lk.provider === 'zimcarry' && lk.available && (
                      <p className="mb-3 text-[10px] text-[#0E9E8E] bg-[#e6f7f5] border border-[#c3ebe6] rounded-lg px-2.5 py-1.5">
                        📍 이 권역엔 <strong>{lk.name}</strong>이 있어 짐캐리 무인보관함을 이용할 수 있습니다.
                      </p>
                    )}

                    <div className="divide-y divide-[#f2f4f6] border border-[#e8ebee] rounded-xl overflow-hidden">
                      {items.map((it, i) => (
                        <div key={i} className="flex justify-between items-center gap-3 px-3 py-2.5">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-[#191f28]">{it.icon} {it.name}</div>
                            <div className="text-[10px] text-[#8b95a1] mt-0.5 truncate">{it.sub}</div>
                          </div>
                          <div className="text-sm font-bold text-[#191f28] shrink-0">{(it.amount || 0).toLocaleString()}원</div>
                        </div>
                      ))}
                      <div className="flex justify-between items-center px-3 py-3 bg-[#e6f7f5]">
                        <span className="text-xs font-bold text-[#0E9E8E]">총 짐 처리 비용</span>
                        <span className="text-lg font-extrabold text-[#0E9E8E]">{total.toLocaleString()}원</span>
                      </div>
                    </div>

                    {dv.surcharges?.length > 0 && (
                      <div className="mt-2 space-y-0.5">
                        {dv.surcharges.map((s, i) => <div key={i} className="text-[10px] text-amber-600">➕ {s}</div>)}
                      </div>
                    )}

                    <p className="text-[9px] text-[#b0b8c1] mt-2 leading-relaxed">
                      {dayTrip
                        ? <>* 보관함: {lk.provider === 'zimcarry' ? '짐캐리 무인보관함(소2,000·중3,000·대4,000원, 기본 4h·12h마다 추가)' : '부산교통공사 물품보관함 데이터(2025.12)'}</>
                        : <>* 배송: 짐캐리 공식 배송요금(zimcarry.net, 거점 15시 접수→숙소 16~19시 / 숙소 11시 접수→거점 15시 도착) · 제휴/등록 숙소 기준이며, 미등록 숙소는 거리·크기에 따라 요금이 달라져 별도 문의가 필요합니다.</>}
                    </p>
                  </div>
                )
              })()}
            </div>
          </div>
        )}

        {/* TAB 2: ACCESSIBILITY INFO (제공 데이터 키오스크 CSV + 장애인편의시설 OpenAPI) */}
        {activeTab === 'kiosk' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Kiosk installation info from provided CSV */}
            <div className="md:col-span-3 glass-card p-6">
              <div className="flex justify-between items-center mb-4">
                <h4 className="text-sm font-bold text-[#191f28]">🖥️ {displayStationName(selectedStation)}역 교통약자 네비게이션 키오스크</h4>
                <span className="text-[10px] text-[#8b95a1]">출처: 교통약자 네비게이션 키오스크.csv (제공 데이터)</span>
              </div>

              {stationDetail?.kiosks && stationDetail.kiosks.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {stationDetail.kiosks.map((k, i) => (
                    <div key={`kiosk-${i}`} className="bg-[#f2f4f6] border border-[#e8ebee] rounded-xl p-4 text-xs text-[#4e5968] space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-[#191f28]">📍 {k['설치역층'] || ''} {k['근접 출입구번호'] ? `· ${k['근접 출입구번호']}` : ''}</span>
                        <span className="text-[10px] text-[#8b95a1] font-mono">관리번호 {k['관리번호'] || '-'}</span>
                      </div>
                      <div className="text-[#6b7684]">{k['상세위치'] || '상세위치 정보 없음'}</div>
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {[
                          { label: '🔊 음성 서비스', v: k['음성 서비스 여부'] },
                          { label: '⠿ 점자 서비스', v: k['점자 서비스 여부'] },
                          { label: '👁️ 시각 서비스', v: k['시각 서비스 여부'] }
                        ].map(({ label, v }) => (
                          <span
                            key={label}
                            className={`text-[10px] px-2 py-0.5 rounded-full border ${
                              v === '지원'
                                ? 'text-emerald-600 bg-emerald-50 border-emerald-200'
                                : 'text-[#8b95a1] bg-[#f2f4f6] border-[#e8ebee]'
                            }`}
                          >
                            {label}: {v || '미지원'}
                          </span>
                        ))}
                      </div>
                      <div className="text-[10px] text-[#8b95a1] pt-1">
                        운영기관 {k['운영기관'] || '부산교통공사'} · ☎ {k['운영기관 전화번호'] || '-'}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-[#8b95a1] bg-[#f2f4f6] border border-[#e8ebee] rounded-xl p-4 text-center">
                  해당 역사에는 교통약자 네비게이션 키오스크가 설치되어 있지 않습니다.
                </div>
              )}
            </div>

            {/* Real Accessibility Facility Data (부산도시철도 장애인편의시설정보 OpenAPI) */}
            <div className="md:col-span-3 glass-card p-6">
              <div className="flex justify-between items-center mb-4">
                <h4 className="text-sm font-bold text-[#191f28]">♿ {displayStationName(selectedStation)}역 장애인 편의시설 현황</h4>
                <span className="text-[10px] text-[#8b95a1]">출처: 부산도시철도 장애인편의시설정보 OpenAPI (data.humetro.busan.kr)</span>
              </div>

              {accLoading && (
                <div className="flex justify-center py-8">
                  <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-[#3182f6]"></div>
                </div>
              )}

              {!accLoading && accData?.facilities && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
                    {[
                      { label: '엘리베이터(내부)', value: accData.facilities.elevatorIn, icon: '🛗' },
                      { label: '엘리베이터(외부)', value: accData.facilities.elevatorOut, icon: '🛗' },
                      { label: '휠체어리프트(내부)', value: accData.facilities.wheelchairLiftIn, icon: '♿' },
                      { label: '휠체어리프트(외부)', value: accData.facilities.wheelchairLiftOut, icon: '♿' },
                      { label: '에스컬레이터', value: accData.facilities.escalator, icon: '🪜' },
                      { label: '점자유도로', value: accData.facilities.blindRoad, icon: '⠿' },
                      { label: '외부경사로', value: accData.facilities.outerRamp, icon: '📐' },
                      { label: '도움요청벨', value: accData.facilities.helpBell, icon: '🔔' }
                    ].map(({ label, value, icon }) => (
                      <div key={label} className="bg-[#f2f4f6] border border-[#e8ebee] rounded-xl p-3 text-center">
                        <div className="text-lg">{icon}</div>
                        <div className="text-[10px] text-[#6b7684] mt-1">{label}</div>
                        <div className={`text-lg font-bold mt-0.5 ${value > 0 ? 'text-[#191f28]' : 'text-[#8b95a1]'}`}>{value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 text-xs text-[#6b7684]">
                    🚻 <strong className="text-[#191f28]">장애인화장실:</strong>{' '}
                    {accData.facilities.toilet > 0
                      ? `${accData.facilities.toilet}개소${accData.facilities.toiletType ? ` (남녀 ${accData.facilities.toiletType})` : ''}`
                      : '미설치'}
                  </div>
                </>
              )}

              {!accLoading && !accData?.facilities && (
                <div className="text-xs text-[#8b95a1] bg-[#f2f4f6] border border-[#e8ebee] rounded-xl p-4 text-center">
                  {accData?.message || '장애인 편의시설 정보를 불러올 수 없습니다.'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: LOCKERS & AMENITIES */}
        {activeTab === 'lockers' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="glass-card p-6 flex flex-col justify-between">
              <div>
                <h4 className="text-sm font-bold text-[#1b64da] uppercase mb-2">물품보관함 설치 현황</h4>
                <p className="text-xs text-[#6b7684] mb-6">부산교통공사 물품보관함 정보(2025.12 기준) 데이터를 기반으로, 역사별 짐보관함 위치·크기별 설치 수량·이용요금을 보여줍니다.</p>
              </div>

              {stationDetail?.lockers && stationDetail.lockers.length > 0 ? (
                <div className="space-y-2 text-xs">
                  <div className="text-[#191f28] font-semibold">📍 보관함 상세 위치:</div>
                  <div className="text-[#6b7684] italic bg-[#f2f4f6] p-2.5 rounded-xl font-mono">
                    {stationDetail.lockers[0]['상세위치']}
                  </div>
                  <div className="mt-3 text-[#191f28] font-semibold">💵 이용 요금 정보:</div>
                  <div className="text-[#6b7684] leading-normal font-mono bg-[#f2f4f6] p-2.5 rounded-xl text-xxs">
                    {stationDetail.lockers[0]['이용요금']}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-[#8b95a1] italic">물품보관함 상세 정보 데이터가 존재하지 않습니다.</p>
              )}

              <div className="text-xs text-[#8b95a1] mt-4 leading-relaxed">
                * 운영사: {stationDetail?.lockers[0]?.['운영사'] || '정보 없음'}
              </div>
            </div>

            {/* Locker grid representation */}
            <div className="md:col-span-2 glass-card p-6">
              <h4 className="text-sm font-bold text-[#191f28] mb-4">🚪 사물함 락커 설치 수량 정보</h4>

              {stationDetail?.lockers && stationDetail.lockers.length > 0 ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { label: '소형 보관함', key: '소형(개수)' },
                    { label: '중형 보관함', key: '중형(개수)' },
                    { label: '대형 보관함', key: '대형(개수)' },
                    { label: '특대형 보관함', key: '특대형(개수)' }
                  ].map(({ label, key }) => {
                    const count = parseInt(stationDetail.lockers[0][key], 10) || 0
                    return (
                      <div key={key} className="bg-[#f2f4f6] border border-[#e8ebee] rounded-xl p-4 text-center">
                        <div className="text-xs text-[#6b7684] font-semibold">{label}</div>
                        <div className="text-2xl font-bold text-[#191f28] mt-2">{count}개</div>
                        <span className={`text-xxs px-2 py-0.5 rounded-full inline-block mt-2 ${
                          count > 0
                            ? 'text-emerald-600 bg-emerald-50'
                            : 'text-[#8b95a1] bg-[#f2f4f6]'
                        }`}>
                          {count > 0 ? '설치됨' : '미설치'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="flex flex-col justify-center items-center h-[200px] text-[#8b95a1]">
                  <span className="text-4xl mb-2">📦</span>
                  <p className="text-xs">해당 역사에는 물품보관함이 설치되어 있지 않거나 데이터가 등록되지 않았습니다.</p>
                </div>
              )}

              {/* Other Amenities */}
              <div className="mt-8 border-t border-[#e8ebee] pt-4">
                <h5 className="text-xs font-semibold text-[#6b7684] mb-3">⚡ 기타 역사 내 편의시설 정보</h5>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-[#4e5968]">
                  <div className="bg-[#f2f4f6] rounded-xl p-3">
                    <strong>💳 ATM 설치 현황:</strong>{' '}
                    {stationDetail?.atms && stationDetail.atms.length > 0 
                      ? `${stationDetail.atms[0]['금융기관명']} (${stationDetail.atms[0]['상세위치'] || ''})`
                      : 'ATM 정보 없음'
                    }
                  </div>
                  <div className="bg-[#f2f4f6] rounded-xl p-3">
                    <strong>🔋 휴대폰 충전 설비:</strong>{' '}
                    {stationDetail?.chargers && stationDetail.chargers.length > 0
                      ? `${stationDetail.chargers[0]['충전설비구분']} (${stationDetail.chargers[0]['상세위치'] || ''} - ${stationDetail.chargers[0]['이용요금'] || ''})`
                      : '충전 설비 없음'
                    }
                  </div>
                </div>
              </div>

            </div>
          </div>
        )}
      </div>

      {/* 숙소 근처 역 지도 선택 모달 (공용 컴포넌트 재사용) */}
      {showMapModal && (
        <StationMapModal
          stations={stations}
          onClose={() => setShowMapModal(false)}
          title="🗺️ 숙소 근처 역 선택"
          subtitle="숙소와 가까운 도시철도역을 지도에서 클릭해 선택하세요."
          hint={<>🔍 휠·＋／－ 확대, 드래그 이동 · 역 클릭 → 숙소 근처 역 지정 · <span className="text-[#3182f6] font-bold">●</span> 현재 선택</>}
          resolveHighlight={(s) => (s.name === selectedStation
            ? 'w-7 h-7 bg-[#3182f6]/90 border-[#b3d4ff] shadow-[0_0_0_5px_rgba(49,130,246,0.35)]'
            : null)}
          actions={[
            { label: '🏨 숙소로 선택', base: 'bg-[#3182f6] hover:bg-[#1b64da]', onSelect: (s) => { pickStationByName(s.name); setShowMapModal(false) } },
          ]}
        />
      )}
    </div>
  )
}
