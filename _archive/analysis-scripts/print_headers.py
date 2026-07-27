import os
import pandas as pd
import glob
import sys

data_dir = r"C:\Users\USER\Desktop\DIVE_2026\참가자_제공_데이터"
output_file = r"C:\Users\USER\Desktop\DIVE_2026\code\data_inspection.txt"

def load_df(path, nrows=None):
    for enc in ["utf-8-sig", "utf-8", "cp949", "euc-kr"]:
        try:
            return pd.read_csv(path, encoding=enc, nrows=nrows)
        except Exception as e:
            continue
    raise Exception(f"Could not load {path} with any encoding")

with open(output_file, "w", encoding="utf-8") as out:
    out.write("--- DATA INSPECTION REPORT ---\n\n")

    # 1. 역사 정보.csv
    path_station = os.path.join(data_dir, "1. 역사 정보.csv")
    if os.path.exists(path_station):
        df = load_df(path_station)
        out.write(f"[1. 역사 정보.csv] columns: {list(df.columns)}\n")
        out.write(df.head(2).to_string() + "\n\n")

    # 2. 시간대별 승하차 인원
    path_ridership = os.path.join(data_dir, "2. 시간대별 승하차 인원(2025년).csv")
    if os.path.exists(path_ridership):
        df = load_df(path_ridership, nrows=5)
        out.write(f"[2. 시간대별 승하차 인원] columns: {list(df.columns)}\n")
        out.write(df.head(2).to_string() + "\n\n")

    # 3. 역사별 이동 편의시설 정보 데이터셋
    dir_3 = os.path.join(data_dir, "3. 역사별 이동 편의시설 정보 데이터셋")
    out.write("--- 3. 역사별 이동 편의시설 정보 데이터셋 ---\n")
    for f in glob.glob(os.path.join(dir_3, "*.csv")):
        try:
            df = load_df(f, nrows=5)
            out.write(f"\nFile: {os.path.basename(f)}\nColumns: {list(df.columns)}\n")
            out.write(df.head(1).to_string() + "\n")
        except Exception as e:
            out.write(f"Error reading {f}: {e}\n")
    out.write("\n")

    # 4. 역사별 편의시설 정보 데이터셋
    dir_4 = os.path.join(data_dir, "4. 역사별 편의시설 정보 데이터셋")
    out.write("--- 4. 역사별 편의시설 정보 데이터셋 ---\n")
    for f in glob.glob(os.path.join(dir_4, "*.csv")):
        try:
            df = load_df(f, nrows=5)
            out.write(f"\nFile: {os.path.basename(f)}\nColumns: {list(df.columns)}\n")
            out.write(df.head(1).to_string() + "\n")
        except Exception as e:
            out.write(f"Error reading {f}: {e}\n")
    out.write("\n")

    # 5. 주요거점 · 권역별 짐배송 이동 흐름 정보.xlsx
    path_xlsx = os.path.join(data_dir, "5. 주요거점 · 권역별 짐배송 이동 흐름 정보.xlsx")
    if os.path.exists(path_xlsx):
        try:
            xl = pd.ExcelFile(path_xlsx)
            out.write(f"[5. 주요거점 · 권역별 짐배송 이동 흐름 정보.xlsx] sheets: {xl.sheet_names}\n")
            for sheet in xl.sheet_names:
                df = xl.parse(sheet, nrows=5)
                out.write(f"Sheet: {sheet} columns: {list(df.columns)}\n")
                out.write(df.head(2).to_string() + "\n\n")
        except Exception as e:
            out.write(f"Error reading xlsx: {e}\n")

print(f"Data inspection report saved to {output_file}")
