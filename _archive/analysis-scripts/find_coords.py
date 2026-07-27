import os
import json

found = []
for root, dirs, files in os.walk(r"C:\Users\USER\Desktop\DIVE_2026\code"):
    for file in files:
        if file.endswith(('.js', '.jsx', '.json')):
            path = os.path.join(root, file)
            try:
                with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read()
                    if 'x:' in content or 'cx' in content or 'cy' in content or 'coordinate' in content:
                        found.append(path)
            except Exception as e:
                pass

print("Files containing coordinate keys:", found)
