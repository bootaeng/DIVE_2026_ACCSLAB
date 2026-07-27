import { useState, useEffect } from 'react'
import { getLineColor, groupStationsByLine, getLineList, displayStationName } from '../utils/lines'
import StationMapModal from './StationMapModal.jsx'

// 운행 시간대(05~24시) — 승하차 데이터 컬럼과 동일한 키 포맷
const TIME_OPTIONS = Array.from({ length: 19 }, (_, i) => {
  const h = i + 5
  return `${String(h).padStart(2, '0')}시-${String(h + 1).padStart(2, '0')}시`
})

// 현재 시각이 속한 시간대 (운행 시간 밖이면 null)
function getNowSlot() {
  const h = new Date().getHours()
  const slot = `${String(h).padStart(2, '0')}시-${String(h + 1).padStart(2, '0')}시`
  return TIME_OPTIONS.includes(slot) ? slot : null
}

// 기본 선택값: 현재 시간대, 운행 시간 밖(심야/새벽)이면 첫차 시간대
function getCurrentTimeSlot() {
  return getNowSlot() || TIME_OPTIONS[0]
}

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토']
function getTodayInfo() {
  const d = new Date()
  const dow = d.getDay()
  return {
    label: `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_LABELS[dow]})`,
    dayType: dow === 0 || dow === 6 ? 'weekend' : 'weekday'
  }
}

