export default function LoadingSpinner() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] gap-6">
      {/* Animated rings */}
      <div className="relative w-20 h-20">
        <div className="absolute inset-0 rounded-full border-2 border-indigo-500/20 animate-ping" />
        <div className="absolute inset-2 rounded-full border-2 border-t-indigo-400 border-r-transparent border-b-transparent border-l-transparent animate-spin" />
        <div className="absolute inset-4 rounded-full border-2 border-t-transparent border-r-pink-400 border-b-transparent border-l-transparent animate-spin" style={{ animationDirection: 'reverse', animationDuration: '0.8s' }} />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-2xl">📊</span>
        </div>
      </div>

      <div className="text-center">
        <p className="text-lg font-medium text-gray-300 animate-pulse-glow">
          데이터를 불러오는 중...
        </p>
        <p className="text-sm text-gray-500 mt-2">
          CSV 파일을 분석하고 시각화를 준비합니다
        </p>
      </div>
    </div>
  )
}
