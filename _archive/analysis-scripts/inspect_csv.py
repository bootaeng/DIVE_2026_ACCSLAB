import pandas as pd

p = r"C:\Users\USER\Desktop\DIVE_2026\참가자_제공_데이터\3. 역사별 이동 편의시설 정보 데이터셋\3. 엘리베이터 고장 시 대체 이동 경로.csv"
df = pd.read_csv(p, encoding='cp949')

no_detour = df[df['경로 이용 가능 여부'] == 'N']
print(no_detour[['역번호', '역명', '호선명', '엘리베이터 내부 관리번호', '경로 이용 가능 여부']])
