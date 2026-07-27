import fitz  # PyMuPDF
import os
import sys
import glob

# Force UTF-8 output
sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = r"C:\Users\USER\Desktop\DIVE_2026"
OUTPUT_FILE = os.path.join(BASE_DIR, "code", "extracted_text.txt")

# Get all PDFs from disk using glob (avoids encoding issues)
all_pdfs = sorted(glob.glob(os.path.join(BASE_DIR, "*.pdf")))

print(f"Found {len(all_pdfs)} PDF files:")
for p in all_pdfs:
    print(f"  - {os.path.basename(p)}")
print()

with open(OUTPUT_FILE, "w", encoding="utf-8") as out:
    for filepath in all_pdfs:
        filename = os.path.basename(filepath)
        separator = "=" * 80
        header = f"{separator}\nFILE: {filename}\n{separator}\n"
        out.write(header)
        print(header, end="")
        
        try:
            doc = fitz.open(filepath)
            total_pages = len(doc)
            info = f"(Total pages: {total_pages})\n\n"
            out.write(info)
            print(info, end="")
            
            for page_num in range(total_pages):
                page = doc[page_num]
                text = page.get_text()
                page_header = f"--- Page {page_num + 1} ---\n"
                out.write(page_header)
                print(page_header, end="")
                
                if text.strip():
                    out.write(text + "\n")
                    print(text)
                else:
                    msg = "[No extractable text on this page - likely image-based]\n"
                    out.write(msg)
                    print(msg)
            
            doc.close()
        except Exception as e:
            err = f"ERROR reading {filename}: {e}\n"
            out.write(err)
            print(err)
        
        out.write("\n\n")
        print()

print(f"\n{'=' * 80}")
print(f"All extracted text saved to: {OUTPUT_FILE}")
print(f"{'=' * 80}")
