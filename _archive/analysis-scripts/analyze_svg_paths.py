import xml.etree.ElementTree as ET
import re

tree = ET.parse(r"C:\Users\USER\Desktop\DIVE_2026\code\frontend-react\public\busan_subway_map.svg")
root = tree.getroot()

# Find all path tags
paths = []
def find_paths(node):
    if node.tag.endswith('path'):
        d = node.get('d')
        if d:
            paths.append((node, d))
    for child in node:
        find_paths(child)

find_paths(root)
print("Total path elements:", len(paths))

# Let's inspect path data that might represent circles.
# A circle drawn as a path often starts with M followed by C/A/Q or has a specific length.
# Let's see some path data examples:
for i, (node, d) in enumerate(paths[:30]):
    print(f"Path {i}: {d[:100]}...")