export default function RoutingEngine() {
  const today = getTodayInfo()
  const [stations, setStations] = useState([])
  const [startStation, setStartStation] = useState('113') // default: 부산 (Line 1)
  const [endStation, setEndStation] = useState('203')   // default: 해운대 (Line 2)
  const [startLine, setStartLine] = useState('1호선')
  const [endLine, setEndLine] = useState('2호선')
  const [travelTime, setTravelTime] = useState(getCurrentTimeSlot())
  const [dayType, setDayType] = useState(today.dayType) // 'weekday' | 'weekend'
  const routingMode = 'barrier_free' // 배리어프리 안전 모드 고정
  const [routeResult, setRouteResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [showMapModal, setShowMapModal] = useState(false)
  const [showAllPath, setShowAllPath] = useState(false)

  const getSummaryPath = (path) => {
    if (!path || path.length === 0) return [];
    const summary = [];
    
    // First node (Start)
    summary.push({
      ...path[0],
      originalIndex: 0,
      displayType: 'start'
    });

    // Transfer nodes
    for (let i = 1; i < path.length - 1; i++) {
      const node = path[i];
      if (node.edgeType === 'transfer') {
        summary.push({
          ...node,
          originalIndex: i,
          displayType: 'transfer',
          transferInfo: node.edgeLine
        });
      }
    }

    // Last node (End)
    if (path.length > 1) {
      summary.push({
        ...path[path.length - 1],
        originalIndex: path.length - 1,
        displayType: 'end'
      });
    }

    return summary;
  };

  useEffect(() => {
    async function loadStations() {
      try {
        const resp = await fetch('/api/stations')
        const json = await resp.json()
        const list = json.stations || []
        setStations(list)
        // Sync line chips to the default start/end station ids
        const startS = list.find(s => s.id === startStation)
        const endS = list.find(s => s.id === endStation)
        if (startS) setStartLine(startS.line)
        if (endS) setEndLine(endS.line)
      } catch (e) {
        console.error('Failed to load stations:', e)
      }
    }
    loadStations()
  }, [])

  // Stations belonging to a given line, sorted by id
  const stationsByLine = groupStationsByLine(stations)
  const lineList = getLineList(stations)

  // When a line chip is picked, jump the station select to that line's first station
  const handleLineChange = (which, line) => {
    const first = (stationsByLine[line] || [])[0]
    if (which === 'start') {
      setStartLine(line)
      if (first) setStartStation(first.id)
    } else {
      setEndLine(line)
      if (first) setEndStation(first.id)
    }
  }

  const handleSearch = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setRouteResult(null)

    try {
      const url = `/api/route?start=${encodeURIComponent(startStation)}&end=${encodeURIComponent(endStation)}&time=${encodeURIComponent(travelTime)}&mode=${encodeURIComponent(routingMode)}&day=${encodeURIComponent(dayType)}`
      const resp = await fetch(url)
      if (!resp.ok) throw new Error('API Error')
      const json = await resp.json()
      setRouteResult(json)
      setShowAllPath(false) // default to summary path view
    } catch (err) {
      setError('경로 데이터를 가져오는 데 실패했습니다.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6 animate-fade-in-up">
      {/* Left column: Route Finder + Luggage Advice */}
      <div className="space-y-6 h-fit">
      <div className="glass-card p-6">
        <h3 className="text-lg font-bold text-[#191f28] mb-4">🚪 배리어프리 경로 탐색</h3>
        <p className="text-xs text-[#6b7684] mb-6">시간대별 승하차량 및 이동 편의시설(엘리베이터) 상태를 융합하여 교통약자와 짐배송 카트의 충돌을 예방하고 안전 경로를 탐색합니다.</p>
        
        <form onSubmit={handleSearch} className="space-y-4">
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-xs font-semibold text-[#6b7684]">출발역</label>
              <button
                type="button"
                onClick={() => {
                  setShowMapModal(true);
                }}
                className="text-[10px] text-[#1b64da] hover:text-[#3182f6] font-bold cursor-pointer transition-all"
              >
                🗺️ 지도에서 선택
              </button>
            </div>
            {/* Step 1: line chips */}
            <div className="flex flex-wrap gap-1.5 mb-2">
              {lineList.map(line => (
                <button
                  key={`start-line-${line}`}
                  type="button"
                  onClick={() => handleLineChange('start', line)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
                    startLine === line ? 'text-[#191f28]' : 'text-[#6b7684] border-[#e8ebee] bg-[#f2f4f6] hover:bg-[#e8ebee]'
                  }`}
                  style={startLine === line ? { backgroundColor: `${getLineColor(line)}22`, borderColor: getLineColor(line) } : {}}
                >
                  <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ backgroundColor: getLineColor(line) }} />
                  {line}
                </button>
              ))}
            </div>
            {/* Step 2: stations within selected line */}
            <select
              value={startStation}
              onChange={(e) => setStartStation(e.target.value)}
              className="w-full bg-white border border-[#d1d6db] rounded-xl px-4 py-2.5 text-sm text-[#191f28] focus:outline-none focus:border-[#3182f6]"
            >
              {(stationsByLine[startLine] || []).map(s => (
                <option key={`start-${s.id}`} value={s.id}>{s.name}{s.transferType === '환승역' ? ' 🔄' : ''}</option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-xs font-semibold text-[#6b7684]">도착역</label>
              <button
                type="button"
                onClick={() => {
                  setShowMapModal(true);
                }}
                className="text-[10px] text-[#f04452] hover:text-[#d13b48] font-bold cursor-pointer transition-all"
              >
                🗺️ 지도에서 선택
              </button>
            </div>
            {/* Step 1: line chips */}
            <div className="flex flex-wrap gap-1.5 mb-2">
              {lineList.map(line => (
                <button
                  key={`end-line-${line}`}
                  type="button"
                  onClick={() => handleLineChange('end', line)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
                    endLine === line ? 'text-[#191f28]' : 'text-[#6b7684] border-[#e8ebee] bg-[#f2f4f6] hover:bg-[#e8ebee]'
                  }`}
                  style={endLine === line ? { backgroundColor: `${getLineColor(line)}22`, borderColor: getLineColor(line) } : {}}
                >
                  <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ backgroundColor: getLineColor(line) }} />
                  {line}
                </button>
              ))}
            </div>
            {/* Step 2: stations within selected line */}
            <select
              value={endStation}
              onChange={(e) => setEndStation(e.target.value)}
              className="w-full bg-white border border-[#d1d6db] rounded-xl px-4 py-2.5 text-sm text-[#191f28] focus:outline-none focus:border-[#3182f6]"
            >
              {(stationsByLine[endLine] || []).map(s => (
                <option key={`end-${s.id}`} value={s.id}>{s.name}{s.transferType === '환승역' ? ' 🔄' : ''}</option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-xs font-semibold text-[#6b7684]">이동 예정 시간대</label>
              <span className="text-[10px] text-[#1b64da] bg-[#e8f3ff] border border-[#b3d4ff] rounded-md px-2 py-0.5 font-semibold">
                📅 오늘 {today.label}
              </span>
            </div>
            {/* Weekday / Weekend toggle — drives real weekday/weekend congestion data */}
            <div className="grid grid-cols-2 gap-2 mb-2">
              <button
                type="button"
                onClick={() => setDayType('weekday')}
                className={`py-1.5 px-3 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
                  dayType === 'weekday'
                    ? 'bg-[#e8f3ff] border-[#3182f6] text-[#191f28]'
                    : 'bg-[#f2f4f6] border-[#e8ebee] text-[#6b7684] hover:text-[#333d4b]'
                }`}
              >
                🏢 평일 {today.dayType === 'weekday' ? '(오늘)' : ''}
              </button>
              <button
                type="button"
                onClick={() => setDayType('weekend')}
                className={`py-1.5 px-3 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
                  dayType === 'weekend'
                    ? 'bg-[#fdecee] border-[#f04452] text-[#191f28]'
                    : 'bg-[#f2f4f6] border-[#e8ebee] text-[#6b7684] hover:text-[#333d4b]'
                }`}
              >
                🏖️ 주말 {today.dayType === 'weekend' ? '(오늘)' : ''}
              </button>
            </div>
            <select
              value={travelTime}
              onChange={(e) => setTravelTime(e.target.value)}
              className="w-full bg-white border border-[#d1d6db] rounded-xl px-4 py-2.5 text-sm text-[#191f28] focus:outline-none focus:border-[#3182f6]"
            >
              {TIME_OPTIONS.map(t => (
                <option key={t} value={t}>{t}{t === getNowSlot() ? ' (지금)' : ''}</option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#3182f6] hover:bg-[#1b64da] text-white rounded-xl py-3 font-semibold text-sm transition-all duration-300 shadow-md shadow-[#3182f6]/20 cursor-pointer disabled:opacity-50"
          >
            {loading ? '안전 경로 분석 중...' : '안전 경로 탐색'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            setShowMapModal(true);
          }}
          className="w-full bg-[#f2f4f6] hover:bg-[#e8ebee] text-[#191f28] rounded-xl py-2.5 font-semibold text-xs transition-all duration-300 border border-[#e8ebee] mt-3 cursor-pointer text-center"
        >
          🗺️ 전체 도시철도 노선도 보기
        </button>
      </div>

      </div>

      {/* Route Finder Results */}
      <div className="lg:col-span-2 space-y-6">
        {loading && (
          <div className="glass-card p-12 flex flex-col items-center justify-center min-h-[350px]">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[#3182f6] mb-4"></div>
            <div className="text-[#4e5968] font-medium">도시철도 및 짐배송 물류 데이터 매핑 중...</div>
          </div>
        )}

        {error && (
          <div className="glass-card p-8 text-center text-red-400">
            ⚠️ {error}
          </div>
        )}

        {!routeResult && !loading && !error && (
          <div className="glass-card p-12 text-center text-[#8b95a1] min-h-[350px] flex flex-col justify-center items-center">
            <span className="text-5xl mb-4">🗺️</span>
            <h4 className="text-lg font-bold text-[#6b7684]">경로를 설정하고 탐색 버튼을 눌러주세요</h4>
            <p className="text-xs text-[#8b95a1] mt-2">출발역과 도착역 간의 최적 엘리베이터 동선, 연단간격 및 고장 우회 정보를 데이터 기반으로 분석합니다.</p>
          </div>
        )}

        {routeResult && (
          <div className="space-y-6">
            {/* Supplementary-line data disclaimer */}
            {routeResult.path?.some(n => n.supplementary) && (
              <div className="glass-card p-3 border-l-4 border-amber-500 bg-amber-50 text-xs text-amber-600 leading-relaxed animate-fade-in">
                ※ <strong>동해선·부산김해경전철</strong>은 부산교통공사 외 노선으로 혼잡도·편의시설 실데이터가 없어, 해당 구간은 <strong>거리 기반</strong>으로만 안내됩니다(혼잡도 0·시설 정보 미표시는 데이터 부재 때문입니다).
              </div>
            )}

            {/* 1. Conflict Score Card */}
            <div className="glass-card p-6">
              <div className="flex justify-between items-center flex-wrap gap-2">
                <h4 className="text-sm font-semibold text-[#6b7684] uppercase tracking-wider">이동 부하 & 자원 충돌 점수 (배리어프리 안전 모드)</h4>
                <div className="flex items-center gap-1.5">
                  {/* 점수 산정 엔진 배지 — LightGBM(nocarrier-core) 또는 휴리스틱 폴백 */}
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                    routeResult.conflict?.engine === 'lightgbm'
                      ? 'text-[#0E9E8E] bg-[#e6f7f5] border-[#8fd9d1]'
                      : 'text-[#6b7684] bg-[#f2f4f6] border-[#e8ebee]'
                  }`}>
                    {routeResult.conflict?.engine === 'lightgbm' ? '🧠 LightGBM 예측' : '📐 휴리스틱'}
                  </span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                    routeResult.congestion?.dayType === 'weekend'
                      ? 'text-[#f04452] bg-[#fdecee] border-[#f04452]/20'
                      : 'text-[#1b64da] bg-[#e8f3ff] border-[#b3d4ff]'
                  }`}>
                    {routeResult.congestion?.dayType === 'weekend' ? '🏖️ 주말' : '🏢 평일'} · {routeResult.congestion?.time} 기준
                  </span>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mt-4">
                <div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-extrabold text-[#191f28]">{routeResult.conflict.score}</span>
                    <span className="text-sm text-[#6b7684]">/ 100 점</span>
                  </div>
                  <span className={`inline-block mt-2 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                    routeResult.conflict.level.includes('SAFE') 
                      ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                      : routeResult.conflict.level.includes('WARNING')
                        ? 'bg-amber-50 text-amber-600 border border-amber-200'
                        : 'bg-rose-50 text-rose-600 border border-rose-200'
                  }`}>
                    {routeResult.conflict.level}
                  </span>
                </div>
                <div className="max-w-md text-sm text-[#4e5968] bg-[#f2f4f6] border border-[#e8ebee] rounded-xl p-3">
                  <strong>💡 안내:</strong> {routeResult.conflict.recommendation}
                  {routeResult.conflict.ml && (
                    <div className="mt-2 pt-2 border-t border-[#e8ebee] text-[11px] text-[#6b7684]">
                      🧠 LightGBM 혼잡 예측(nocarrier-core) 기반 · 경로 {routeResult.conflict.ml.coverage.scored}/{routeResult.conflict.ml.coverage.requested}개 역 스코어링
                      {routeResult.conflict.ml.worstStation && (
                        <> · 최대 병목 <strong className="text-[#f04452]">{routeResult.conflict.ml.worstStation.name}역</strong> (충돌 {routeResult.conflict.ml.worstStation.score}점)</>
                      )}
                      {routeResult.conflict.ml.stations?.some(s => s.eventSpike) && (
                        <> · ⚡ 이벤트 수요 급증 감지: {routeResult.conflict.ml.stations.filter(s => s.eventSpike).map(s => s.name).join(', ')}</>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Progress gauge */}
              <div className="w-full bg-[#f2f4f6] rounded-full h-2 mt-6 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    routeResult.conflict.score > 75
                      ? 'bg-gradient-to-r from-red-500 to-rose-600'
                      : routeResult.conflict.score > 40
                        ? 'bg-gradient-to-r from-amber-500 to-orange-500'
                        : 'bg-gradient-to-r from-emerald-400 to-indigo-500'
                  }`}
                  style={{ width: `${routeResult.conflict.score}%` }}
                ></div>
              </div>

              {/* 짐 소지 vs 빈손 비교 시뮬레이션 */}
              {routeResult.luggageImpact && (
                <div className="mt-5 border-t border-[#e8ebee] pt-4">
                  <div className="flex justify-between items-center mb-3">
                    <h5 className="text-xs font-bold text-[#191f28]">🧳 짐 들고 이동 vs 🙌 빈손 이동 (짐캐리 배송 시)</h5>
                    <span className="text-[10px] text-[#8b95a1]">동일 경로 · 짐 소지 가중치(환승·연단·혼잡 부담) 반영 시뮬레이션</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-rose-50 border border-rose-200 rounded-xl p-3">
                      <div className="text-[10px] text-rose-600 font-semibold">🧳 대형 수하물 소지</div>
                      <div className="text-2xl font-extrabold text-rose-600 mt-1">{routeResult.luggageImpact.withLuggage.conflictScore}<span className="text-xs font-normal text-[#8b95a1]"> /100</span></div>
                      <div className="text-[10px] text-[#8b95a1] mt-1">이동 부하 비용 {routeResult.luggageImpact.withLuggage.cost} · 환승 {routeResult.luggageImpact.withLuggage.transfers}회</div>
                    </div>
                    <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                      <div className="text-[10px] text-emerald-600 font-semibold">🙌 빈손 (짐캐리 숙소 배송)</div>
                      <div className="text-2xl font-extrabold text-emerald-600 mt-1">{routeResult.luggageImpact.handsFree.conflictScore}<span className="text-xs font-normal text-[#8b95a1]"> /100</span></div>
                      <div className="text-[10px] text-[#8b95a1] mt-1">이동 부하 비용 {routeResult.luggageImpact.handsFree.cost} · 환승 {routeResult.luggageImpact.handsFree.transfers}회</div>
                    </div>
                  </div>
                  {routeResult.luggageImpact.scoreDropPct > 0 && (
                    <div className="mt-2 text-xs text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5">
                      ✨ 짐을 짐캐리에 맡기면 이 경로의 이동 부하·자원 충돌 점수가 <strong>{routeResult.luggageImpact.scoreDropPct}% 감소</strong>합니다 — 엘리베이터를 원래 필요로 하는 교통약자에게 양보되는 효과입니다.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 2. Path & Elevators Card */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Path Flow */}
              <div className="glass-card p-6 flex flex-col justify-between">
                <h4 className="text-sm font-bold text-[#191f28] mb-4">🚇 이동 노선 및 역사 리스트</h4>
                {/* 연결선은 스크롤 '내부' 래퍼에 그려야 리스트 전체 높이를 따라간다
                    (스크롤 컨테이너에 그리면 보이는 높이만큼만 그려져 중간에 끊김) */}
                <div className="overflow-y-auto max-h-[350px] pr-1">
                <div className={`space-y-6 relative before:absolute ${showAllPath ? 'before:left-[13px]' : 'before:left-5'} before:top-3 before:bottom-0 before:w-0.5 before:bg-[#b3d4ff]`}>
                  {(showAllPath ? routeResult.path : getSummaryPath(routeResult.path)).map((node, index, displayPath) => {
                    const isDestination = node.displayType === 'end' || (showAllPath && index === routeResult.path.length - 1);
                    const isTransfer = (node.displayType === 'transfer' || node.edgeType === 'transfer') && !isDestination;
                    const isLast = index === displayPath.length - 1;
                    const displayIndex = showAllPath
                      ? index + 1
                      : (node.displayType === 'start' ? '출발' : (node.displayType === 'end' ? '도착' : '환승'));

                    return (
                      <div key={`path-node-${node.id}-${index}`} className="relative animate-fade-in">
                        {/* 마지막(도착) 배지 중심 아래로 선이 삐져나오지 않게 흰색으로 가림 */}
                        {isLast && (
                          <span aria-hidden="true" className={`absolute ${showAllPath ? 'left-[11.5px]' : 'left-[18.5px]'} top-3 bottom-0 w-[5px] bg-white z-[1]`} />
                        )}
                        {isTransfer && !showAllPath && (
                          <div className="my-2 ml-10 p-2 bg-amber-50 border border-amber-200 rounded-xl text-xxs text-amber-600 flex items-center gap-1.5">
                            <span>🔄</span>
                            <strong>호선 환승:</strong> {node.transferInfo ? node.transferInfo.replace('➔', ' ➔ ') : '호선 변경'}
                          </div>
                        )}
                        {isTransfer && showAllPath && (
                          <div className="my-2 ml-10 p-2 bg-amber-50 border border-amber-200 rounded-xl text-xxs text-amber-600 flex items-center gap-1.5">
                            <span>🔄</span>
                            <strong>호선 환승:</strong> {node.edgeLine ? node.edgeLine.replace('➔', ' ➔ ') : '호선 변경'}
                          </div>
                        )}
                        <div className="flex gap-4 items-start relative z-10">
                          <div
                            className={`h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white border border-surface shadow-md shrink-0 ${showAllPath ? 'w-6.5' : 'w-10'}`}
                            style={{ backgroundColor: getLineColor(node.line) }}
                          >
                            {displayIndex}
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-semibold text-[#191f28]">{displayStationName(node.name)}역</span>
                              {node.transferType === '환승역' && !isDestination && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#f2f4f6] border border-[#e8ebee] text-[#6b7684]">환승역</span>
                              )}
                            </div>
                            <div className="text-xs text-[#6b7684] mt-0.5 flex flex-col">
                              <span>{node.line}</span>
                              {showAllPath && node.address && <span className="text-[#8b95a1] text-[10px] mt-0.5">{node.address}</span>}
                            </div>
                            
                            {/* Platform gap warning */}
                            {node.gaps && node.gaps.some(g => g['연단간격'] && g['연단간격'].includes('넓음')) && (
                              <div className="mt-1 text-[10px] text-amber-600 flex items-center gap-1">
                                <span>⚠️ 발빠짐 주의 (연단간격 넓음)</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                </div>

                <button
                  type="button"
                  onClick={() => setShowAllPath(!showAllPath)}
                  className="w-full mt-4 bg-[#f2f4f6] hover:bg-[#e8ebee] border border-[#e8ebee] rounded-xl py-2 text-xxs text-[#6b7684] font-bold transition-all text-center cursor-pointer"
                >
                  {showAllPath ? '🔍 간결하게 요약 경로 보기' : `🔎 전체 경유지 펼쳐보기 (${routeResult.path.length}개역)`}
                </button>
                <div className="mt-6 border-t border-[#e8ebee] pt-4 text-xs text-[#6b7684] space-y-1">
                  <div className="flex justify-between">
                    <span>출발역 혼잡도: {routeResult.congestion.start.toLocaleString()}명</span>
                    <span>도착역 혼잡도: {routeResult.congestion.end.toLocaleString()}명</span>
                  </div>
                  <div className="flex justify-between text-[#8b95a1]">
                    <span>경로 평균 혼잡도: {routeResult.congestion.average.toLocaleString()}명</span>
                    <span>최대 병목 혼잡도: {routeResult.congestion.max.toLocaleString()}명</span>
                  </div>
                  {routeResult.fare && (
                    <div className="flex justify-between text-[#1b64da] font-semibold pt-1">
                      <span>💳 운임 (어른 · 교통카드 · {routeResult.fare.zone}구간):</span>
                      <span>{routeResult.fare.adult.toLocaleString()}원</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Broken Alert / Alternate Path & Platform Gaps */}
              <div className="glass-card p-6 border border-rose-200 flex flex-col justify-between h-fit space-y-6">
                <div>
                  <div className="flex items-center gap-2 mb-4">
                    <span className="text-xl">🚨</span>
                    <h4 className="text-sm font-bold text-[#191f28]">이동 장애 및 안전 우회로 <span className="text-[10px] text-[#8b95a1] font-normal">(고장 상황 시뮬레이션 · 대체경로는 공사 제공 실데이터)</span></h4>
                  </div>

                  {routeResult.brokenStations && routeResult.brokenStations.length > 0 ? (
                    <div className="space-y-4">
                      {routeResult.brokenStations.map((bs, bi) => (
                        <div key={`broken-st-${bs.id}-${bi}`} className="border-b border-[#e8ebee] pb-4 last:border-0 last:pb-0">
                          <div className="bg-rose-50 border border-rose-200 text-rose-600 rounded-xl p-3 text-xs leading-relaxed mb-3">
                            <strong>장애 발생 역사: {displayStationName(bs.name)}역 ({bs.line})</strong><br/>
                            해당 역사의 {bs.detour['엘리베이터 내부 관리번호'] || '1'}호기 엘리베이터(고유번호: {bs.detour['엘리베이터 고유번호'] || 'E-XXXX'})가 고장으로 운행 중지되었습니다.
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-[#6b7684] uppercase tracking-wider mb-2">교통약자 대체 이동 경로:</div>
                            <div className="bg-[#f2f4f6] border border-[#e8ebee] rounded-xl p-3 text-sm text-[#4e5968] font-mono leading-relaxed whitespace-pre-line">
                              {bs.detour['단계별 대체 경로']}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center text-[#8b95a1] py-6">
                      <span className="text-3xl mb-2 block">✓</span>
                      <p className="text-xs text-[#6b7684]">현재 경로 상 모든 엘리베이터가 정상 가동 중입니다.</p>
                    </div>
                  )}
                </div>

                {routeResult.gapStations && routeResult.gapStations.length > 0 && (
                  <div className="pt-4 border-t border-[#e8ebee]">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-lg">⚠️</span>
                      <h5 className="text-xs font-semibold text-amber-600 uppercase tracking-wider">승강장 안전 유의 역사 (연단간격)</h5>
                    </div>
                    <div className="space-y-2">
                      {routeResult.gapStations.map((gs, gi) => (
                        <div key={`gap-st-${gs.id}-${gi}`} className="bg-amber-50 border border-amber-200 text-amber-600 rounded-xl p-3 text-xs leading-relaxed">
                          <strong>{displayStationName(gs.name)}역 ({gs.line})</strong><br/>
                          승강장 연단 간격이 <strong>넓어</strong> 휠체어 바퀴 끼임이나 대형 수하물 이동 시 낙상 위험이 높습니다. 승하차 시 주의하십시오.
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 3. Terminal Amenities Info */}
            <div className="glass-card p-6">
              <h4 className="text-sm font-bold text-[#191f28] mb-4">🏢 출발 및 도착역 주요 편의시설 매핑</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {[
                  { node: routeResult.start, label: '출발역', color: 'text-[#1b64da]' },
                  { node: routeResult.end, label: '도착역', color: 'text-[#f04452]' }
                ].map(({ node, label, color }) => (
                  <div key={label}>
                    <h5 className={`text-xs font-semibold ${color} mb-3`}>
                      [{label}] {displayStationName(node.name)}역 정보
                      {node.nameEn && <span className="text-[#8b95a1] font-normal ml-1.5">({node.nameEn})</span>}
                    </h5>
                    <ul className="text-xs space-y-2.5 text-[#4e5968]">
                      <li>🔹 <strong>도로명 주소:</strong> {node.address || '정보 없음'}</li>
                      <li>🔹 <strong>전화번호:</strong> {node.tel || '정보 없음'}</li>
                      <li>🔹 <strong>엘리베이터:</strong> {node.elevators?.length || 0}개 운행 중</li>
                      <li>🔹 <strong>에스컬레이터:</strong> {node.escalators?.length || 0}개 운행 중</li>
                      <li>🔹 <strong>짐보관함(락커):</strong> {node.lockers?.length > 0 ? `${node.lockers.length}개소 설치됨` : '없음 (역무실 문의)'}</li>
                      <li>🔹 <strong>휴대폰 충전기:</strong> {node.chargers?.length > 0 ? `${node.chargers.length}개소 설치됨` : '없음'}</li>
                      <li>🔹 <strong>교통약자 키오스크:</strong> {node.kiosks?.length > 0 ? '설치 완료 (음성/점자/시각 지원)' : '미설치'}</li>
                      {node.amenityFlags && (
                        <li>🔹 <strong>부대시설:</strong>{' '}
                          {[
                            node.amenityFlags.transferParking && '환승주차장',
                            node.amenityFlags.bikeStorage && '자전거보관소',
                            node.amenityFlags.photoBooth && '자동사진기',
                            node.amenityFlags.police && '도시철도경찰대'
                          ].filter(Boolean).join(' · ') || '없음'}
                        </li>
                      )}
                    </ul>
                    {node.nameOrigin && (
                      <details className="mt-3 bg-[#f2f4f6] border border-[#e8ebee] rounded-xl p-3 text-xxs text-[#6b7684] leading-relaxed">
                        <summary className="cursor-pointer text-[#4e5968] font-semibold">📜 역명 유래 (관광 스토리텔링)</summary>
                        <p className="mt-2 line-clamp-6">{node.nameOrigin}</p>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}
      </div>

      {/* Subway Map SVG Modal — 재사용 컴포넌트 (출발/도착 지정) */}
      {showMapModal && (
        <StationMapModal
          stations={stations}
          onClose={() => setShowMapModal(false)}
          hint={<>🔍 휠·＋／－ 확대, 드래그 이동 · 역 클릭 → 출발/도착 지정 · <span className="text-[#1b64da] font-bold">●</span> 출발 <span className="text-[#f04452] font-bold">●</span> 도착</>}
          resolveHighlight={(s) => {
            if (s.allIds.includes(startStation)) return 'w-7 h-7 bg-[#3182f6]/90 border-[#b3d4ff] shadow-[0_0_0_5px_rgba(49,130,246,0.35)]'
            if (s.allIds.includes(endStation)) return 'w-7 h-7 bg-[#f04452]/90 border-[#fdecee] shadow-[0_0_0_5px_rgba(240,68,82,0.35)]'
            return null
          }}
          actions={[
            { label: '출발', base: 'bg-[#3182f6] hover:bg-[#1b64da]', onSelect: (s) => { setStartStation(s.id); setStartLine(s.line) } },
            { label: '도착', base: 'bg-[#f04452] hover:bg-[#d13b48]', onSelect: (s) => { setEndStation(s.id); setEndLine(s.line) } },
          ]}
        />
      )}
    </div>
  )
}
